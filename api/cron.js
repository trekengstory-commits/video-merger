'use strict';
/** GET /api/cron — حذف المهام المنتهية (مجدولة يوميًا في vercel.json) */
const { applyCors, sendJson, sendError } = require('../lib/util');
const { cleanupExpired } = require('../lib/db');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة غير مدعومة — استخدم GET');
  try {
    const deleted = await cleanupExpired();
    return sendJson(res, 200, { ok: true, deleted, at: new Date().toISOString() });
  } catch (e) {
    return sendError(res, 500, e.message);
  }
};
