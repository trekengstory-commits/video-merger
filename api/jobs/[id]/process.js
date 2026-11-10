'use strict';
/**
 * POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن).
 * 0–40 تجهيز المصادر (تنزيل الروابط / تجميع الملفات المرفوعة)
 * 40–90 ترميز ffmpeg — 95 تخزين الناتج — 100 اكتمال.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { applyCors, sendJson, sendError, getBaseUrl, HttpError } = require('../../../lib/util');
const { ensureSchema, getJob, getSources, updateJob, cleanupExpired } = require('../../../lib/db');
const { deleteSourceChunks, deleteOutputChunks, putOutputChunksStream, blobBytes } = require('../../../lib/storage');
const { SOURCE_MAX_MB, OUTPUT_MAX_MB, MAX_TOTAL_DURATION_SEC, FFMPEG_PRESET, MB } = require('../../../lib/limits');
const { resolveFfprobePath, probeFile, downloadToFile, buildFilterGraph, encode } = require('../../../lib/merge');

const extFromUrl = (url, mime) => {
  const m = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(url || ''));
  if (m) return '.' + m[1].toLowerCase();
  if (mime && mime.includes('webm')) return '.webm';
  return '.mp4';
};

/** كابح تقدم — يحدّث القاعدة بحد أدنى كل ms لتجنّب إغراق Turso */
function progressThrottle(id, ms = 1500) {
  let last = 0;
  let lastVal = -1;
  const fn = async (p) => {
    const v = Math.max(0, Math.min(99, Math.round(p)));
    if (v === lastVal) return;
    const t = Date.now();
    if (t - last < ms) return;
    last = t;
    lastVal = v;
    await updateJob(id, { progress: v }).catch(() => {});
  };
  fn.now = async (p) => {
    const v = Math.max(0, Math.min(99, Math.round(p)));
    lastVal = v;
    last = Date.now();
    await updateJob(id, { progress: v }).catch(() => {});
  };
  return fn;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return sendError(res, 405, 'طريقة غير مدعومة — استخدم POST لتنفيذ الدمج');
  }
  const id = req.query && req.query.id;
  if (!id) return sendError(res, 400, 'معرّف المهمة مفقود');

  const base = getBaseUrl(req);
  try {
    await ensureSchema();
    await cleanupExpired().catch(() => {});

    const job = await getJob(id);
    if (!job) return sendError(res, 404, 'لا توجد مهمة بهذا المعرّف');

    // مكتملة مسبقًا → أعد النتيجة مباشرة (سلوك دوري آمن)
    if (job.status === 'done' && job.result_json) {
      const r = JSON.parse(job.result_json);
      return sendJson(res, 200, {
        status: 'done',
        videoUrl: `${base}/api/jobs/${id}/video`,
        downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
        size: r.size,
        duration: r.duration,
        resolution: r.resolution,
        expiresAt: job.expires_at,
      });
    }
    // قيد المعالجة فعلًا (نداء متزامن آخر شغّال) → 202
    if (job.status === 'processing') {
      return sendJson(res, 202, {
        status: 'processing',
        progress: Number(job.progress || 0),
        statusUrl: `${base}/api/jobs/${id}`,
        message: 'المهمة قيد المعالجة بالفعل — تابع الحالة عبر statusUrl',
      });
    }
    // حالة رفع: تحقق من اكتمال كل ملفات المصدر
    const sources = await getSources(id);
    for (const s of sources) {
      if (s.kind === 'file' && s.receivedBytes !== s.size) {
        throw new HttpError(
          409,
          `الملف «${s.name}» لم يكتمل رفعه (${s.receivedBytes} من ${s.size} بايت) — أكمل الرفع أولًا`
        );
      }
    }

    await updateJob(id, { status: 'processing', progress: 1, error: null });

    const tmpFiles = [];
    const outPath = path.join(os.tmpdir(), `vm-${id}-out.mp4`);
    const probeBin = resolveFfprobePath();
    const bump = progressThrottle(id);
    let resultPayload = null;

    try {
      /* ── 1) تجهيز المصادر محليًا (0–40) ── */
      const perSource = 39 / Math.max(1, sources.length);
      for (let i = 0; i < sources.length; i++) {
        const s = sources[i];
        const dest = path.join(
          os.tmpdir(),
          `vm-${id}-src-${i}${s.kind === 'url' ? extFromUrl(s.url, s.mime) : path.extname(s.name || '') || '.mp4'}`
        );
        tmpFiles.push(dest);

        if (s.kind === 'url') {
          const baseP = 1 + i * perSource;
          await downloadToFile(s.url, dest, SOURCE_MAX_MB * MB, {
            onBytes: (total, declared) => {
              const frac = declared ? Math.min(1, total / declared) : 0.5;
              bump(baseP + frac * perSource);
            },
          });
        } else {
          // تجميع المصدر من صفوف source_chunks إلى /tmp (كتابة تدفقية)
          const src = Readable.from(blobBytes({ table: 'source_chunks', jobId: id, seq: s.seq }));
          await pipeline(src, fs.createWriteStream(dest));
        }
        await bump(1 + (i + 1) * perSource);
      }

      /* ── 2) فحص كل مصدر بـ ffprobe + التحقق من الحدود ── */
      const infos = [];
      for (const f of tmpFiles) infos.push(await probeFile(probeBin, f));
      const totalDuration = infos.reduce((acc, inf) => acc + inf.duration, 0);
      if (!(totalDuration > 0)) throw new HttpError(400, 'تعذّر تحديد مدة المصادر — ملفات غير صالحة');
      if (totalDuration > MAX_TOTAL_DURATION_SEC) {
        throw new HttpError(
          400,
          `المدة الإجمالية ${Math.round(totalDuration)} ثانية تتجاوز الحد ${MAX_TOTAL_DURATION_SEC} ثانية`
        );
      }

      /* ── 3) الترميز (40–90) ── */
      await updateJob(id, { progress: 40 });
      const { W, H } = buildFilterGraph(infos);
      await encode({
        infos,
        inputPaths: tmpFiles,
        outPath,
        preset: FFMPEG_PRESET,
        totalDuration,
        onProgress: (ratio) => bump(40 + ratio * 50),
      });

      /* ── 4) فحص حجم الناتج ── */
      const size = (await fs.promises.stat(outPath)).size;
      if (size > OUTPUT_MAX_MB * MB) {
        throw new HttpError(400, `حجم الناتج ${(size / MB).toFixed(1)}MB يتجاوز الحد ${OUTPUT_MAX_MB}MB`);
      }

      /* ── 5) تخزين الناتج في Turso (95) ثم إنهاء (100) ── */
      await updateJob(id, { progress: 95 });
      await deleteOutputChunks(id); // تنظيف بقايا محاولة فاشلة سابقة
      await putOutputChunksStream(id, fs.createReadStream(outPath, { highWaterMark: 1024 * 1024 }));
      await deleteSourceChunks(id); // الناتج فقط هو المطلوب بعد نجاح الدمج

      const result = {
        size,
        duration: Math.round(totalDuration * 100) / 100,
        resolution: `${W}x${H}`,
      };
      await updateJob(id, { status: 'done', progress: 100, result_json: JSON.stringify(result), error: null });

      resultPayload = {
        status: 'done',
        videoUrl: `${base}/api/jobs/${id}/video`,
        downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
        ...result,
        expiresAt: job.expires_at,
      };
      return sendJson(res, 200, resultPayload);
    } catch (e) {
      // فشل واضح برسالة — وليس انهيارًا. نظّف ناتجًا جزئيًا واحفظ السبب.
      await deleteOutputChunks(id).catch(() => {});
      await updateJob(id, { status: 'failed', error: e.message }).catch(() => {});
      const code = e.statusCode || (e.isLimit ? 400 : 500);
      return sendError(res, code, e.message);
    } finally {
      // نظّف /tmp دائمًا
      for (const f of [...tmpFiles, outPath]) {
        await fs.promises.rm(f, { force: true }).catch(() => {});
      }
    }
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
};
