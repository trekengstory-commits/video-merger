'use strict';
/** GET /api/jobs/<id> — الحالة والتقدم | DELETE /api/jobs/<id> — حذف شامل فوري */
const { applyCors, sendJson, sendError, getBaseUrl } = require('../../lib/util');
const { ensureSchema, getJob, getSources, deleteJobAll } = require('../../lib/db');

function remainingSeconds(expiresAt) {
  return Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  const id = req.query && req.query.id;
  if (!id) return sendError(res, 400, 'معرّف المهمة مفقود');

  try {
    await ensureSchema();
    const job = await getJob(id);
    if (!job) return sendError(res, 404, 'لا توجد مهمة بهذا المعرّف');

    if (req.method === 'GET') {
      const sources = await getSources(id);
      const payload = {
        jobId: job.id,
        status: job.status,
        progress: Number(job.progress || 0),
        error: job.error || null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        expiresAt: job.expires_at,
        remainingSeconds: remainingSeconds(job.expires_at),
        sources,
      };
      if (job.status === 'done' && job.result_json) {
        const base = getBaseUrl(req);
        const r = JSON.parse(job.result_json);
        payload.result = {
          videoUrl: `${base}/api/jobs/${id}/video`,
          downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
          size: r.size,
          duration: r.duration,
          resolution: r.resolution,
        };
      }
      return sendJson(res, 200, payload);
    }

    if (req.method === 'DELETE') {
      await deleteJobAll(id);
      return sendJson(res, 200, { deleted: true, jobId: id });
    }

    return sendError(res, 405, 'طريقة غير مدعومة — استخدم GET للحالة أو DELETE للحذف');
  } catch (e) {
    return sendError(res, e.statusCode || 500, e.message);
  }
};
