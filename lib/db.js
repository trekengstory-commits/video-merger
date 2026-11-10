'use strict';
/**
 * طبقة قاعدة البيانات — Turso (libSQL)
 * الجداول: jobs, sources, source_chunks, output_chunks
 * كل شيء داخل القاعدة (Blobs مقسمة 2MB) — لا ملفات دائمة ولا خدمات خارجية.
 */
require('./env');
const { createClient } = require('@libsql/client');
const { EXPIRES_HOURS } = require('./limits');

let client = null;

function db() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error(
        'متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان — أضفهما في ملف .env محليًا أو في Vercel → Settings → Environment Variables'
      );
    }
    client = createClient({ url, authToken: token });
  }
  return client;
}

let schemaPromise = null;

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = db()
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            progress INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            expected_files INTEGER NOT NULL DEFAULT 0,
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS sources (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            kind TEXT NOT NULL,
            url TEXT,
            name TEXT,
            size INTEGER,
            mime TEXT,
            received_bytes INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_id, seq)
          )`,
          `CREATE TABLE IF NOT EXISTS source_chunks (
            job_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, seq, chunk)
          )`,
          `CREATE TABLE IF NOT EXISTS output_chunks (
            job_id TEXT NOT NULL,
            chunk INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (job_id, chunk)
          )`,
          `CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at)`,
        ],
        'write'
      )
      .catch((e) => {
        schemaPromise = null;
        throw e;
      });
  }
  return schemaPromise;
}

/* ───────────── المهام ───────────── */

function nowIso() {
  return new Date().toISOString();
}

async function createJob({ id, status, sources, expiresAt }) {
  await ensureSchema();
  const t = nowIso();
  const files = sources.filter((s) => s.kind === 'file').length;
  await db().batch(
    [
      {
        sql: 'INSERT INTO jobs (id, status, progress, expected_files, created_at, updated_at, expires_at) VALUES (?, ?, 0, ?, ?, ?, ?)',
        args: [id, status, files, t, t, expiresAt.toISOString()],
      },
      ...sources.map((s, i) => ({
        sql: 'INSERT INTO sources (job_id, seq, kind, url, name, size, mime) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [id, i, s.kind, s.url || null, s.name || null, s.size ?? null, s.mime || null],
      })),
    ],
    'write'
  );
}

async function getJob(id) {
  await ensureSchema();
  const res = await db().execute({ sql: 'SELECT * FROM jobs WHERE id = ?', args: [id] });
  return res.rows[0] || null;
}

const JOB_FIELDS = {
  status: 'status',
  progress: 'progress',
  error: 'error',
  result_json: 'result_json',
};

async function updateJob(id, patch) {
  const sets = [];
  const args = [];
  for (const [k, col] of Object.entries(JOB_FIELDS)) {
    if (k in patch) {
      sets.push(`${col} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at = ?');
  args.push(nowIso(), id);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args });
}

async function listJobs(limit = 50) {
  await ensureSchema();
  const res = await db().execute({
    sql: 'SELECT id, status, progress, created_at, expires_at, result_json FROM jobs ORDER BY created_at DESC LIMIT ?',
    args: [limit],
  });
  return res.rows.map((r) => ({
    jobId: r.id,
    status: r.status,
    progress: r.progress,
    hasResult: Boolean(r.result_json),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));
}

/** حذف شامل لكل صفوف المهمة في batch واحد */
async function deleteJobAll(id) {
  await ensureSchema();
  await db().batch(
    [
      { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM sources WHERE job_id = ?', args: [id] },
      { sql: 'DELETE FROM jobs WHERE id = ?', args: [id] },
    ],
    'write'
  );
}

async function jobExists(id) {
  const j = await getJob(id);
  return Boolean(j);
}

/** التنظيف الكسول — حذف المهام المنتهية (تُستدعى عند كل إنشاء/دمج وفي /api/cron) */
async function cleanupExpired() {
  await ensureSchema();
  const res = await db().execute({
    sql: 'SELECT id FROM jobs WHERE expires_at <= ?',
    args: [nowIso()],
  });
  let deleted = 0;
  for (const row of res.rows) {
    await deleteJobAll(row.id);
    deleted++;
  }
  return deleted;
}

/* ───────────── المصادر ───────────── */

async function getSources(jobId) {
  await ensureSchema();
  const res = await db().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? ORDER BY seq',
    args: [jobId],
  });
  return res.rows.map((r) => ({
    seq: Number(r.seq),
    kind: r.kind,
    url: r.url || null,
    name: r.name || null,
    size: r.size === null ? null : Number(r.size),
    mime: r.mime || null,
    receivedBytes: Number(r.received_bytes || 0),
  }));
}

async function getSource(jobId, seq) {
  await ensureSchema();
  const res = await db().execute({
    sql: 'SELECT * FROM sources WHERE job_id = ? AND seq = ?',
    args: [jobId, seq],
  });
  const r = res.rows[0];
  if (!r) return null;
  return {
    seq: Number(r.seq),
    kind: r.kind,
    url: r.url || null,
    name: r.name || null,
    size: r.size === null ? null : Number(r.size),
    mime: r.mime || null,
    receivedBytes: Number(r.received_bytes || 0),
  };
}

async function updateSourceReceived(jobId, seq, receivedBytes) {
  await db().execute({
    sql: 'UPDATE sources SET received_bytes = ? WHERE job_id = ? AND seq = ?',
    args: [receivedBytes, jobId, seq],
  });
}

module.exports = {
  db,
  ensureSchema,
  nowIso,
  createJob,
  getJob,
  updateJob,
  listJobs,
  deleteJobAll,
  jobExists,
  cleanupExpired,
  getSources,
  getSource,
  updateSourceReceived,
  EXPIRES_HOURS,
};
