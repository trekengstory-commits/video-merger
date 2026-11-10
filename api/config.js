'use strict';
/** GET /api/config — الحدود العامة + version */
const { applyCors, sendJson, sendError } = require('../lib/util');
const {
  MAX_SOURCES,
  SOURCE_MAX_MB,
  OUTPUT_MAX_MB,
  MAX_TOTAL_DURATION_SEC,
  FFMPEG_PRESET,
  CHUNK_BYTES,
  UPLOAD_CHUNK_BYTES,
  EXPIRES_HOURS,
  VERSION,
} = require('../lib/limits');

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') return sendError(res, 405, 'طريقة غير مدعومة — استخدم GET');
  return sendJson(res, 200, {
    version: VERSION,
    maxSources: MAX_SOURCES,
    sourceMaxMB: SOURCE_MAX_MB,
    outputMaxMB: OUTPUT_MAX_MB,
    maxTotalDurationSec: MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: UPLOAD_CHUNK_BYTES,
    storageChunkBytes: CHUNK_BYTES,
    expiresHours: EXPIRES_HOURS,
    ffmpegPreset: FFMPEG_PRESET,
    allowedExtensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'mpg', '3gp'],
  });
};
