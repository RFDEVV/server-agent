/**
 * lib/logger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Ring-buffer log server secara langsung (real, bukan dummy) dengan cara
 * "menangkap" semua console.log / console.warn / console.error yang terjadi
 * di proses agent ini sejak boot. Dipakai oleh GET /logs — endpoint umum
 * tanpa perlu izin PM2 allowlist, cukup JWT standar seperti endpoint lain.
 */

const MAX_LINES = 5000;
const buffer = [];
let total = 0;   // jumlah baris yang pernah masuk (monoton naik) — dipakai sebagai cursor

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch (_) { return String(arg); }
}

function push(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args.map(fmt).join(' ')}`;
  buffer.push(line);
  total++;
  if (buffer.length > MAX_LINES) buffer.shift();
}

let attached = false;
function attach() {
  if (attached) return;
  attached = true;

  const origLog  = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origErr  = console.error.bind(console);

  console.log = (...args) => { push('INFO', args); origLog(...args); };
  console.warn = (...args) => { push('WARN', args); origWarn(...args); };
  console.error = (...args) => { push('ERROR', args); origErr(...args); };

  process.on('uncaughtException', (err) => push('FATAL', [err]));
  process.on('unhandledRejection', (err) => push('FATAL', [err]));
}

function getLogs(lines = 200) {
  const n = Math.max(1, Math.min(lines, MAX_LINES));
  return buffer.slice(-n).join('\n');
}

/** Hapus semua log yang tersimpan di buffer (dipanggil dari DELETE /logs). */
function clear() {
  buffer.length = 0;
  push('INFO', ['[logger] log dibersihkan oleh user']);
}

/**
 * Ambil baris BARU sejak cursor. Tanpa cursor → `initial` baris terakhir.
 * Return { lines, cursor, reset }.  reset=true bila cursor tidak valid
 * (agent restart) sehingga klien harus mengganti isi tampilannya.
 */
function getSince(cursor, initial = 200) {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { lines: buffer.slice(-Math.min(initial, buffer.length)), cursor: String(total), reset: true };
  }
  const c = Number(cursor);
  if (!Number.isFinite(c) || c > total) {
    return { lines: buffer.slice(-Math.min(initial, buffer.length)), cursor: String(total), reset: true };
  }
  const n = Math.min(total - c, buffer.length);
  return { lines: n > 0 ? buffer.slice(-n) : [], cursor: String(total), reset: false };
}

module.exports = { attach, getLogs, getSince, clear };
