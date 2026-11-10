'use strict';
/**
 * اختبارات الوحدة — تشغيل: node scripts/test-unit.js
 * تتحقق من: الدمج الفعلي بالدقات المختلفة، الصوت، التخزين في Turso بتطابق sha256،
 * مسار رفع الأجزاء، حدود الحجم، والحذف الشامل.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { Readable } = require('stream');

const { ensureFixtures, fixture } = require('./fixtures');
const { mergePaths, probeFile, resolveFfprobePath, resolveFfmpegPath, ensureExecutable, downloadToFile, LimitError } = require('../lib/merge');
const {
  putOutputChunksStream, putSourceChunk, deleteSourceChunks, deleteOutputChunks,
  readWholeBlob, blobBytes, sourceStoredBytes, countRows, blobToStream,
} = require('../lib/storage');
const { createJob, getJob, deleteJobAll, cleanupExpired, ensureSchema } = require('../lib/db');
const { CHUNK_BYTES, UPLOAD_CHUNK_BYTES } = require('../lib/limits');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed++;
    failures.push(name + (extra ? ` (${extra})` : ''));
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const bufferToStream = (buf) => Readable.from(buf);

async function main() {
  console.log('════════ اختبارات الوحدة — Video Merger ════════\n');

  /* 0) تجهيز الفيديوهات */
  console.log('[توليد الفيديوهات التجريبية]');
  ensureFixtures();
  const A = fixture('a.mp4'); // 640×360 — 3ث — بصوت
  const B = fixture('b.mp4'); // 1280×720 — 2ث — بصوت
  const C = fixture('c.mp4'); // 854×480 — 2ث — بلا صوت
  for (const f of [A, B, C]) check(`توليد ${path.basename(f)}`, fs.existsSync(f) && fs.statSync(f).size > 20000, fmtKB(f));

  /* 1) الثنائيات */
  console.log('\n[الثنائيات]');
  const ffbin = resolveFfmpegPath();
  const fppath = resolveFfprobePath();
  check('ffmpeg-static موجود', Boolean(ffbin) && (ffbin === 'ffmpeg' || fs.existsSync(ffbin)), String(ffbin).split('/').pop());
  check('ffprobe-static موجود', Boolean(fppath) && (fppath === 'ffprobe' || fs.existsSync(fppath)));
  const ensured = await ensureExecutable(ffbin);
  check('ensureExecutable (صلاحية التنفيذ)', Boolean(ensured) && fs.existsSync(ensured));

  /* 2) ffprobe */
  console.log('\n[فحص ffprobe]');
  const ffprobe = resolveFfprobePath();
  const infoA = await probeFile(ffprobe, A);
  const infoB = await probeFile(ffprobe, B);
  const infoC = await probeFile(ffprobe, C);
  check('دقة a.mp4 = 640×360', infoA.width === 640 && infoA.height === 360);
  check('مدة a.mp4 ≈ 3ث', Math.abs(infoA.duration - 3) < 0.6, infoA.duration.toFixed(2));
  check('a.mp4 فيه صوت', infoA.hasAudio === true);
  check('c.mp4 بلا صوت', infoC.hasAudio === false);
  check('دقة b.mp4 = 1280×720', infoB.width === 1280 && infoB.height === 720);

  /* 3) الدمج الفعلي — دقتان مختلفتان */
  console.log('\n[الدمج الفعلي a+b — دقات مختلفة]');
  const out1 = path.join(os.tmpdir(), `unit-out1-${Date.now()}.mp4`);
  const t0 = Date.now();
  const r1 = await mergePaths([A, B], out1, { preset: 'veryfast' });
  const mergeSec = ((Date.now() - t0) / 1000).toFixed(1);
  check('اكتمال الدمج', fs.existsSync(out1) && fs.statSync(out1).size > 50000, `${fmtKB(out1)} خلال ${mergeSec}ث`);
  check('الدقة = أكبر دقة مدخل (1280×720)', r1.width === 1280 && r1.height === 720);
  const infoOut = await probeFile(ffprobe, out1);
  check('المدة ≈ مجموع المدد (5ث)', Math.abs(infoOut.duration - 5) < 1.2, infoOut.duration.toFixed(2));
  check('وجود الصوت في الناتج', infoOut.hasAudio === true);
  fs.rmSync(out1, { force: true });

  /* 4) الدمج مع مصدر بلا صوت (مسار anullsrc) */
  console.log('\n[الدمج مع مصدر صامت b+c]');
  const out2 = path.join(os.tmpdir(), `unit-out2-${Date.now()}.mp4`);
  const r2 = await mergePaths([B, C], out2, { preset: 'veryfast' });
  const infoOut2 = await probeFile(ffprobe, out2);
  check('دمج مصدر بلا صوت ينجح (anullsrc)', fs.existsSync(out2) && fs.statSync(out2).size > 50000);
  check('الصوت موجود بعد الدمج رغم المصدر الصامت', infoOut2.hasAudio === true);
  check('المدة ≈ 4ث', Math.abs(infoOut2.duration - 4) < 1.2, infoOut2.duration.toFixed(2));
  fs.rmSync(out2, { force: true });

  /* 5) التخزين في Turso — تطابق sha256 + Range */
  console.log('\n[التخزين في Turso — Blobs 2MB]');
  const testId = 'unit-' + crypto.randomBytes(4).toString('hex');
  try {
    await ensureSchema();
    const blob = crypto.randomBytes(CHUNK_BYTES * 2 + 123456); // ≈ 4.24MB → 3 صفوف
    await putOutputChunksStream(testId, bufferToStream(blob));
    check('عدد صفوف الناتج = ceil(الحجم/2MB)', (await countRows('output_chunks', testId)) === Math.ceil(blob.length / CHUNK_BYTES), `${blob.length} بايت`);
    const back = await readWholeBlob({ table: 'output_chunks', jobId: testId });
    check('استرجاع كامل بتطابق sha256', sha256(back) === sha256(blob), sha256(back).slice(0, 12));

    // قراءة تدفقية (الطريق نفسه الذي يستخدمه البث)
    const streamed = [];
    for await (const b of blobBytes({ table: 'output_chunks', jobId: testId, start: 0, end: blob.length - 1 })) streamed.push(b);
    check('قراءة تدفقية كاملة (blobBytes)', sha256(Buffer.concat(streamed)) === sha256(blob));

    // Range وسط الملف — يعبر حدود الصفوف
    const rs = 1000, re = CHUNK_BYTES + 5000;
    const ranged = await readWholeBlob({ table: 'output_chunks', jobId: testId, start: rs, end: re });
    check('Range يعبر حدود الصفوف بتطابق تام', sha256(ranged) === sha256(blob.subarray(rs, re + 1)), `${(re - rs + 1)} بايت`);

    // بث عبر blobToStream (نفس ما تستخدمه نقطة الفيديو)
    const viaStream = await new Promise((resolve, reject) => {
      const parts = [];
      const st = blobToStream({ table: 'output_chunks', jobId: testId, start: 5, end: 999999 });
      st.on('data', (c) => parts.push(c));
      st.on('end', () => resolve(Buffer.concat(parts)));
      st.on('error', reject);
    });
    check('بث blobToStream مع تقليم صحيح', sha256(viaStream) === sha256(blob.subarray(5, 1000000)));

    /* 6) مسار رفع الأجزاء (client-style 4MB → صفوف 2MB) */
    console.log('\n[مسار رفع الأجزاء]');
    const srcBuf = crypto.randomBytes(UPLOAD_CHUNK_BYTES + 777777); // ≈ 4.74MB → جزءان
    for (let k = 0; k * UPLOAD_CHUNK_BYTES < srcBuf.length; k++) {
      const piece = srcBuf.subarray(k * UPLOAD_CHUNK_BYTES, Math.min((k + 1) * UPLOAD_CHUNK_BYTES, srcBuf.length));
      await putSourceChunk(testId, 0, k, piece);
    }
    check('بايتات المصدر المخزنة = الحجم', (await sourceStoredBytes(testId, 0)) === srcBuf.length);
    const srcBack = await readWholeBlob({ table: 'source_chunks', jobId: testId, seq: 0 });
    check('تجميع المصدر من الأجزاء بتطابق sha256', sha256(srcBack) === sha256(srcBuf));

    // حذف source_chunks بعد نجاح الدمج
    await deleteSourceChunks(testId);
    check('حذف source_chunks بعد النجاح', (await countRows('source_chunks', testId)) === 0);

    /* 7) الحذف الشامل */
    console.log('\n[الحذف الشامل]');
    const delId = 'unit-del-' + crypto.randomBytes(4).toString('hex');
    await createJob({
      id: delId,
      status: 'done',
      sources: [{ kind: 'url', url: 'https://example.com/x.mp4' }],
      expiresAt: new Date(Date.now() + 3600e3),
    });
    await putOutputChunksStream(delId, bufferToStream(crypto.randomBytes(CHUNK_BYTES + 11)));
    await deleteJobAll(delId);
    check('deleteJobAll يحذف من الجداول الأربعة',
      (await countRows('output_chunks', delId)) === 0 &&
      (await countRows('source_chunks', delId)) === 0 &&
      (await getJob(delId)) === null);

    /* 8) التنظيف الكسول للمهام المنتهية */
    console.log('\n[التنظيف الكسول]');
    const oldId = 'unit-old-' + crypto.randomBytes(4).toString('hex');
    await createJob({
      id: oldId,
      status: 'done',
      sources: [{ kind: 'url', url: 'https://example.com/y.mp4' }],
      expiresAt: new Date(Date.now() - 1000), // منتهية
    });
    const deleted = await cleanupExpired();
    check('cleanupExpired يحذف المنتهية', (await getJob(oldId)) === null && deleted >= 1, `حُذفت ${deleted}`);
  } finally {
    await deleteJobAll(testId).catch(() => {});
  }

  /* 9) حدود الحجم — تنزيل يتجاوز الحد */
  console.log('\n[حدود الحجم]');
  await new Promise((resolve) => {
    const srv = http.createServer((rq, rs) => {
      rs.setHeader('Content-Length', 6 * 1024 * 1024);
      const chunk = Buffer.alloc(256 * 1024, 7);
      let n = 0;
      const iv = setInterval(() => {
        if (n++ < 24) rs.write(chunk);
        else { clearInterval(iv); rs.end(); }
      }, 5);
      rq.on('close', () => clearInterval(iv));
    });
    srv.listen(0, async () => {
      const port = srv.address().port;
      let limitHit = false;
      try {
        await downloadToFile(`http://127.0.0.1:${port}/x.mp4`, path.join(os.tmpdir(), 'unit-limit.bin'), 1024 * 1024);
      } catch (e) {
        limitHit = e instanceof LimitError || e.isLimit === true;
      }
      check('رفض تنزيل يتجاوز الحد (LimitError)', limitHit);
      fs.rmSync(path.join(os.tmpdir(), 'unit-limit.bin'), { force: true });
      srv.close(resolve);
    });
  });

  console.log('\n════════ النتيجة ════════');
  console.log(`  نجح: ${passed} | فشل: ${failed}`);
  if (failed) {
    console.log('  إخفاقات:', failures.join(' | '));
    process.exit(1);
  }
}

function fmtKB(f) {
  return (fs.statSync(f).size / 1024).toFixed(0) + 'KB';
}

main().catch((e) => {
  console.error('خطأ غير متوقع:', e);
  process.exit(1);
});
