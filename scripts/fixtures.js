'use strict';
/** توليد فيديوهات اختبار بدقات مختلفة عبر ffmpeg-static (تُخزَّن في fixtures/) */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const DIR = path.join(__dirname, '..', 'fixtures');

const SPECS = {
  'a.mp4': { w: 640, h: 360, d: 3, audio: true },   // صغيرة بصوت
  'b.mp4': { w: 1280, h: 720, d: 2, audio: true },  // كبيرة بصوت — دقة الهدف المتوقعة
  'c.mp4': { w: 854, h: 480, d: 2, audio: false },  // متوسطة بلا صوت — تختبر مسار anullsrc
};

/** big.mp4 — أكبر من جزء رفع واحد (4MB) لاختبار الرفع متعدد الأجزاء عبر HTTP */
function ensureBig(target = 4.5 * 1024 * 1024) {
  fs.mkdirSync(DIR, { recursive: true });
  let d = 20;
  for (let i = 0; i < 4; i++) {
    const f = path.join(DIR, 'big.mp4');
    if (fs.existsSync(f) && fs.statSync(f).size >= target) return f;
    if (fs.existsSync(f)) fs.rmSync(f, { force: true });
    const args = [
      '-hide_banner', '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${d}`,
      '-f', 'lavfi', '-i', `sine=frequency=330:duration=${d}`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', '-shortest', f,
    ];
    execFileSync(ffmpeg, args, { stdio: 'pipe' });
    if (fs.statSync(f).size >= target) return f;
    d = Math.round(d * 1.8);
  }
  return path.join(DIR, 'big.mp4');
}

function ensureFixtures() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, s] of Object.entries(SPECS)) {
    const f = path.join(DIR, name);
    if (fs.existsSync(f) && fs.statSync(f).size > 20000) continue;
    const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc=size=${s.w}x${s.h}:rate=30:duration=${s.d}`];
    if (s.audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${s.d}`);
    args.push('-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30');
    if (s.audio) args.push('-c:a', 'aac', '-b:a', '96k', '-shortest');
    else args.push('-an');
    args.push(f);
    execFileSync(ffmpeg, args, { stdio: 'pipe' });
  }
  return DIR;
}

function fixture(name) {
  return path.join(DIR, name);
}

module.exports = { ensureFixtures, ensureBig, fixture, DIR };
