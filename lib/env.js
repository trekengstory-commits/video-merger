'use strict';
/**
 * تحميل .env يدويًا — يحاكي سلوك Vercel المحلي دون أي اعتمادية خارجية.
 * لا يُغطي قيمة موجودة مسبقًا في process.env (بيئة Vercel لها الأولوية).
 */
const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  try {
    const p = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined || process.env[m[1]] === '') {
        process.env[m[1]] = v;
      }
    }
  } catch {
    // تجاهل — البيئة ستوفر المتغيرات على Vercel
  }
}

loadEnvFile();
module.exports = { loadEnvFile };
