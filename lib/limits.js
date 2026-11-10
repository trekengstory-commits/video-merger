'use strict';
require('./env');

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const MB = 1024 * 1024;

module.exports = {
  MB,
  /** حد عدد المصادر في المهمة الواحدة */
  MAX_SOURCES: intEnv('MAX_SOURCES', 10),
  /** الحد الأقصى لحجم كل مصدر */
  SOURCE_MAX_MB: intEnv('SOURCE_MAX_MB', 200),
  /** الحد الأقصى لحجم الفيديو الناتج */
  OUTPUT_MAX_MB: intEnv('OUTPUT_MAX_MB', 150),
  /** الحد الأقصى لمجموع مدد المصادر (ثانية) */
  MAX_TOTAL_DURATION_SEC: intEnv('MAX_TOTAL_DURATION_SEC', 600),
  /** preset الترميز libx264 */
  FFMPEG_PRESET: (process.env.FFMPEG_PRESET || 'medium').trim(),
  /** حجم صف Blob في Turso (2MB — حد HTTP الآمن) */
  CHUNK_BYTES: 2 * MB,
  /** حجم جزء الرفع الواحد من الواجهة (4MB — دون حد ~4.5MB في Vercel) */
  UPLOAD_CHUNK_BYTES: 4 * MB,
  /** صفحات قراءة الـ Blobs من القاعدة */
  READ_PAGE_ROWS: 8,
  /** مدة الصلاحية بالساعات — تُحذف المهام بعدها */
  EXPIRES_HOURS: 24,
  VERSION: '1.0.0',
};
