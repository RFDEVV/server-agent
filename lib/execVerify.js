/**
 * lib/execVerify.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Lapisan keamanan KEDUA khusus untuk fitur "ketik command langsung" (POST
 * /system/exec). JWT saja tidak cukup untuk fitur seberbahaya ini — kalau
 * token bocor, orang lain bisa jalankan command apa pun di server.
 *
 * Cara kerja:
 *  1. Klien coba /system/exec tanpa kode → server generate kode 6 digit acak,
 *     kode itu HANYA di-print ke console server (masuk ke GET /logs & pm2
 *     logs proses agent ini) — TIDAK PERNAH dikembalikan lewat response API.
 *  2. User buka log server (lewat SSH, atau lewat GET /logs di app ini yang
 *     memang sudah legal dia akses) untuk baca kodenya, lalu masukkan di app.
 *  3. Setelah kode benar dimasukkan sekali, sesi "terverifikasi" selama
 *     SESSION_TTL_MS (default 10 menit) — tidak perlu masukkan ulang tiap command.
 */

const crypto = require('crypto');

const CODE_TTL_MS    = 5 * 60 * 1000;   // kode berlaku 5 menit untuk dimasukkan
const SESSION_TTL_MS = 10 * 60 * 1000;  // setelah benar, sesi valid 10 menit

let activeCode     = null;
let codeExpiresAt  = 0;
let verifiedUntil  = 0;

function generateCode() {
  activeCode    = String(crypto.randomInt(100000, 999999));
  codeExpiresAt = Date.now() + CODE_TTL_MS;
  // Sengaja pakai console.log biasa — otomatis tertangkap logger.js (GET /logs)
  console.log(`[SECURITY] Kode verifikasi CMD EXEC: ${activeCode}  (berlaku ${CODE_TTL_MS / 60000} menit)`);
  return activeCode;
}

function isSessionVerified() {
  return Date.now() < verifiedUntil;
}

function verify(code) {
  if (!activeCode || Date.now() > codeExpiresAt) return false;
  if (String(code).trim() !== activeCode) return false;
  activeCode    = null;
  codeExpiresAt = 0;
  verifiedUntil = Date.now() + SESSION_TTL_MS;
  console.log('[SECURITY] Verifikasi CMD EXEC berhasil — sesi aktif 10 menit.');
  return true;
}

function remainingSessionMs() {
  return Math.max(0, verifiedUntil - Date.now());
}

module.exports = { generateCode, isSessionVerified, verify, remainingSessionMs };
