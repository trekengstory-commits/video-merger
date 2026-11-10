# مُدمج الفيديوهات — Video Merger API v2

موقع كامل لدمج الفيديوهات + واجهة برمجية عامة (API) للمطورين، جاهز للنشر على **Vercel** — بلا إطار عمل وبلا خطوة بناء.

- **واجهة عربية RTL** بثيم داكن حديث: إضافة روابط، سحب وإفلات ملفات، ترتيب المصادر بالسحب، شريط تقدم حقيقي، مشغل ناتج مع عدّاد صلاحية 24 ساعة، وتوثيق API مدمج.
- **محرك دمج ffmpeg** عالي الجودة: توحيد الدقات (scale+pad لأكبر دقة حتى 1920×1080)، ‏fps=30، مسار صامت تلقائي للمصادر بلا صوت، ترميز **libx264 CRF 18 + AAC 192k + +faststart**.
- **كل شيء في قاعدة Turso**: المهام، أجزاء الملفات، والفيديو الناتج (Blobs 2MB) — لا S3 ولا أي خدمة خارجية، ولا ملف واحد على قرص الخادم (‏`/tmp` فقط أثناء المعالجة).
- **بث فيديو بدعم Range (206)** — تقديم/ترجيع فوري في المشغل.
- **حذف تلقائي بعد 24 ساعة**: تنظيف كسول عند كل طلب + Cron يومي.

---

## البنية التقنية

| الطبقة | التقنية |
|---|---|
| الخادم | دوال Vercel Serverless — Node.js خالص (CommonJS) |
| الواجهة | ملف واحد `public/index.html` (HTML + CSS + JS) |
| قاعدة البيانات | Turso (libSQL عبر `@libsql/client`) — Blobs 2MB لكل صف |
| الفيديو | `ffmpeg-static` + `ffprobe-static` داخل الدالة |
| الحدود | قابلة للضبط بمتغيرات البيئة (انظر الجدول أدناه) |

```
├── api/                 دوال Vercel (نقاط الـ API التسع)
│   ├── jobs/index.js    POST إنشاء مهمة | GET قائمة
│   ├── jobs/[id].js     GET حالة | DELETE حذف شامل
│   ├── jobs/[id]/process.js  POST تنفيذ الدمج (متزامن)
│   ├── jobs/[id]/video.js    GET بث الناتج (Range)
│   ├── upload.js        POST رفع أجزاء ≤4MB
│   ├── config.js        GET الحدود
│   └── cron.js          GET تنظيف المنتهية
├── lib/                 المنطق: db.js، storage.js، merge.js، limits.js، util.js، env.js
├── public/index.html    الواجهة كاملة
├── scripts/             خادم تطوير محلي + اختبارات (وحدة 29 + HTTP 58)
└── vercel.json          maxDuration=300 + cron يومي + ترويسات CORS
```

---

## التشغيل المحلي

```bash
bun install          # أو npm install
cp .env.example .env # ثم املأ متغيري Turso الحقيقيين
npm run dev          # http://localhost:3000
npm test             # اختبارات الوحدة + اختبارات HTTP (87 فحصًا)
```

خادم التطوير يحاكي Vercel تمامًا: يحلّل المسارات الديناميكية، يقدّم الواجهة، ويستدعي نفس دوال `api/` دون تعديل.

---

## النشر على Vercel — خطوة بخطوة

### 1) أنشئ قاعدة Turso واحصل على التوكن

```bash
# ثبّت CLI (مرة واحدة)
curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup            # أو turso auth login

# أنشئ القاعدة (الموقع الأقرب: فرانكفورت مناسب لـ Vercel EU)
turso db create video-merger --location fra

# احصل على القيمتين
turso db show video-merger --url        # ← TURSO_DATABASE_URL
turso db tokens create video-merger     # ← TURSO_AUTH_TOKEN
```

