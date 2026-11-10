'use strict';
/**
 * تخزين الـ Blobs في Turso — تقسيم 2MB لكل صف (حد HTTP الآمن)
 * وقراءة تدفقية بصفحات 8 صفوف مع دعم قص أول/آخر جزء (Range).
 */
const { Readable } = require('stream');
const { db, ensureSchema } = require('./db');
const { CHUNK_BYTES, READ_PAGE_ROWS, UPLOAD_CHUNK_BYTES } = require('./limits');

/** صفوف الكتابة الواحدة — نحافظ على ≤4MB لكل طلب HTTP نحو Turso */
const WRITE_BATCH_ROWS = 2;
const ROWS_PER_UPLOAD_CHUNK = Math.ceil(UPLOAD_CHUNK_BYTES / CHUNK_BYTES); // = 2

/** يكتب جزء رفع واحد (≤4MB محاذى) كصفّي 2MB متتاليين */
async function putSourceChunk(jobId, seq, chunkIndex, buffer) {
  const offset = chunkIndex * UPLOAD_CHUNK_BYTES;
  if (offset % CHUNK_BYTES !== 0) {
    throw new Error('حجم جزء الرفع يجب أن يكون مضاعفًا لحجم صف التخزين');
  }
  let row = Math.floor(offset / CHUNK_BYTES);
  const stmts = [];
  for (let off = 0; off < buffer.length; off += CHUNK_BYTES) {
    const piece = buffer.subarray(off, Math.min(off + CHUNK_BYTES, buffer.length));
    stmts.push({
      sql: 'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)',
      args: [jobId, seq, row, Buffer.from(piece)],
    });
    row++;
  }
  if (stmts.length) await db().batch(stmts, 'write');
}

/** يكتب الناتج كاملًا صفوفًا 2MB — يقرأ من Stream لتجنب تحميل الذاكرة */
async function putOutputChunksStream(jobId, stream) {
  let chunk = 0;
  let pending = Buffer.alloc(0);
  let batch = [];

  const flushBatch = async (force = false) => {
    if (!batch.length) return;
    if (batch.length < WRITE_BATCH_ROWS && !force) return;
    const b = batch;
    batch = [];
    await db().batch(b, 'write');
  };

  const pushRow = async (piece, force = false) => {
    batch.push({
      sql: 'INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)',
      args: [jobId, chunk, piece],
    });
    chunk++;
    await flushBatch(force);
  };

  for await (const piece of stream) {
    let data = Buffer.concat([pending, piece]);
    while (data.length >= CHUNK_BYTES) {
      await pushRow(data.subarray(0, CHUNK_BYTES));
      data = data.subarray(CHUNK_BYTES);
    }
    pending = data;
  }
  if (pending.length) await pushRow(pending, true);
  await flushBatch(true);
}

async function deleteSourceChunks(jobId) {
  await db().execute({ sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] });
}

async function deleteOutputChunks(jobId) {
  await db().execute({ sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] });
}

/**
 * مولّد يمرّ على بايتات Blob المخزنة بين start و end (شاملين) — يدعم Range.
 * يقرأ الصفوف بصفحات 8 ويقلّم أول/آخر جزء حسب المدى المطلوب.
 */
async function* blobBytes({ table, jobId, seq = null, start = 0, end = null }) {
  if (end === null) {
    const res = await db().execute({
      sql: `SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM ${table} WHERE job_id = ?${seq === null ? '' : ' AND seq = ?'}`,
      args: seq === null ? [jobId] : [jobId, seq],
    });
    end = Number(res.rows[0].total) - 1;
  }
  if (end < start) return;

  const firstChunk = Math.floor(start / CHUNK_BYTES);
  const lastChunk = Math.floor(end / CHUNK_BYTES);
  let next = firstChunk;

  while (next <= lastChunk) {
    const pageEnd = Math.min(next + READ_PAGE_ROWS - 1, lastChunk);
    const res = await db().execute({
      sql: `SELECT chunk, data FROM ${table} WHERE job_id = ? AND chunk BETWEEN ? AND ?${seq === null ? '' : ' AND seq = ?'} ORDER BY chunk`,
      args: seq === null ? [jobId, next, pageEnd] : [jobId, next, pageEnd, seq],
    });
    if (!res.rows.length) break;

    for (const row of res.rows) {
      const c = Number(row.chunk);
      const data = Buffer.from(row.data);
      const chunkStart = c * CHUNK_BYTES;
      const chunkEnd = chunkStart + data.length - 1;
      const s = Math.max(start, chunkStart);
      const e = Math.min(end, chunkEnd);
      if (e >= s) yield data.subarray(s - chunkStart, e - chunkStart + 1);
    }
    const last = Number(res.rows[res.rows.length - 1].chunk);
    if (last >= lastChunk) break;
    next = last + 1;
  }
}

function blobToStream(opts) {
  return Readable.from(blobBytes(opts));
}

/** قراءة كاملة للذاكرة (للاختبارات والتحقق) */
async function readWholeBlob(opts) {
  const parts = [];
  for await (const b of blobBytes(opts)) parts.push(b);
  return Buffer.concat(parts);
}

/** مجموع بايتات مصدر مخزن */
async function sourceStoredBytes(jobId, seq) {
  const res = await db().execute({
    sql: 'SELECT COALESCE(SUM(LENGTH(data)), 0) AS total FROM source_chunks WHERE job_id = ? AND seq = ?',
    args: [jobId, seq],
  });
  return Number(res.rows[0].total);
}

async function countRows(table, jobId) {
  const res = await db().execute({
    sql: `SELECT COUNT(*) AS c FROM ${table} WHERE job_id = ?`,
    args: [jobId],
  });
  return Number(res.rows[0].c);
}

module.exports = {
  CHUNK_BYTES,
  ROWS_PER_UPLOAD_CHUNK,
  putSourceChunk,
  putOutputChunksStream,
  deleteSourceChunks,
  deleteOutputChunks,
  blobBytes,
  blobToStream,
  readWholeBlob,
  sourceStoredBytes,
  countRows,
  ensureSchema,
};
