'use strict';
/**
 * GET /api/jobs/<id>/video — بث الناتج من صفوف Blobs مع دعم Range (206).
 * تحويل صفوف 2MB إلى stream مع تقليم أول/آخر جزء حسب المدى المطلوب.
 */
const { applyCors, sendError } = require('../../../lib/util');
const { ensureSchema, getJob } = require('../../../lib/db');
const { blobToStream } = require('../../../lib/storage');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    return sendError(res, 405, 'طريقة غير مدعومة — استخدم GET لعرض الفيديو');
  }
  const id = req.query && req.query.id;
  if (!id) return sendError(res, 400, 'معرّف المهمة مفقود');

  try {
    await ensureSchema();
    const job = await getJob(id);
    if (!job) return sendError(res, 404, 'لا توجد مهمة بهذا المعرّف');
    if (job.status !== 'done' || !job.result_json) {
      return sendError(res, 409, `الفيديو غير جاهز — الحالة الحالية: «${job.status}»`);
    }
    const r = JSON.parse(job.result_json);
    const total = Number(r.size || 0);
    if (!(total > 0)) return sendError(res, 404, 'لا يوجد فيديو مخزّن لهذه المهمة');

    /* تحليل ترويسة Range */
    let start = 0;
    let end = total - 1;
    let partial = false;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
      if (!m || (m[1] === '' && m[2] === '')) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      if (m[1] === '') {
        // آخر N بايت
        const n = Math.min(parseInt(m[2], 10), total);
        start = total - n;
        end = total - 1;
      } else {
        start = parseInt(m[1], 10);
        end = m[2] !== '' ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
      }
      if (start >= total || start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.end();
      }
      partial = true;
    }

    const len = end - start + 1;
    res.statusCode = partial ? 206 : 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(len));
    res.setHeader('Cache-Control', 'no-store');
    if (partial) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    if (req.query && req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="merged-${id}.mp4"`);
    }

    const stream = blobToStream({ table: 'output_chunks', jobId: id, start, end });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (e) {
    if (!res.headersSent) sendError(res, e.statusCode || 500, e.message);
    else res.destroy();
  }
};
