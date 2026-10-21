/**
 * lib/power.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mengukur konsumsi daya dengan `sudo powerstat -R 1 1` (RAPL-based).
 * Fallback otomatis ke estimasi CPU-load jika powerstat tidak tersedia,
 * tidak ada akses RAPL, atau hardware tidak mendukung (ARM/STB).
 *
 * SETUP (jalankan sekali di server):
 *   sudo apt install powerstat
 *   echo "rfuser ALL=(ALL) NOPASSWD: /usr/bin/powerstat" | sudo tee /etc/sudoers.d/rfmonitor
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA_FILE          = path.join(__dirname, '..', 'data', 'power-log.json');
const SAMPLE_INTERVAL_MS = 20_000;   // powerstat -R 1 3 butuh ~4 dtk; jangan terlalu sering

let state = { daily: {}, hourly: {}, lastSample: { watts: null, timestamp: null, source: 'none' } };
let lastAccumulatedAt = Date.now();

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Validasi struktur minimal
    state = {
      daily:      (parsed && typeof parsed.daily === 'object') ? parsed.daily : {},
      hourly:     (parsed && typeof parsed.hourly === 'object') ? parsed.hourly : {},
      lastSample: (parsed && parsed.lastSample) ? parsed.lastSample : { watts: null, timestamp: null, source: 'none' },
    };
  } catch (_) {
    state = { daily: {}, hourly: {}, lastSample: { watts: null, timestamp: null, source: 'none' } };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[power] save error:', err.message);
  }
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayKey() {
  return localDate(); // YYYY-MM-DD tanggal LOKAL server
}

function hourKey(date = new Date()) {
  // "YYYY-MM-DD-HH" — dipakai untuk breakdown per jam hari ini
  return `${localDate(date)}-${String(date.getHours()).padStart(2, '0')}`;
}

// ─── Powerstat measurement ────────────────────────────────────────────────────
/**
 * Parse output powerstat → rata-rata watt, atau null.
 * Urutan: baris "Summary: System: X Watts on average" → baris "Average" (kolom
 * Watts = kolom terakhir) → null. (Sebelumnya mengambil token terakhir baris
 * terakhir = standar deviasi / nilai Maximum, bukan rata-rata.)
 */
function parsePowerstat(text) {
  const t = String(text || '');
  const sys = t.match(/System:\s+([\d.]+)\s+Watts\s+on\s+average/i);
  if (sys) { const w = parseFloat(sys[1]); if (Number.isFinite(w) && w > 0) return w; }

  const avg = t.split('\n').find(l => /^\s*Average\b/i.test(l));
  if (avg) {
    const parts = avg.trim().split(/\s+/);
    const w = parseFloat(parts[parts.length - 1]);
    if (Number.isFinite(w) && w > 0 && w < 2000) return w;
  }
  const mean = t.match(/Mean:\s+([\d.]+)\s+Watts/i);
  if (mean) { const w = parseFloat(mean[1]); if (Number.isFinite(w) && w > 0) return w; }
  return null;
}

/**
 * sudo powerstat -d 0 -R 1 3
 *   -d 0 : mulai langsung (default powerstat menunggu dulu → timeout → jatuh ke estimasi)
 *   -R   : baca RAPL (daya CPU/package nyata dari hardware)
 *   1 3  : 3 sampel @1 dtk, dirata-rata (lebih stabil daripada 1 sampel)
 * Butuh sudoers: rfuser ALL=(ALL) NOPASSWD: /usr/bin/powerstat
 */
function measurePowerstat() {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', 'powerstat', '-d', '0', '-R', '1', '3'], { timeout: 15_000 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);   // tanpa RAPL / tanpa sudo → senyap
      resolve(parsePowerstat(stdout));
    });
  });
}

