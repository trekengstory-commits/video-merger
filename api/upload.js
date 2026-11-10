'use strict';
/**
 * POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية ≤4MB.
 * Content-Type: application/octet-stream — تُخزَّن كصفوف 2MB في Turso.
 */
const { applyCors, sendJson, sendError, readRawBody } = require('../lib/util');
const { ensureSchema, getJob, getSource, updateSourceReceived } = require('../lib/db');
const { putSourceChunk, sourceStoredBytes } = require('../lib/storage');
const { UPLOAD_CHUNK_BYTES, CHUNK_BYTES, SOURCE_MAX_MB, MB } = require('../lib/limits');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    return sendError(res, 405, 'طريقة غير مدعومة — استخدم POST بأجزاء ثنائية');
  }
  const q = req.query || {};
  const jobId = q.job;
  const seq = parseInt(q.seq, 10);
  const chunk = parseInt(q.chunk, 10);

  try {
    if (!jobId || !Number.isFinite(seq) || !Number.isFinite(chunk)) {
      return sendError(res, 400, 'معاملات ناقصة — يتطلب job و seq و chunk');
    }
    if (chunk < 0 || seq < 0) return sendError(res, 400, 'seq و chunk يجب أن يكونا رقمين موجبين');
    await ensureSchema();

    const job = await getJob(jobId);
    if (!job) return sendError(res, 404, 'لا توجد مهمة بهذا المعرّف');
    if (job.status !== 'uploading' && job.status !== 'queued') {
      return sendError(res, 409, `لا يمكن الرفع في الحالة «${job.status}» — المهمة لم تعد في مرحلة الرفع`);
    }
    const source = await getSource(jobId, seq);
    if (!source) return sendError(res, 404, 'لا يوجد مصدر بهذا الرقم في المهمة');
    if (source.kind !== 'file') return sendError(res, 400, 'هذا المصدر رابط وليس ملفًا — لا رفع مطلوب');

    const size = Number(source.size);
    const expectedChunks = Math.ceil(size / UPLOAD_CHUNK_BYTES);
    if (chunk >= expectedChunks) {
      return sendError(res, 400, `رقم الجزء ${chunk} خارج النطاق — الملف يحتاج ${expectedChunks} أجزاء`);
    }

    const body = await readRawBody(req, UPLOAD_CHUNK_BYTES).catch((e) => {
      e.statusCode = e.statusCode || 413;
      throw e;
    });
    if (!body.length) return sendError(res, 400, 'جسم الطلب فارغ — أرسل بايتات الملف خامًا');
    if (body.length > UPLOAD_CHUNK_BYTES) {
      return sendError(res, 413, `الجزء يتجاوز الحد ${Math.round(UPLOAD_CHUNK_BYTES / MB)}MB`);
    }

    const offset = chunk * UPLOAD_CHUNK_BYTES;
    if (offset + body.length > size) {
      return sendError(res, 400, 'الجزء يتجاوز الحجم المعلن للمصدر — راجع size المرسل عند الإنشاء');
    }
    if (body.length > SOURCE_MAX_MB * MB) {
      return sendError(res, 413, `الملف يتجاوز الحد ${SOURCE_MAX_MB}MB`);
    }

    await putSourceChunk(jobId, seq, chunk, body);
    const received = await sourceStoredBytes(jobId, seq);
    await updateSourceReceived(jobId, seq, received);

    return sendJson(res, 200, {
      ok: true,
      job: jobId,
      seq,
      chunk,
      receivedBytes: received,
      size,
      complete: received >= size,
    });
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
};
