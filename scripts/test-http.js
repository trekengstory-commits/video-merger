'use strict';
/**
 * اختبار HTTP كامل ضد خادم التطوير — تشغيل: node scripts/test-http.js
 * إنشاء من روابط → دمج → بث مع Range 206 → مهمة مختلطة (رابط + ملف مرفوع بالأجزاء)
 * → رفع متعدد الأجزاء → الحذف → 404 → JSON تالف → حدود المدخلات → القائمة → cron
 */
const fs = require('fs');
const path = require('path');
const { server } = require('./dev-server');
const { ensureFixtures, ensureBig, fixture } = require('./fixtures');

const PORT = parseInt(process.env.TEST_PORT, 10) || 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const UP = 4 * 1024 * 1024; // حجم جزء الرفع

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

async function jfetch(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, opts);
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, json: j };
}

const rel = (u) => (u.startsWith(BASE) ? u.slice(BASE.length) : u);

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function main() {
  console.log('════════ اختبارات HTTP — Video Merger ════════\n');
  ensureFixtures();
  const bigPath = ensureBig();
  check('فيديو كبير > 4.5MB للرفع متعدد الأجزاء', fs.statSync(bigPath).size > UP, (fs.statSync(bigPath).size / 1048576).toFixed(1) + 'MB');

  await new Promise((r) => server.listen(PORT, r));

  /* 1) الإعدادات وCORS */
  console.log('[الإعدادات وCORS]');
  const cfg = await jfetch('/api/config');
  check('GET /api/config → 200', cfg.status === 200, `v${cfg.json && cfg.json.version}`);
  check('config يحتوي الحدود كاملة', cfg.json && cfg.json.maxSources >= 1 && cfg.json.sourceMaxMB > 0 && cfg.json.uploadChunkBytes > 0 && cfg.json.expiresHours === 24);
  const cors = await jfetch('/api/config', { method: 'OPTIONS' });
  check('OPTIONS → 204 (CORS مفتوح)', cors.status === 204);

  /* 2) مهمة من روابط */
  console.log('[مهمة من روابط → دمج → بث]');
  const A = `${BASE}/fixtures/a.mp4`;
  const B = `${BASE}/fixtures/b.mp4`;
  const cr = await jfetch('/api/jobs', jsonPost({ videos: [A, B] }));
  check('POST /api/jobs → 201', cr.status === 201, cr.json && cr.json.error ? cr.json.error : '');
  check('يرجع jobId وstatus=queued', Boolean(cr.json && cr.json.jobId) && cr.json.status === 'queued');
  check('يرجع statusUrl وprocessUrl', typeof (cr.json && cr.json.statusUrl) === 'string' && typeof (cr.json && cr.json.processUrl) === 'string');
  check('expiresAt بعد ≈24 ساعة', cr.json && cr.json.expiresAt && new Date(cr.json.expiresAt) - new Date() > 23.5 * 3600e3);
  const jobId = cr.json.jobId;

  // حالة قبل التنفيذ
  const st0 = await jfetch(`/api/jobs/${jobId}`);
  check('GET الحالة الأولية → queued وprogress=0', st0.status === 200 && st0.json.status === 'queued' && st0.json.progress === 0);

  const pr = await jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' });
  check('POST process → 200 (متزامن)', pr.status === 200, pr.json && pr.json.error ? pr.json.error : '');
  check('status=done + videoUrl + downloadUrl', pr.json && pr.json.status === 'done' && typeof pr.json.videoUrl === 'string' && pr.json.downloadUrl.includes('download=1'));
  check('الدقة = أكبر دقة مدخل (1280x720)', pr.json && pr.json.resolution === '1280x720', pr.json && pr.json.resolution);
  check('المدة ≈ مجموع المدد (5ث)', pr.json && Math.abs(pr.json.duration - 5) < 1.2, String(pr.json && pr.json.duration));
  const size = pr.json && pr.json.size;
  check('الحجم منطقي (>50KB)', size > 50 * 1024, `${(size / 1024).toFixed(0)}KB`);

  // إعادة process على مكتملة → نفس النتيجة (دوري آمن)
  const pr2 = await jfetch(`/api/jobs/${jobId}/process`, { method: 'POST' });
  check('process على مهمة done يعيد النتيجة دون إعادة ترميز', pr2.status === 200 && pr2.json.status === 'done' && pr2.json.size === size);

  /* 3) البث الكامل + Range */
  console.log('[البث وRange]');
  const vr = await fetch(`${BASE}/api/jobs/${jobId}/video`);
  const full = Buffer.from(await vr.arrayBuffer());
  check('GET video → 200 mp4 بالحجم الكامل', vr.status === 200 && full.length === size && vr.headers.get('content-type').includes('video/mp4'), `${full.length} بايت`);
  check('Accept-Ranges: bytes', vr.headers.get('accept-ranges') === 'bytes');

  const r1 = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-99' } });
  const b1 = Buffer.from(await r1.arrayBuffer());
  check('Range bytes=0-99 → 206', r1.status === 206 && b1.length === 100);
  check('Content-Range صحيح', r1.headers.get('content-range') === `bytes 0-99/${size}`);
  check('محتوى المدى يطابق البث الكامل', b1.equals(full.subarray(0, 100)));

  const r2 = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: `bytes=${size - 500}-` } });
  const b2 = Buffer.from(await r2.arrayBuffer());
  check('Range مفتوح من النهاية → 206 بـ500 بايت', r2.status === 206 && b2.length === 500);
  check('Content-Range النهائي صحيح', r2.headers.get('content-range') === `bytes ${size - 500}-${size - 1}/${size}`);
  check('محتوى النهاية يطابق', b2.equals(full.subarray(size - 500)));

  const r3 = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: `bytes=${Math.floor(size / 2)}-${Math.floor(size / 2) + 999}` } });
  const b3 = Buffer.from(await r3.arrayBuffer());
  check('Range وسط الملف يطابق (يعبر صفوف 2MB)', r3.status === 206 && b3.equals(full.subarray(Math.floor(size / 2), Math.floor(size / 2) + 1000)));

  const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`);
  check('?download=1 → Content-Disposition attachment', dl.headers.get('content-disposition') && dl.headers.get('content-disposition').includes('attachment'));

  const bad = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: `bytes=${size + 100}-` } });
  check('Range خارج الحدود → 416', bad.status === 416);

  /* 4) مهمة مختلطة: رابط + ملف مرفوع بالأجزاء */
  console.log('[مهمة مختلطة — رفع بالأجزاء]');
  const C = fs.readFileSync(fixture('c.mp4'));
  const mx = await jfetch('/api/jobs', jsonPost({
    sources: [{ kind: 'url', url: A }, { kind: 'file', name: 'c.mp4', size: C.length, mime: 'video/mp4' }],
  }));
  check('إنشاء مهمة مختلطة → 201 uploading', mx.status === 201 && mx.json.status === 'uploading');
  check('يرجع uploads[] + uploadChunkBytes', Array.isArray(mx.json.uploads) && mx.json.uploads.length === 1 && mx.json.uploadChunkBytes === UP);
  const mJob = mx.json.jobId;
  const up = mx.json.uploads[0];
  check('uploadUrl يشير لـ /api/upload بـ job وseq صحيحين', up.uploadUrl.includes(`/api/upload?job=${mJob}`) && up.uploadUrl.includes('seq=1'));

  // process قبل اكتمال الرفع → 409
  const early = await jfetch(`/api/jobs/${mJob}/process`, { method: 'POST' });
  check('process قبل اكتمال الرفع → 409', early.status === 409, early.json && early.json.error ? early.json.error.slice(0, 50) : '');

  // الرفع جزءًا جزءًا
  let allOK = true;
  const chunks = Math.ceil(C.length / UP);
  for (let k = 0; k < chunks; k++) {
    const piece = C.subarray(k * UP, Math.min((k + 1) * UP, C.length));
    const u = await jfetch(`${rel(up.uploadUrl)}&chunk=${k}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: piece,
    });
    if (u.status !== 200 || u.json.receivedBytes !== Math.min((k + 1) * UP, C.length)) {
      allOK = false;
      console.log('    ↳ فشل الجزء', k, u.status, JSON.stringify(u.json));
    }
  }
  check(`رفع الملف في ${chunks} جزء → 200 وتقدّم صحيح`, allOK);
  check('الرفع اكتمل (receivedBytes=size)', (await jfetch(`/api/jobs/${mJob}`)).json.sources[1].receivedBytes === C.length);

  // إعادة رفع نفس الجزء (محاكاة إعادة محاولة الواجهة) → INSERT OR REPLACE
  const dup = await jfetch(`${rel(up.uploadUrl)}&chunk=0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: C.subarray(0, Math.min(UP, C.length)),
  });
  check('إعادة رفع الجزء نفسه تنجح (تعويض بدل التكرار)', dup.status === 200 && dup.json.receivedBytes === C.length);

  const mp = await jfetch(`/api/jobs/${mJob}/process`, { method: 'POST' });
  check('دمج المهمة المختلطة → done', mp.status === 200 && mp.json.status === 'done', mp.json && mp.json.error ? mp.json.error : '');
  check('دقة المهمة المختلطة = 854x480 (أكبر دقة: a=640×360، c=854×480)', mp.json && mp.json.resolution === '854x480', mp.json && mp.json.resolution);
  check('مدة المهمة المختلطة ≈ 5ث', mp.json && Math.abs(mp.json.duration - 5) < 1.2, String(mp.json && mp.json.duration));

  // رفع على مهمة منتهية → 409
  const late = await jfetch(`${rel(up.uploadUrl)}&chunk=0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: C.subarray(0, 100),
  });
  check('رفع على مهمة done → 409', late.status === 409);

  /* 5) رفع متعدد الأجزاء عبر HTTP (big.mp4 > 4.5MB) */
  console.log('[رفع متعدد الأجزاء — big.mp4]');
  const bigBuf = fs.readFileSync(bigPath);
  const bg = await jfetch('/api/jobs', jsonPost({ sources: [{ kind: 'file', name: 'big.mp4', size: bigBuf.length, mime: 'video/mp4' }] }));
  const bJob = bg.json.jobId;
  const bUp = bg.json.uploads[0];
  let bigOK = true;
  for (let k = 0; k * UP < bigBuf.length; k++) {
    const piece = bigBuf.subarray(k * UP, Math.min((k + 1) * UP, bigBuf.length));
    const u = await jfetch(`${rel(bUp.uploadUrl)}&chunk=${k}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: piece });
    if (u.status !== 200) { bigOK = false; console.log('    ↳ فشل الجزء', k, u.status, JSON.stringify(u.json)); }
  }
  check(`رفع big.mp4 في ${Math.ceil(bigBuf.length / UP)} أجزاء → مكتمل`, bigOK && (await jfetch(`/api/jobs/${bJob}`)).json.sources[0].receivedBytes === bigBuf.length);

  // جزء يتجاوز 4MB → 413
  const over = await fetch(`${BASE}/api/upload?job=${bJob}&seq=0&chunk=0`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(UP + 1024, 3),
  });
  check('جزء يتجاوز 4MB → 413', over.status === 413, JSON.stringify(await over.json().catch(() => null)));

  // رقم جزء خارج النطاق → 400
  const oob = await jfetch(`${rel(bUp.uploadUrl)}&chunk=999`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
  check('chunk خارج النطاق → 400', oob.status === 400);

  // حجم يتجاوز المعلن → 400
  const over2 = await jfetch(`${rel(bUp.uploadUrl)}&chunk=0`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.concat([bigBuf, Buffer.from('xx')]) });
  check('بايتات تتجاوز الحجم المعلن → 400/413', over2.status === 400 || over2.status === 413);

  await jfetch(`/api/jobs/${bJob}`, { method: 'DELETE' }); // تنظيف — لا نحتاج ترميز 20+ ثانية هنا

  /* 6) الحذف الشامل ثم 404 */
  console.log('[الحذف ثم 404]');
  const del = await jfetch(`/api/jobs/${mJob}`, { method: 'DELETE' });
  check('DELETE → 200 deleted', del.status === 200 && del.json.deleted === true);
  const g404 = await jfetch(`/api/jobs/${mJob}`);
  check('GET بعد الحذف → 404 مع error عربي', g404.status === 404 && typeof g404.json.error === 'string');
  const v404 = await fetch(`${BASE}/api/jobs/${mJob}/video`);
  check('video بعد الحذف → 404', v404.status === 404);
  const d404 = await jfetch(`/api/jobs/${mJob}`, { method: 'DELETE' });
  check('DELETE مكرر → 404', d404.status === 404);
  const p404 = await jfetch(`/api/jobs/does-not-exist/process`, { method: 'POST' });
  check('process لمهمة غير موجودة → 404', p404.status === 404);
  const up404 = await jfetch('/api/upload?job=no-such-job&seq=0&chunk=0', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('x') });
  check('رفع لمهمة غير موجودة → 404', up404.status === 404);

  /* 7) مدخلات تالفة وحدود */
  console.log('[المدخلات التالفة والحدود]');
  const malformed = await jfetch('/api/jobs', jsonPost('{برابط تالف'));
  check('JSON تالف → 400', malformed.status === 400);
  const emptyBody = await jfetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('جسم فارغ → 400', emptyBody.status === 400);
  const noSources = await jfetch('/api/jobs', jsonPost({ foo: 1 }));
  check('جسم بلا videos/sources → 400', noSources.status === 400);
  const emptyList = await jfetch('/api/jobs', jsonPost({ videos: [] }));
  check('قائمة فارغة → 400', emptyList.status === 400);
  const notUrl = await jfetch('/api/jobs', jsonPost({ videos: ['ليس-رابطًا'] }));
  check('رابط غير صالح → 400', notUrl.status === 400);
  const toomany = await jfetch('/api/jobs', jsonPost({ videos: Array(11).fill(A) }));
  check('تجاوز حد المصادر (11) → 400', toomany.status === 400);

  /* 8) طرق خاطئة 405 */
  const put405 = await jfetch(`/api/jobs/${jobId}`, { method: 'PUT' });
  check('PUT على /api/jobs/<id> → 405', put405.status === 405);
  const delCfg = await jfetch('/api/config', { method: 'DELETE' });
  check('DELETE على /api/config → 405', delCfg.status === 405);
  const getCron = await jfetch('/api/cron');
  check('GET /api/cron → 200', getCron.status === 200 && getCron.json.ok === true);

  /* 9) القائمة */
  const lst = await jfetch('/api/jobs');
  check('GET /api/jobs قائمة تحتوي المهمة الأولى', lst.status === 200 && Array.isArray(lst.json.jobs) && lst.json.jobs.some((x) => x.jobId === jobId));
  await jfetch(`/api/jobs/${jobId}`, { method: 'DELETE' }); // تنظيف نهائي
  const lst2 = await jfetch('/api/jobs');
  check('المهام المحذوفة تختفي من القائمة', lst2.json.jobs.every((x) => x.jobId !== mJob && x.jobId !== jobId));

  server.close();

  console.log('\n════════ النتيجة ════════');
  console.log(`  نجح: ${passed} | فشل: ${failed}`);
  if (failed) {
    console.log('  إخفاقات:', failures.join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('خطأ غير متوقع:', e);
  process.exit(1);
});
