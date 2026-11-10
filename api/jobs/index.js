'use strict';
/** POST /api/jobs — إنشاء مهمة دمج | GET /api/jobs — قائمة المهام الحديثة */
const {
  applyCors,
  sendJson,
  sendError,
  readJsonBody,
  getBaseUrl,
  newId,
  HttpError,
} = require('../../lib/util');
const { ensureSchema, createJob, listJobs, cleanupExpired } = require('../../lib/db');
const { MAX_SOURCES, SOURCE_MAX_MB, UPLOAD_CHUNK_BYTES, EXPIRES_HOURS, MB } = require('../../lib/limits');

function normalizeSources(body) {
  if (Array.isArray(body.videos)) {
    return body.videos.map((u) => ({ kind: 'url', url: String(u ?? '').trim() }));
  }
  if (Array.isArray(body.sources)) {
    return body.sources.map((s) => ({
      kind: s && s.kind === 'file' ? 'file' : 'url',
      url: s && s.url ? String(s.url).trim() : undefined,
      name: s && s.name ? String(s.name) : undefined,
      size: s && s.size !== undefined ? Number(s.size) : undefined,
      mime: s && s.mime ? String(s.mime) : undefined,
    }));
  }
  return null;
}

function validateSources(sources) {
  if (!sources.length) throw new HttpError(400, 'أضف مصدرًا واحدًا على الأقل');
  if (sources.length > MAX_SOURCES) throw new HttpError(400, `الحد الأقصى ${MAX_SOURCES} مصادر في المهمة الواحدة`);
  for (const s of sources) {
    if (s.kind === 'url') {
      if (!s.url || !/^https?:\/\//i.test(s.url)) {
        throw new HttpError(400, `رابط غير صالح: «${s.url || ''}» — يجب أن يبدأ بـ http:// أو https://`);
      }
    } else {
      if (!s.name) throw new HttpError(400, 'مصدر الملف يتطلب حقل name');
      if (!Number.isFinite(s.size) || s.size <= 0) {
        throw new HttpError(400, `الملف «${s.name}» بلا حجم صالح`);
      }
      if (s.size > SOURCE_MAX_MB * MB) {
        throw new HttpError(413, `الملف «${s.name}» حجمه ${(s.size / MB).toFixed(1)}MB ويتجاوز الحد ${SOURCE_MAX_MB}MB`);
      }
    }
  }
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  try {
    await ensureSchema();

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return sendError(res, 400, 'أرسل جسم JSON يحتوي «videos» أو «sources»');
      }
      const sources = normalizeSources(body);
      if (!sources) return sendError(res, 400, 'الجسم يجب أن يحتوي مصفوفة videos أو sources');
      validateSources(sources);

      const hasFiles = sources.some((s) => s.kind === 'file');
      const id = newId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EXPIRES_HOURS * 3600 * 1000);
      await createJob({ id, status: hasFiles ? 'uploading' : 'queued', sources, expiresAt });

      const base = getBaseUrl(req);
      const payload = {
        jobId: id,
        status: hasFiles ? 'uploading' : 'queued',
        statusUrl: `${base}/api/jobs/${id}`,
        processUrl: `${base}/api/jobs/${id}/process`,
        expiresAt: expiresAt.toISOString(),
      };
      if (hasFiles) {
        payload.uploadChunkBytes = UPLOAD_CHUNK_BYTES;
        payload.uploads = sources
          .map((s, i) =>
            s.kind === 'file'
              ? { seq: i, name: s.name, size: s.size, uploadUrl: `${base}/api/upload?job=${id}&seq=${i}`, receivedBytes: 0 }
              : null
          )
          .filter(Boolean);
      }
      // تنظيف كسول للمهام المنتهية
      await cleanupExpired().catch(() => {});
      return sendJson(res, 201, payload);
    }

    if (req.method === 'GET') {
      const limit = Math.min(100, Math.max(1, parseInt(req.query && req.query.limit, 10) || 50));
      const jobs = await listJobs(limit);
      return sendJson(res, 200, { jobs });
    }

    return sendError(res, 405, 'طريقة غير مدعومة — استخدم POST لإنشاء مهمة أو GET لعرض القائمة');
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
};
