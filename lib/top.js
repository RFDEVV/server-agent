/**
 * lib/top.js
 * Proses terberat (CPU / RAM) — realtime ringan, dan direktori terbesar di
 * disk (dihitung di background, di-cache karena `du` tidak bisa realtime).
 */
const si = require('systeminformation');
const { execFile } = require('child_process');

let procCache = { at: 0, data: null };
const PROC_TTL_MS = 2500;       // beberapa client/polling tidak membebani server

async function topProcesses(limit = 5) {
  const now = Date.now();
  if (procCache.data && now - procCache.at < PROC_TTL_MS) return procCache.data;

  const p = await si.processes();
  const list = (p.list || []).filter(x => x.name && x.pid);
  const slim = (x) => ({
    pid: x.pid,
    name: String(x.name).slice(0, 28),
    cpu: +(x.cpu || 0).toFixed(1),
    memMB: Math.round((x.memRss || 0) / 1024),    // systeminformation: memRss dalam KB
    memPct: +(x.mem || 0).toFixed(1),
  });
  const byCpu = [...list].sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, limit).map(slim);
  const byMem = [...list].sort((a, b) => (b.memRss || 0) - (a.memRss || 0)).slice(0, limit).map(slim);
  const data = { byCpu, byMem, total: p.all || list.length, running: p.running || 0 };
  procCache = { at: now, data };
  return data;
}

// ─── Direktori terbesar (di-cache, dihitung di background) ───────────────────
let dirs = { updatedAt: 0, computing: false, items: [], error: null };
const DIR_REFRESH_MS = 10 * 60 * 1000;

function refreshBiggestDirs() {
  if (dirs.computing) return;
  dirs.computing = true;
  // nice supaya tidak mengganggu service lain; -x = tetap di satu filesystem
  execFile('nice', ['-n', '19', 'du', '-x', '-B1', '--max-depth=1', '/'],
    { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      // du keluar non-zero walau sebagian berhasil (permission denied) → tetap pakai stdout
      const rows = String(stdout || '').split('\n').map(l => {
        const m = l.match(/^(\d+)\s+(\/.*)$/);
        return m ? { path: m[2], bytes: Number(m[1]) } : null;
      }).filter(Boolean);
      const root = rows.find(r => r.path === '/');
      const items = rows.filter(r => r.path !== '/').sort((a, b) => b.bytes - a.bytes).slice(0, 6)
        .map(r => ({ path: r.path, gb: +(r.bytes / 1073741824).toFixed(2) }));
      dirs = {
        updatedAt: Date.now(), computing: false, items,
        totalGB: root ? +(root.bytes / 1073741824).toFixed(2) : null,
        error: items.length === 0 && err ? String(err.message || err).slice(0, 120) : null,
      };
    });
}

function getBiggestDirs() { return dirs; }
function start() {
  setTimeout(refreshBiggestDirs, 20_000);
  setInterval(refreshBiggestDirs, DIR_REFRESH_MS).unref?.();
}

module.exports = { topProcesses, getBiggestDirs, refreshBiggestDirs, start };
