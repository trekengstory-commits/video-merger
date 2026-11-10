'use strict';
/**
 * خادم تطوير محلي يحاكي بيئة Vercel:
 * - يحلّل المسارات الديناميكية (/api/jobs/<id>/…) ويضعها في req.query.id
 * - يقدّم الواجهة من public/ وملفات الاختبار من fixtures/
 * - يستدعي نفس دوال api/ التي تعمل على Vercel دون أي تعديل
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'fixtures');

const jobsIndex = require('../api/jobs/index.js');
const jobIdRoute = require('../api/jobs/[id].js');
const jobsProcess = require('../api/jobs/[id]/process.js');
const jobsVideo = require('../api/jobs/[id]/video.js');
const uploadRoute = require('../api/upload.js');
const configRoute = require('../api/config.js');
const cronRoute = require('../api/cron.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

function serveFile(res, filePath, contentType) {
  const st = fs.statSync(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', st.size);
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;
    req.query = Object.fromEntries(u.searchParams);
    req.originalPath = p;

    /* ملفات ثابتة */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveFile(res, path.join(PUBLIC, 'index.html'), MIME['.html']);
    }
    if (req.method === 'GET' && p.startsWith('/fixtures/')) {
      const f = path.join(FIXTURES, path.normalize(p.slice('/fixtures/'.length)).replace(/^(\.\.[/\\])+/, ''));
      if (!f.startsWith(FIXTURES) || !fs.existsSync(f)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'ملف تجريبي غير موجود' }));
      }
      return serveFile(res, f, MIME[path.extname(f)] || 'application/octet-stream');
    }

    /* نقاط API — نفس دوال Vercel */
    let m;
    if (p === '/api/jobs') return await jobsIndex(req, res);
    if ((m = p.match(/^\/api\/jobs\/([^/]+)\/process$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobsProcess(req, res);
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)\/video$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobsVideo(req, res);
    }
    if ((m = p.match(/^\/api\/jobs\/([^/]+)$/))) {
      req.query.id = decodeURIComponent(m[1]);
      return await jobIdRoute(req, res);
    }
    if (p === '/api/upload') return await uploadRoute(req, res);
    if (p === '/api/config') return await configRoute(req, res);
    if (p === '/api/cron') return await cronRoute(req, res);

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'المسار غير موجود' }));
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.destroy();
    }
  }
});

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 3000;
  server.listen(port, () => {
    console.log('──────────────────────────────────────────────');
    console.log(`  ▶ خادم الدمج المحلي يعمل: http://localhost:${port}`);
    console.log(`  ▶ الواجهة:        http://localhost:${port}/`);
    console.log(`  ▶ فحص الحدود:     http://localhost:${port}/api/config`);
    console.log('──────────────────────────────────────────────');
  });
}

module.exports = { server };
