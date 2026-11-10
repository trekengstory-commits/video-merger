'use strict';
/**
 * محرك الدمج — ffmpeg/ffprobe داخل الدالة نفسها.
 *
 * - ffprobe لكل مصدر: الدقة، fps، المدة، وجود صوت.
 * - توحيد عبر filter_complex: scale+pad إلى أكبر دقة (حد 1920×1080 زوجي)، fps=30،
 *   setsar=1، format=yuv420p، ثم concat=n=:v=1:a=1.
 * - مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج.
 * - ترميز libx264 CRF 18 + AAC 192k/44100 + +faststart (preset من البيئة).
 * - تقدم الترميز من out_time_us عبر -progress pipe:1.
 * - ensureExecutable: نسخ الثنائي إلى /tmp بصلاحية 755 عند فقدان الصلاحية.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { MB } = require('./limits');

class LimitError extends Error {
  constructor(message) {
    super(message);
    this.isLimit = true;
  }
}

/* ───────────── حل مسارات الثنائيات ───────────── */

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

function resolveFfprobePath() {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) return process.env.FFPROBE_PATH;
  try {
    const p = require('ffprobe-static');
    if (p && p.path && fs.existsSync(p.path)) return p.path;
  } catch {}
  return 'ffprobe';
}

/** يضمن صلاحية التنفيذ — ينسخ إلى /tmp بصلاحية 755 عند الحاجة */
async function ensureExecutable(binPath) {
  if (!binPath || binPath === 'ffmpeg' || binPath === 'ffprobe') return binPath;
  try {
    fs.accessSync(binPath, fs.constants.X_OK);
    // فحص إضافي: بعض الاستضافات تُركّب noexec — نفترض سلوك spawn يكتشفها
    return binPath;
  } catch {
    const tmp = path.join(os.tmpdir(), `vm-${path.basename(binPath)}`);
    await fs.promises.copyFile(binPath, tmp);
    await fs.promises.chmod(tmp, 0o755);
    return tmp;
  }
}

/** تنفيذ أمر — يعيد التقاط stdout وذيل stderr، ويتراجع إلى /tmp عند EACCES */
function execBin(binPath, args, { collectStdout = false, onStdoutLine = null, timeoutMs = 280000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderrTail = '';
    let lineBuf = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) {
        settled = true;
        reject(new Error(`انتهت مهلة التنفيذ (${Math.round(timeoutMs / 1000)} ثانية)`));
      }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (collectStdout) stdout += s;
      if (onStdoutLine) {
        lineBuf += s;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop();
        for (const l of lines) {
          try { onStdoutLine(l); } catch {}
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        err.binPath = binPath;
        reject(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ stdout, stderrTail });
      else reject(new Error(`فشل ${path.basename(binPath)} (كود ${code}): ${stderrTail.trim().slice(-600) || 'بلا تفاصيل'}`));
    });
  });
}

async function runBin(binPath, args, opts = {}) {
  try {
    return await execBin(binPath, args, opts);
  } catch (e) {
    if ((e.code === 'EACCES' || e.code === 'ENOENT') && binPath !== 'ffmpeg' && binPath !== 'ffprobe') {
      // صلاحية التنفيذ ضاعت على الاستضافة → انسخ إلى /tmp بصلاحية 755 وأعد المحاولة
      const tmp = path.join(os.tmpdir(), `vm-${path.basename(binPath)}`);
      await fs.promises.copyFile(binPath, tmp);
      await fs.promises.chmod(tmp, 0o755);
      return await execBin(tmp, args, opts);
    }
    throw e;
  }
}

/* ───────────── الفحص ffprobe ───────────── */

function parseRate(r) {
  if (!r) return 30;
  const [a, b] = String(r).split('/').map(Number);
  if (!b) return 30;
  const v = a / b;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 30;
}

async function probeFile(binPath, file) {
  const { stdout } = await runBin(binPath, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], {
    collectStdout: true,
  });
  let meta;
  try {
    meta = JSON.parse(stdout);
  } catch {
    throw new Error(`تعذّر قراءة بيانات المصدر «${path.basename(file)}» — قد لا يكون ملف فيديو صالحًا`);
  }
  const streams = meta.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video) throw new Error(`المصدر «${path.basename(file)}» لا يحتوي مسار فيديو صالحًا`);
  const duration = parseFloat((meta.format && meta.format.duration) || video.duration || '0');
  return {
    width: video.width,
    height: video.height,
    fps: parseRate(video.avg_frame_rate || video.r_frame_rate),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    hasAudio: Boolean(audio),
  };
}

/* ───────────── تنزيل المصادر ───────────── */

