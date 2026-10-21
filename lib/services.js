/**
 * lib/services.js
 * PM2 + Docker + systemd — list, control, logs.
 * Log response: { out, error, output } — kompatibel dengan Flutter client.
 */

const { execFile } = require('child_process');
const os   = require('os');
const fs   = require('fs');
const path = require('path');
const pm2lib = require('pm2');
const { ALLOWED_PM2_APPS } = require('../utils/commandWhitelist');

const ALLOWED_DOCKER  = (process.env.ALLOWED_DOCKER_CONTAINERS || '*').trim();
const ALLOWED_SYSTEMD = (process.env.ALLOWED_SYSTEMD_SERVICES || '')
  .split(',').map(s => s.trim()).filter(Boolean);

// ─── exec helper ─────────────────────────────────────────────────────────────
function execP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10_000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout || '');
    });
  });
}

function execSoft(cmd, args, opts = {}) {
  // Seperti execP tapi tidak reject — return '' jika gagal
  return execP(cmd, args, opts).catch(() => '');
}

// ─── PM2 ─────────────────────────────────────────────────────────────────────
function withPm2(fn, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    const timer = setTimeout(() => {
      finish(new Error(`PM2 request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (connected) pm2lib.disconnect();
      if (err) reject(err);
      else resolve(result);
    };

    pm2lib.connect((err) => {
      if (settled) return;
      if (err) return finish(err);
      connected = true;
      try {
        fn((err2, result) => finish(err2, result));
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function listPm2() {
  const list = await withPm2(cb => pm2lib.list(cb));
  return list.map(p => {
    const env = p.pm2_env || {};
    const monit = p.monit || {};
    return {
      type: 'pm2',
      name: p.name,
      status: env.status || 'unknown',
      cpuPercent: Number.isFinite(monit.cpu) ? monit.cpu : 0,
      memoryMB: +((Number(monit.memory) || 0) / 1e6).toFixed(1),
      uptimeMs: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
      restarts: env.restart_time || 0,
      controllable: ALLOWED_PM2_APPS.includes(p.name),
    };
  });
}

// ─── Docker ──────────────────────────────────────────────────────────────────
async function listDocker() {
  const out = await execP(
    'docker',
    ['ps', '-a', '--format', '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return out.trim().split('\n').filter(Boolean).map(line => {
    const [name, state, status, image] = line.split('|');
    return {
      type: 'docker',
      name,
      status: state === 'running' ? 'online' : state === 'exited' ? 'stopped' : (state || 'unknown'),
      detail: status,
      image,
      controllable: dockerAllowed(name),
    };
  });
}

// ─── systemd ─────────────────────────────────────────────────────────────────
// Auto-detect SEMUA service unit yang sedang berjalan/gagal di sistem —
// tidak dibatasi hanya yang ada di ALLOWED_SYSTEMD. Allowlist tetap dipakai
// untuk membatasi AKSI kontrol (lihat control()), bukan untuk visibility.
async function listSystemd() {
  const out = await execP('systemctl', [
    'list-units', '--type=service', '--all', '--no-legend', '--no-pager',
    '--plain', '--state=running,failed,exited,active',
  ], { maxBuffer: 8 * 1024 * 1024 });
  const seen = new Set();
  const result = [];

  for (const raw of out.trim().split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const unit = parts[0];
    if (!unit.endsWith('.service')) continue;
    const name = unit.replace(/\.service$/, '');
    if (seen.has(name)) continue;
    seen.add(name);

    const active = parts[2]; // active | inactive | failed
    const sub = parts[3]; // running | dead | exited | failed

    result.push({
      type: 'systemd',
      name,
      status: active === 'active' ? 'online' : active === 'failed' ? 'errored' : 'stopped',
      detail: sub,
      controllable: ALLOWED_SYSTEMD.includes(name),
    });
  }

  // Include configured units even when they are currently inactive.
  for (const name of ALLOWED_SYSTEMD) {
    if (seen.has(name)) continue;
    result.push({ type: 'systemd', name, status: 'unknown', detail: '', controllable: true });
  }

  return result;
}

async function listAll() {
  const providers = [
    ['pm2', listPm2],
    ['docker', listDocker],
    ['systemd', listSystemd],
  ];
  const results = await Promise.allSettled(
    providers.map(([, list]) => list()),
  );
  const services = [];
  const errors = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      services.push(...result.value);
      return;
    }
    const message = result.reason?.message || String(result.reason);
    errors.push(`${providers[index][0]}: ${message}`);
    console.error(`[services] ${providers[index][0]} discovery failed: ${message}`);
  });

  if (errors.length === providers.length) {
    throw new Error(`Service discovery failed (${errors.join('; ')})`);
  }
  return services;
}

// ─── Control ──────────────────────────────────────────────────────────────────
function dockerAllowed(name) {
  return ALLOWED_DOCKER === '*' || ALLOWED_DOCKER.split(',').map(s => s.trim()).includes(name);
}

async function control(type, name, action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Action not allowed');

  if (type === 'pm2') {
    if (!ALLOWED_PM2_APPS.includes(name)) throw new Error('App not in PM2 allowlist');
    await withPm2(cb => pm2lib[action](name, cb));
    return;
  }
  if (type === 'docker') {
    if (!dockerAllowed(name)) throw new Error('Container not in allowlist');
    await execP('docker', [action, name]);
    return;
  }
  if (type === 'systemd') {
    if (!ALLOWED_SYSTEMD.includes(name)) throw new Error('Service not in allowlist');
    await execP('sudo', ['systemctl', action, name]);
    return;
  }
  throw new Error('Unknown service type');
}

// ─── Logs — VIEW SELALU DIIZINKAN, tidak terikat allowlist ────────────────────
// Allowlist (ALLOWED_PM2_APPS / ALLOWED_DOCKER / ALLOWED_SYSTEMD) hanya
// membatasi AKSI kontrol (start/stop/restart) di control(), bukan untuk
// melihat log. User selalu boleh intip log apa pun yang terdeteksi di server.
function readTail(file, lines) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch (_) {
    return '';
  }
}

async function tailLogs(type, name, lines = 150) {
  if (type === 'pm2') {
    const logDir  = path.join(os.homedir(), '.pm2', 'logs');
    const outFile = path.join(logDir, `${name}-out.log`);
    const errFile = path.join(logDir, `${name}-error.log`);
    const out     = readTail(outFile, lines);
    const error   = readTail(errFile, lines);
    // key 'output' dipakai Flutter client, 'out'+'error' untuk detail
    return { out, error, output: [out, error].filter(Boolean).join('\n') };
  }

  if (type === 'docker') {
    const out = await execSoft('docker', ['logs', '--tail', String(lines), name]);
    return { out, error: '', output: out };
  }

  if (type === 'systemd') {
    const out = await execSoft('journalctl', ['-u', name, '-n', String(lines), '--no-pager']);
    return { out, error: '', output: out };
  }

  throw new Error('Unknown service type');
}

// ─── Log streaming inkremental (hemat kuota) + hapus log ─────────────────────
// Klien hanya meminta baris BARU sejak `cursor` — payload tiap polling hanya
// beberapa ratus byte, bukan 200 baris penuh berulang-ulang.
const clearedAt = new Map();            // key `${type}:${name}` -> epoch detik (docker/systemd)
const MAX_CHUNK = 128 * 1024;           // batas baca per polling (byte)

function pm2LogFiles(name) {
  const dir  = path.join(os.homedir(), '.pm2', 'logs');
  const safe = String(name || '').replace(/[^\w.\-]/g, '');   // cegah path traversal
  if (!safe) throw new Error('Nama app tidak valid');
  let out = path.join(dir, `${safe}-out.log`);
  let err = path.join(dir, `${safe}-error.log`);
  try {
    const files = fs.readdirSync(dir);
    if (!fs.existsSync(out)) { const f = files.find(x => x.startsWith(`${safe}-out`) && x.endsWith('.log')); if (f) out = path.join(dir, f); }
    if (!fs.existsSync(err)) { const f = files.find(x => x.startsWith(`${safe}-error`) && x.endsWith('.log')); if (f) err = path.join(dir, f); }
  } catch (_) { /* dir belum ada */ }
  return { out, err };
}

function sizeOf(file) { try { return fs.statSync(file).size; } catch (_) { return 0; } }

// Baca byte [from, size) maksimal MAX_CHUNK dari BELAKANG (selalu dapat yang terbaru).
// Hanya sampai baris LENGKAP terakhir (berakhir '\n') supaya baris yang sedang
// setengah ditulis tidak terpotong; `end` = offset byte setelah baris itu.
function readRange(file, from, size, dropPartialFirst = false) {
  if (size <= from) return { text: '', end: from };
  const start = Math.max(from, size - MAX_CHUNK);
  const len   = size - start;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let consumed = buf.lastIndexOf(0x0a) + 1;
    if (consumed === 0) consumed = len >= MAX_CHUNK ? len : 0;   // belum ada newline: tunggu
    let slice = buf.subarray(0, consumed);
    if ((dropPartialFirst || start > from) && start > 0) {        // awal terpotong di tengah baris
      const nl = slice.indexOf(0x0a);
      slice = nl >= 0 ? slice.subarray(nl + 1) : Buffer.alloc(0);
    }
    return { text: slice.toString('utf8'), end: start + consumed };
  } finally { fs.closeSync(fd); }
}

function splitLines(text) { return text.replace(/\r/g, '').split('\n').filter(l => l.length > 0); }

function execBoth(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (e, so, se) => resolve((so || '') + (se || '')));
  });
}

async function streamLogs(type, name, cursor, initial = 200) {
  const n = Math.min(Math.max(Number(initial) || 200, 20), 500);

  if (type === 'pm2') {
    const f  = pm2LogFiles(name);
    const so = sizeOf(f.out), se = sizeOf(f.err);
    let oo = 0, eo = 0, reset = true;
    if (cursor) {
      const [a, b] = String(cursor).split(':').map(Number);
      // file lebih kecil dari cursor = log dihapus/di-rotate → mulai ulang
      if (Number.isFinite(a) && Number.isFinite(b) && a <= so && b <= se) { oo = a; eo = b; reset = false; }
    }
    let outR, errR;
    if (reset) {
      outR = readRange(f.out, Math.max(0, so - 96 * 1024), so, true);
      errR = readRange(f.err, Math.max(0, se - 32 * 1024), se, true);
    } else {
      outR = readRange(f.out, oo, so);
      errR = readRange(f.err, eo, se);
    }
    let outLines = splitLines(outR.text);
    let errLines = splitLines(errR.text);
    if (reset) { outLines = outLines.slice(-n); errLines = errLines.slice(-Math.floor(n / 4)); }
    const lines = [...outLines, ...errLines.map(l => `[err] ${l}`)];
    return { lines, cursor: `${outR.end}:${errR.end}`, reset };
  }

  if (type === 'docker') {
    const floor = clearedAt.get(`docker:${name}`);
    const args  = ['logs', '--timestamps'];
    if (cursor)      args.push('--since', String(cursor));
    else if (floor)  args.push('--since', new Date(floor * 1000).toISOString());
    else             args.push('--tail', String(n));
    args.push(name);
    const raw = await execBoth('docker', args);
    let last = cursor ? String(cursor) : '';
    const out = [];
    for (const l of splitLines(raw)) {
      const sp = l.indexOf(' ');
      const ts = sp > 0 ? l.slice(0, sp) : '';
      if (/^\d{4}-\d{2}-\d{2}T/.test(ts)) {
        if (cursor && ts <= String(cursor)) continue;       // sudah pernah dikirim
        if (ts > last) last = ts;
        out.push(l.slice(sp + 1));
      } else out.push(l);
    }
    return { lines: out, cursor: last || new Date().toISOString(), reset: !cursor };
  }

  if (type === 'systemd') {
    const floor = clearedAt.get(`systemd:${name}`);
    const args  = ['-u', name, '--no-pager', '-o', 'short-iso', '--show-cursor'];
    if (cursor)      args.push(`--after-cursor=${cursor}`);
    else if (floor)  args.push('--since', new Date(floor * 1000).toISOString().replace('T', ' ').slice(0, 19));
    else             args.push('-n', String(n));
    const raw = await execBoth('journalctl', args);
    let newCursor = cursor || '';
    const out = [];
    for (const l of splitLines(raw)) {
      const m = l.match(/^-- cursor: (.+)$/);
      if (m) { newCursor = m[1]; continue; }
      if (l.startsWith('-- ')) continue;                     // "-- Logs begin at ..."
      out.push(l);
    }
    return { lines: out, cursor: newCursor, reset: !cursor };
  }

  throw new Error('Unknown service type');
}

async function clearLogs(type, name) {
  if (type === 'pm2') {
    const f = pm2LogFiles(name);
    // Kosongkan file log PM2 sungguhan (PM2 menulis O_APPEND → aman). Log lama
    // tidak akan muncul lagi; log baru lanjut dari nol.
    for (const file of [f.out, f.err]) { try { fs.truncateSync(file, 0); } catch (_) { /* belum ada */ } }
    return { truncated: true };
  }
  // Docker/journald tidak bisa dihapus tanpa root → pasang batas waktu:
  // hanya log SETELAH detik ini yang ditampilkan.
  clearedAt.set(`${type}:${name}`, Math.floor(Date.now() / 1000));
  return { truncated: false, marker: true };
}

module.exports = { withPm2, listAll, listPm2, listDocker, listSystemd, control, tailLogs, streamLogs, clearLogs };
