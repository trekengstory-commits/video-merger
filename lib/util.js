'use strict';
/** أدوات مشتركة: CORS، استجابات JSON، قراءة الجسم، أخطاء HTTP */

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: String(message) });
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** يقرأ جسم الطلب الخام حتى maxBytes — يتجاوزه يرمي 413 */
function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
      req.resume(); // تصريف الباقي دون قطع الاتصال — لنستطيع إرسال رد 413
    };
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        fail(new HttpError(413, `حجم الطلب يتجاوز الحد المسموح (${Math.round(maxBytes / 1048576)}MB)`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

/** يقرأ جسم JSON — تالف يرمي 400، فارغ يعيد null */
async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw.length) return null;
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON تالف — أرسل جسمًا بصيغة JSON صحيحة');
  }
}

/** العنوان الأساسي من ترويسات الطلب (يعمل على Vercel ومحليًا) */
function getBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000').split(',')[0].trim();
  return `${proto}://${host}`;
}

function newId() {
  return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

module.exports = {
  applyCors,
  sendJson,
  sendError,
  HttpError,
  readRawBody,
  readJsonBody,
  getBaseUrl,
  newId,
  formatBytes,
};