/** ينزّل رابطًا مباشرًا إلى ملف مع عدّ البايتات وحد الحجم */
async function downloadToFile(url, dest, maxBytes, { onBytes, timeoutMs = 120000 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'video-merger/1.0 (+merge service)' },
    });
  } catch (e) {
    throw new Error(`تعذّر الوصول إلى الرابط (${e.name === 'TimeoutError' ? 'مهلة' : 'خطأ شبكة'}) — تأكد أنه رابط مباشر لملف فيديو`);
  }
  if (!res.ok || !res.body) {
    throw new Error(`تعذّر تنزيل المصدر (رمز ${res.status}) — تأكد أن الرابط مباشر لملف فيديو`);
  }
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared && declared > maxBytes) {
    try { await res.body.cancel(); } catch {}
    throw new LimitError(`حجم المصدر ${(declared / MB).toFixed(1)}MB يتجاوز الحد المسموح ${Math.round(maxBytes / MB)}MB`);
  }
  let total = 0;
  const counter = new Transform({
    transform(chunk, enc, cb) {
      total += chunk.length;
      if (total > maxBytes) {
        cb(new LimitError(`حجم المصدر يتجاوز الحد المسموح ${Math.round(maxBytes / MB)}MB`));
        return;
      }
      if (onBytes) {
        try { onBytes(total, declared || null); } catch {}
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(res.body, counter, fs.createWriteStream(dest));
  } catch (e) {
    await fs.promises.rm(dest, { force: true }).catch(() => {});
    throw e.isLimit ? e : new Error(`فشل تنزيل المصدر: ${e.message}`);
  }
  return total;
}

/* ───────────── بناء مرشّح الدمج ───────────── */

const evenize = (x) => Math.max(2, x - (x % 2));

/** يحسب الدقة الهدف: أكبر دقة بين المدخلات بسقف 1920×1080 وبأبعاد زوجية */
function targetResolution(infos) {
  const w = evenize(Math.min(1920, Math.max(...infos.map((i) => i.width || 0))));
  const h = evenize(Math.min(1080, Math.max(...infos.map((i) => i.height || 0))));
  return { W: w, H: h };
}

function buildFilterGraph(infos) {
  const n = infos.length;
  const { W, H } = targetResolution(infos);
  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (infos[i].hasAudio) {
      parts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    } else {
      // مدخل صامت anullsrc (مُلحق بعد كل مدخلات الفيديو، فهرسه n + i)
      parts.push(`[${n + i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
    }
  }
  const labels = infos.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${labels}concat=n=${n}:v=1:a=1[vout][aout]`);
  return { filter: parts.join(';'), W, H };
}

function silenceInputArgs(infos) {
  const args = [];
  infos.forEach((info) => {
    args.push('-f', 'lavfi', '-t', String(Math.max(info.duration || 0.2, 0.2).toFixed(3)), '-i', 'anullsrc=r=44100:cl=stereo');
  });
  return args;
}

/* ───────────── الترميز ───────────── */

async function encode({
  infos,
  inputPaths,
  outPath,
  preset = 'medium',
  totalDuration,
  onProgress = null, // نسبة 0..1 داخل مرحلة الترميز
}) {
  const { filter } = buildFilterGraph(infos);
  const args = ['-hide_banner', '-y', '-progress', 'pipe:1', '-nostats'];
  for (const p of inputPaths) args.push('-i', p);
  args.push(...silenceInputArgs(infos));
  args.push(
    '-filter_complex',
    filter,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    preset,
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-movflags',
    '+faststart',
    outPath
  );

  await runBin(resolveFfmpegPath(), args, {
    onStdoutLine: (line) => {
      const m = /^out_time_us=(\d+)/.exec(line.trim());
      if (m && onProgress && totalDuration > 0) {
        const outSec = Number(m[1]) / 1e6;
        onProgress(Math.max(0, Math.min(1, outSec / totalDuration)));
      }
    },
  });
  return outPath;
}

/** دمج مباشر لمسارات محلية (للاختبارات) — يعيد معلومات الناتج */
async function mergePaths(paths, outPath, { preset = 'medium', onEncodeRatio = null } = {}) {
  const ffprobe = resolveFfprobePath();
  const infos = [];
  for (const p of paths) infos.push(await probeFile(ffprobe, p));
  const totalDuration = infos.reduce((s, i) => s + i.duration, 0);
  const { W, H } = buildFilterGraph(infos);
  await encode({ infos, inputPaths: paths, outPath, preset, totalDuration, onProgress: onEncodeRatio });
  return { width: W, height: H, duration: totalDuration, infos };
}

module.exports = {
  LimitError,
  resolveFfmpegPath,
  resolveFfprobePath,
  ensureExecutable,
  probeFile,
  downloadToFile,
  buildFilterGraph,
  targetResolution,
  encode,
  mergePaths,
};