// ─── Power meter eksternal (opsional): colokan pintar Shelly / Tasmota / JSON ─
// Untuk server tanpa RAPL (ARM/STB, AMD lama) — ini satu-satunya cara ukur NYATA
// konsumsi seluruh perangkat (termasuk adaptor), bukan estimasi.
//   POWER_METER_URL=http://192.168.1.50/rpc/Switch.GetStatus?id=0
//   POWER_METER_TYPE=shelly | shelly1 | tasmota | json
//   POWER_METER_JSON_PATH=apower      (untuk type=json, path bertitik)
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (_) { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}
function dig(obj, path) { return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

async function measureExternalMeter() {
  const url = process.env.POWER_METER_URL;
  if (!url) return null;
  const type = (process.env.POWER_METER_TYPE || 'json').toLowerCase();
  const j = await httpGetJson(url);
  if (!j) return null;
  let w;
  if (type === 'shelly')       w = j.apower;                         // Gen2/Plus
  else if (type === 'shelly1') w = j.meters && j.meters[0] && j.meters[0].power;   // Gen1
  else if (type === 'tasmota') w = dig(j, 'StatusSNS.ENERGY.Power');
  else                         w = dig(j, process.env.POWER_METER_JSON_PATH || 'power');
  w = Number(w);
  return Number.isFinite(w) && w >= 0 && w < 5000 ? { watts: w, source: `meter:${type}` } : null;
}

// ─── Fallback estimasi berbasis CPU load ──────────────────────────────────────
function estimateWatts(cpuPercent, idleWatt, maxExtraWatt) {
  return idleWatt + (maxExtraWatt * Math.max(0, Math.min(100, cpuPercent))) / 100;
}

// ─── Sampling loop ────────────────────────────────────────────────────────────
async function sampleAndAccumulate({ cpuUsagePercent, idleWatt, maxExtraWatt }) {
  let watts  = null;
  let source = 'powerstat';

  const ext = await measureExternalMeter();
  if (ext) { watts = ext.watts; source = ext.source; }
  if (watts == null) watts = await measurePowerstat();

  if (watts == null) {
    watts  = estimateWatts(cpuUsagePercent, idleWatt, maxExtraWatt);
    source = 'estimate';
  }

  // Pastikan nilai masuk akal (0–2000 W)
  if (!Number.isFinite(watts) || watts < 0 || watts > 5000) {
    watts  = estimateWatts(cpuUsagePercent, idleWatt, maxExtraWatt);
    source = 'estimate';
  }

  const now          = Date.now();
  const hoursElapsed = (now - lastAccumulatedAt) / 3_600_000;
  lastAccumulatedAt  = now;

  const key     = todayKey();
  const kwhAdded = (watts * hoursElapsed) / 1000;
  state.daily[key] = +((state.daily[key] || 0) + kwhAdded).toFixed(6);

  const hKey = hourKey(new Date(now));
  state.hourly[hKey] = +((state.hourly[hKey] || 0) + kwhAdded).toFixed(6);

  state.lastSample  = { watts: +watts.toFixed(2), timestamp: now, source };

  // Pruning — simpan max 400 hari, max 240 jam (10 hari) untuk hourly
  const keys = Object.keys(state.daily).sort();
  if (keys.length > 400) {
    keys.slice(0, keys.length - 400).forEach(k => delete state.daily[k]);
  }
  const hKeys = Object.keys(state.hourly).sort();
  if (hKeys.length > 240) {
    hKeys.slice(0, hKeys.length - 240).forEach(k => delete state.hourly[k]);
  }

  saveState();
}

// ─── Public API ───────────────────────────────────────────────────────────────
function startSampler(getCpuUsage, idleWatt = 30, maxExtraWatt = 90) {
  loadState();
  lastAccumulatedAt = Date.now();

  const tick = () => sampleAndAccumulate({
    cpuUsagePercent: getCpuUsage(),
    idleWatt,
    maxExtraWatt,
  }).catch(err => console.error('[power] sample error:', err.message));

  setTimeout(tick, 3_000);                 // sampel pertama cepat → UI tidak kosong 20 detik
  setInterval(tick, SAMPLE_INTERVAL_MS);
}

function getLastSample() {
  return state.lastSample || { watts: null, timestamp: null, source: 'none' };
}

function sumRange(fromKey, toKey) {
  return Object.entries(state.daily)
    .filter(([k]) => k >= fromKey && k <= toKey)
    .reduce((sum, [, v]) => sum + (v || 0), 0);
}

function sumSinceDays(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const today     = todayKey();
  return sumRange(cutoffKey, today);
}

function getTodayKwh()  { return state.daily[todayKey()] || 0; }
function getWeekKwh()   { return sumSinceDays(7); }
function getMonthKwh()  {
  const ym = todayKey().slice(0, 7);
  return Object.entries(state.daily)
    .filter(([k]) => k.startsWith(ym))
    .reduce((s, [, v]) => s + (v || 0), 0);
}
function getYearKwh()   { return sumSinceDays(365); }

function getDailyHistory(days = 30) {
  const keys = Object.keys(state.daily).sort().slice(-days);
  return keys.map(k => ({ date: k, kwh: +(state.daily[k] || 0) }));
}

/**
 * Histori 24 jam HARI INI, format { h: "00:00", kwh }.
 * Jam yang belum berjalan (belum ada sample) tetap muncul dengan kwh: 0
 * supaya chart di Flutter tidak "bolong".
 */
function getHourlyHistory() {
  const today = todayKey();
  const out = [];
  for (let h = 0; h < 24; h++) {
    const hh  = String(h).padStart(2, '0');
    const key = `${today}-${hh}`;
    out.push({ h: `${hh}:00`, kwh: +(state.hourly[key] || 0) });
  }
  return out;
}

module.exports = {
  parsePowerstat,
  startSampler,
  getLastSample,
  getTodayKwh,
  getWeekKwh,
  getMonthKwh,
  getYearKwh,
  getDailyHistory,
  getHourlyHistory,
};