> يمكن أيضًا إنشاء القاعدة من الموقع [turso.tech](https://turso.tech) → Create Database → ثم Copy URL وCreate Token. الخطة المجانية تكفي تمامًا (500 قاعدة، 9GB تخزين، 500 مليون صف قراءة شهريًا).

### 2) اربط المستودع على Vercel

1. ادخل **vercel.com** → **Add New… → Project** → **Import** المستودع.
2. Framework Preset: اختر **Other** (لا يوجد Next.js هنا — Node.js خالص).
3. لا تغيّر Build Command ولا Output Directory (لا يوجد بناء).

### 3) أضف متغيرات البيئة

في صفحة الاستيراد → **Environment Variables** (أو لاحقًا Settings → Environment Variables):

| المتغير | إلزامي | القيمة |
|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | `libsql://video-merger-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | ✅ | التوكن من `turso db tokens create` |
| `MAX_SOURCES` | — | `10` (الافتراضي) |
| `SOURCE_MAX_MB` | — | `200` |
| `OUTPUT_MAX_MB` | — | `150` |
| `MAX_TOTAL_DURATION_SEC` | — | `600` |
| `FFMPEG_PRESET` | — | `medium` (أسرع: `veryfast`/`faster`) |

4. اضغط **Deploy** — سيكتمل خلال ثوانٍ (لا خطوة بناء).
5. اختبر فورًا: افتح `https://<project>.vercel.app/api/config` — يجب أن ترى JSON الحدود.

> **ملاحظة**: `vercel.json` يضبط `maxDuration: 300` لكل الدوال (يعمل على خطة Hobby مع Fluid compute) ويجدول `GET /api/cron` يوميًا للتنظيف. ثنائيات ffmpeg تُضمَّن تلقائيًا عبر `includeFiles`.

---

## توثيق API

عام بلا تسجيل دخول، CORS مفتوح، والأخطاء دائمًا بصيغة `{"error":"رسالة عربية"}`.
الرموز: **400** مدخلات تالفة · **404** غير موجود · **409** حالة غير مناسبة · **413** تجاوز حجم · **405** طريقة خاطئة · **416** مدى Range غير صالح.

### `POST /api/jobs` — إنشاء مهمة

يقبل إما روابط جاهزة أو مصفوفة مصادر مختلطة:

```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/a.mp4","https://example.com/b.mp4"]}'
```

```json
{
  "sources": [
    {"kind": "url", "url": "https://example.com/a.mp4"},
    {"kind": "file", "name": "clip.mp4", "size": 10485760, "mime": "video/mp4"}
  ]
}
```

**استجابة 201:**

```json
{
  "jobId": "jmwbbsme9y5lfsbdu",
  "status": "uploading",
  "statusUrl": "https://<domain>/api/jobs/jmwbbsme9y5lfsbdu",
  "processUrl": "https://<domain>/api/jobs/jmwbbsme9y5lfsbdu/process",
  "expiresAt": "2026-11-11T23:30:00.000Z",
  "uploadChunkBytes": 4194304,
  "uploads": [
    {"seq": 1, "name": "clip.mp4", "size": 10485760,
     "uploadUrl": "https://<domain>/api/upload?job=jmwbbsme9y5lfsbdu&seq=1",
     "receivedBytes": 0}
  ]
}
```

- لا ملفات → `"status": "queued"` بلا حقل uploads.
- `GET /api/jobs` → `{"jobs":[{jobId,status,progress,createdAt,expiresAt,hasResult}]}` (آخر 50).

### `POST /api/upload?job=<id>&seq=<n>&chunk=<k>` — رفع أجزاء

جسم ثنائي خام ≤4MB (`Content-Type: application/octet-stream`)، الأجزاء بأي ترتيب، وإعادة رفع نفس الجزء تعوّض بدل التكرار:

```bash
curl -X POST "https://<domain>/api/upload?job=<id>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @part0.bin
```

```json
{"ok": true, "job": "<id>", "seq": 1, "chunk": 0, "receivedBytes": 4194304, "size": 10485760, "complete": false}
```

### `POST /api/jobs/<id>/process` — تنفيذ الدمج (متزامن)

ينزّل/يسحب المصادر ← يوحّد الدقات ← يرمّز ← يخزّن الناتج، ويرجع مباشرة:

```bash
curl -X POST https://<domain>/api/jobs/<id>/process
```

**استجابة 200 عند النجاح:**

```json
{
  "status": "done",
  "videoUrl": "https://<domain>/api/jobs/<id>/video",
  "downloadUrl": "https://<domain>/api/jobs/<id>/video?download=1",
  "size": 321583,
  "duration": 5.04,
  "resolution": "1280x720",
  "expiresAt": "2026-11-11T23:30:00.000Z"
}
```

- المهمة قيد المعالجة فعلًا → **202** `{"status":"processing","statusUrl":…}`.
- فشل (حد متجاوز/مصدر تالف) → **400/500** مع `{"error":…}` وتصبح المهمة `failed` (قابلة لإعادة المحاولة بنفس النقطة).
- مهمة `done` مرة أخرى → تعيد نفس النتيجة دون إعادة ترميز.

**خريطة التقدم** (تُتابع عبر `GET /api/jobs/<id>`): ‏0–40 تجهيز المصادر · 40–90 ترميز ffmpeg (من `out_time_us`) · 95 تخزين · 100 اكتمال.

### `GET /api/jobs/<id>` — الحالة

```json
{
  "jobId": "<id>", "status": "done", "progress": 100, "error": null,
  "createdAt": "…", "updatedAt": "…", "expiresAt": "…", "remainingSeconds": 86380,
  "sources": [{"seq": 0, "kind": "url", "url": "…", "receivedBytes": 0}],
  "result": {"videoUrl": "…", "downloadUrl": "…?download=1", "size": 321583, "duration": 5.04, "resolution": "1280x720"}
}
```

الحالات: `queued` → (`uploading`) → `processing` → `done` | `failed`.

### `GET /api/jobs/<id>/video` — بث الناتج

بث تدفقياً من صفوف القاعدة مع **Range (206 + Content-Range)**:

```bash
curl -OJ "https://<domain>/api/jobs/<id>/video?download=1"
```

- `Range: bytes=0-99` → 206 مع `Content-Range: bytes 0-99/321583`.
- `?download=1` → ترويسة `Content-Disposition: attachment`.
- مدى غير صالح → **416**.

### `DELETE /api/jobs/<id>` — حذف فوري شامل

يحذف كل صفوف المهمة (jobs + sources + source_chunks + output_chunks) في batch واحد → `{"deleted":true,"jobId":"…"}`.

### `GET /api/config` — الحدود العامة

```json
{"version":"1.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,
 "maxTotalDurationSec":600,"uploadChunkBytes":4194304,"storageChunkBytes":2097152,
 "expiresHours":24,"ffmpegPreset":"medium",
 "allowedExtensions":["mp4","mov","webm","mkv","avi","m4v","mpg","3gp"]}
```

### `GET /api/cron` — التنظيف اليومي

حذف كل المهام المنتهية → `{"ok":true,"deleted":3,"at":"…"}` — مجدول تلقائيًا في `vercel.json` (03:00 UTC يوميًا) ويُنفَّذ كسولًا أيضًا عند كل إنشاء/دمج.

---

## كيف يعمل التخزين

- كل Blob (مصدر أو ناتج) يُقسَّم إلى صفوف **2MB** في جدول منفصل بمفتاح أساسي مركب `(job_id, seq, chunk)` — تحت حد HTTP في Turso.
- القراءة **تدفقية بصفحات 8 صفوف** مع تقليم أول/آخر جزء حسب مدى Range المطلوب — بث فيديو كامل دون تحميل الذاكرة.
- الكتابة تدفقيًا أيضًا (batch ≤ 2 صفًا لكل طلب HTTP نحو Turso).
- بعد نجاح الدمج تُحذف `source_chunks` فورًا — الناتج فقط هو المطلوب.
- `expires_at = created_at + 24h` — تنظيف كسول + Cron يومي.
- `/tmp` فقط أثناء المعالجة ويُنظَّف في `finally`.

## حدود الخطة المجانية التي يجب معرفتها

| الحد | القيمة | الأثر |
|---|---|---|
| مدة الدالة (Hobby + Fluid) | 300 ثانية | يكفي ≈ 8–10 دقائق فيديو خام للترميز |
| حجم طلب Vercel | ≈ 4.5MB | لذلك الرفع أجزاء 4MB مع إعادة محاولة ×3 |
| ذاكرة الدالة | 1GB (قابلة للرفع) | الترميز 1080p يعمل ضمنها |
| حجم قاعدة Turso المجانية | 9GB | ≈ 60 فيديو ناتج بحجم 150MB |
| صفوف Turso المجانية | 500 مليون قراءة/1 مليون كتابة شهريًا | كل 1MB ≈ نصف صف كتابة |
| عدد Cron jobs (Hobby) | يوميًا ×1 | يكفي مهمة واحدة للتنظيف |

## ربطها بمشروع MCP Media Generator

هذه الخدمة هي «Video Merger API v2» التي تناديها أداة `merge_videos` في مشروع MCP. بعد نشرها ضع عنوانها في متغير البيئة:

```
MERGER_API_BASE=https://<your-merger-project>.vercel.app
```

ثم Redeploy لمشروع MCP — وسيعرض `/api/health` هناك `merger.healthy: true`.

## الأمان

- `.env` في `.gitignore` منذ أول commit — لا أسرار في المستودع (ملف `.env.example` بلا قيم حقيقية).
- لا ترويسات مصادقة مطلوبة — الخدمة عامة بطبيعتها؛ إن أردت تقييد الاستخدام ضع Vercel WAF/Rate limiting أمامها.

## الاختبارات

```bash
npm test        # 29 اختبار وحدة + 58 اختبار HTTP = 87 فحصًا
```

- **الوحدة**: توليد فيديوهين مختلفي الدقة بـ ffmpeg ودمجهما فعليًا (الدقة=الأكبر، المدة=المجموع، الصوت موجود)، مسار المصدر الصامت، تخزين Turso بتطابق sha256، Range عبر حدود الصفوف، رفع الأجزاء، الحذف الشامل، التنظيف الكسول، حدود التنزيل.
- **HTTP**: دورة كاملة من روابط → دمج → بث (200/206/416) → مهمة مختلطة (رابط+ملف) → رفع متعدد الأجزاء >4MB → الحذف → 404 → JSON تالف → حدود المصادر → 405 → cron → القائمة.
