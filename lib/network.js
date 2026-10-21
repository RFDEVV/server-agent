/**
 * lib/network.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Penggunaan bandwidth dengan dua sumber:
 *
 * 1. vnstat (UTAMA) — akurasi tinggi, data persisten lintas restart
 *    Setup: sudo apt install vnstat && sudo systemctl enable --now vnstat
 *    Pastikan interface terdeteksi: vnstat --iflist
 *
 * 2. Internal sampler (FALLBACK) — akumulasi rx/tx dari systeminformation
 *    Aktif jika vnstat tidak tersedia.
 *
 * SETUP:
 *   sudo apt install vnstat
 *   sudo systemctl enable --now vnstat
 *   # Tunggu beberapa menit lalu cek: vnstat
 */

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const si   = require('systeminformation');

const DATA_FILE          = path.join(__dirname, '..', 'data', 'network-log.json');
const SAMPLE_INTERVAL_MS = 5_000;

let state           = { daily: {} };
let lastSampledAt   = Date.now();
let _detectedIface  = null;   // cache interface yang terdeteksi

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadState() {
  try {
    const raw    = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = { daily: (parsed && typeof parsed.daily === 'object') ? parsed.daily : {} };
  } catch (_) {
    state = { daily: {} };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('[network] save error:', err.message);
  }
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;   // tanggal LOKAL server — sama dengan yang dipakai vnstat
}
function todayKey() { return localDateKey(); }

// ─── Internal sampler (fallback) ─────────────────────────────────────────────
// state.daily[date] = { total, rx, tx } (GB). Baca dgn helper di bawah agar
// backward-compatible dengan data lama yang masih berupa number polos.
function dayEntry(key) {
  const cur = state.daily[key];
  if (cur && typeof cur === 'object') return cur;
  // migrasi entri lama (number) → object, total dipertahankan, rx/tx unknown
  const total = typeof cur === 'number' ? cur : 0;
  return { total, rx: 0, tx: 0 };
}

let _lastCounters = null;   // { iface, rx, tx }

async function sample() {
  // Pakai interface default (route keluar) + selisih counter byte KUMULATIF
  // dari kernel — akurat, tidak tergantung jeda antar sampling.
  const defIface = await si.networkInterfaceDefault().catch(() => null);
  const all      = await si.networkStats('*').catch(() => []);
  const net      = all.find(n => n.iface === defIface) || all.find(n => n.iface !== 'lo') || null;
  if (!net || typeof net.rx_bytes !== 'number' || typeof net.tx_bytes !== 'number') return;

  const prev = _lastCounters;
  _lastCounters = { iface: net.iface, rx: net.rx_bytes, tx: net.tx_bytes };
  if (!prev || prev.iface !== net.iface) return;           // sampel pertama: belum ada selisih
  const dRx = net.rx_bytes - prev.rx;
  const dTx = net.tx_bytes - prev.tx;
  if (dRx < 0 || dTx < 0) return;                          // counter reset (reboot) → abaikan

  const rxGbAdded = dRx / 1073741824;                      // GiB, sama dengan satuan vnstat
  const txGbAdded = dTx / 1073741824;

  const key   = todayKey();
  const entry = dayEntry(key);
  entry.rx    = +(entry.rx + rxGbAdded).toFixed(6);
  entry.tx    = +(entry.tx + txGbAdded).toFixed(6);
  entry.total = +(entry.total + rxGbAdded + txGbAdded).toFixed(6);
  state.daily[key] = entry;

  const keys = Object.keys(state.daily).sort();
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach(k => delete state.daily[k]);

  saveState();
}

function startSampler() {
  loadState();
  lastSampledAt = Date.now();
  setInterval(() => sample().catch(err => console.error('[network] sample error:', err.message)), SAMPLE_INTERVAL_MS);
}

// ─── vnstat helper ────────────────────────────────────────────────────────────
/**
 * Detect interface yang aktif dari vnstat.
 * vnstat --iflist → "Available interfaces: eno1 lo"
 */
async function detectInterface() {
  if (_detectedIface) return _detectedIface;

  const listed = await new Promise((resolve) => {
    execFile('vnstat', ['--iflist'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = (stdout || '').replace('Available interfaces:', '').trim();
      resolve(line.split(/\s+/).filter(i => i && i !== 'lo'));
    });
  });
  if (!listed || listed.length === 0) return null;

  // Interface yang dipakai trafik internet sebenarnya = default route.
  // (Sebelumnya asal ambil yang pertama → bisa kena docker0/br-xxx/veth
  // yang trafiknya hampir nol, jadi angka bulanan "ngaco".)
  const def = await si.networkInterfaceDefault().catch(() => null);
  const virtual = /^(docker|br-|veth|virbr|lxc|cni|flannel|tun|tap)/;
  _detectedIface = (def && listed.includes(def))
    ? def
    : (listed.find(i => !virtual.test(i)) || listed[0]);
  console.log(`[network] vnstat interface: ${_detectedIface} (default route: ${def || '-'})`);
  return _detectedIface;
}

/**
 * Jalankan vnstat dengan period flag, return stdout.
 * period: 'd' | 'm' | 'y' | 'h' | 't' (top10)
 */
async function runVnstat(period = 'd') {
  const iface = await detectInterface();
  if (!iface) throw new Error('vnstat interface not detected');

  const flagMap = { d: '-d', m: '-m', y: '-y', h: '-h', t: '-t', l: '-l' };
  const flag    = flagMap[period] || '-d';

  return new Promise((resolve, reject) => {
    execFile('vnstat', ['-i', iface, flag], { timeout: 8_000 }, (err, stdout) => {
      if (err) return reject(new Error(err.message || 'vnstat error'));
      resolve((stdout || '').trim());
    });
  });
}

/**
 * Parse output vnstat -d untuk ambil today & yesterday, termasuk rx/tx terpisah.
 * Format baris bervariasi antar versi vnstat, contoh:
 *   "  2026-08-05   1.20 GiB  |  450 MiB  |  1.65 GiB  |   17.32 kbit/s"
 * Strategi: cari semua pasangan "angka + satuan ukuran" (KiB/MiB/GiB/TiB/…)
 * di baris — ini akan menangkap rx, tx, total secara berurutan dan otomatis
 * mengabaikan kolom avg-rate (satuannya kbit/s, tidak cocok regex ukuran).
 * Return { todayGB, yesterdayGB, rows: [{date, rxGB, txGB, gb}] }
 */
function parseVnstatDaily(text) {
  const lines = text.split('\n').filter(l => /^\s*\d{4}-\d{2}-\d{2}/.test(l));
  const sizeRe = /([\d.]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b/gi;

  const rows = lines.map(line => {
    const date = line.trim().split(/\s+/)[0];
    const matches = [...line.matchAll(sizeRe)];

    let rxGB = 0, txGB = 0, gb = 0;
    if (matches.length >= 3) {
      // urutan standar vnstat: rx, tx, total
      rxGB = parseVnstatSize([matches[0][1], matches[0][2]]);
      txGB = parseVnstatSize([matches[1][1], matches[1][2]]);
      gb   = parseVnstatSize([matches[2][1], matches[2][2]]);
    } else if (matches.length === 1) {
      // baris ringkas tanpa breakdown rx/tx
      gb = parseVnstatSize([matches[0][1], matches[0][2]]);
    }
    return { date, rxGB, txGB, gb };
  });

  const today = todayKey();
  const todayRow     = rows.find(r => r.date === today);
  const yesterdayRow = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    todayGB:      todayRow?.gb   || 0,
    todayRxGB:    todayRow?.rxGB || 0,
    todayTxGB:    todayRow?.txGB || 0,
    yesterdayGB:  yesterdayRow?.gb || 0,
    rows,
  };
}

/**
 * Parse output vnstat -m untuk ambil month stats.
 * Format: "  2026-08    449.01 KiB    369.37 KiB    818.39 KiB"
 */
function parseVnstatMonthly(text) {
  const lines = text.split('\n').filter(l => /^\s*\d{4}(-\d{2})?\s/.test(l));
  return lines.map(line => {
    const parts = line.trim().split(/\s+/);
    const ym    = parts[0];
    const total = parseVnstatSize(parts.slice(-2));
    return { ym, gb: total };
  });
}

/**
 * Konversi satuan vnstat ke GB.
 * args: ['818.39', 'KiB'] atau ['1.65', 'GiB'] dll.
 */
function parseVnstatSize(parts) {
  if (parts.length < 2) return 0;
  const val  = parseFloat(parts[0]);
  const unit = (parts[1] || '').toLowerCase();
  if (!Number.isFinite(val)) return 0;
  if (unit.includes('kib') || unit === 'kb') return val / 1e6;
  if (unit.includes('mib') || unit === 'mb') return val / 1e3;
  if (unit.includes('gib') || unit === 'gb') return val;
  if (unit.includes('tib') || unit === 'tb') return val * 1e3;
  return val; // anggap sudah GB
}

/**
 * Ambil summary lengkap dari vnstat.
 * Return null jika vnstat tidak tersedia.
 */
async function getVnstatSummary() {
  const iface = await detectInterface();
  if (!iface) return null;

  const fromJson = await getVnstatJsonSummary(iface).catch(() => null);
  if (fromJson) return fromJson;
  return getVnstatTextSummary(iface);
}

/**
 * vnstat --json → byte asli per hari/bulan/tahun. Tidak ada parsing teks &
 * konversi satuan, jadi angkanya sama persis dengan database vnstat.
 * GB di sini = GiB (1024^3) supaya identik dengan yang ditampilkan `vnstat`.
 */
function getVnstatJsonSummary(iface) {
  return new Promise((resolve) => {
    execFile('vnstat', ['--json', '-i', iface], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      let j; try { j = JSON.parse(stdout); } catch (_) { return resolve(null); }
      const ifc = (j.interfaces || []).find(i => i.name === iface) || (j.interfaces || [])[0];
      if (!ifc || !ifc.traffic) return resolve(null);

      const mul  = String(j.jsonversion) === '1' ? 1024 : 1;      // v1 = KiB, v2 = byte
      const GIB  = 1073741824;
      const t    = ifc.traffic;
      const days = (t.day || t.days || []);
      const mons = (t.month || t.months || []);
      const yrs  = (t.year || t.years || []);
      const pad  = (n) => String(n).padStart(2, '0');
      const key  = (d) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

      const now   = new Date();
      const today = localDateKey(now);
      const ym    = today.slice(0, 7);

      const bytesOf = (e) => ({ rx: (e.rx || 0) * mul, tx: (e.tx || 0) * mul });
      const sum     = (arr) => arr.reduce((a, e) => { const b = bytesOf(e); return { rx: a.rx + b.rx, tx: a.tx + b.tx }; }, { rx: 0, tx: 0 });

      const todayE = days.find(e => e.date && key(e.date) === today);
      const todayB = todayE ? bytesOf(todayE) : { rx: 0, tx: 0 };

      // 7 hari terakhir (termasuk hari ini) berdasarkan TANGGAL, bukan "7 baris"
      const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 6);
      const cutoffKey = localDateKey(cutoff);
      const weekB = sum(days.filter(e => e.date && key(e.date) >= cutoffKey && key(e.date) <= today));

      const monthB = sum(mons.filter(e => e.date && `${e.date.year}-${pad(e.date.month)}` === ym));
      const yearB  = yrs.length
        ? sum(yrs.filter(e => e.date && e.date.year === now.getFullYear()))
        : sum(mons.filter(e => e.date && e.date.year === now.getFullYear()));

      const gb = (b) => +((b.rx + b.tx) / GIB).toFixed(4);
      const history = days.slice(-30).map(e => {
        const b = bytesOf(e);
        return { date: key(e.date), gb: +((b.rx + b.tx) / GIB).toFixed(4), rxGB: +(b.rx / GIB).toFixed(4), txGB: +(b.tx / GIB).toFixed(4) };
      });

      const dl = +(todayB.rx / GIB).toFixed(4);
      const ul = +(todayB.tx / GIB).toFixed(4);
      resolve({
        source: 'vnstat', iface,
        todayGB: gb(todayB), weekGB: gb(weekB), monthGB: gb(monthB), yearGB: gb(yearB),
        todayDownloadGB: dl, todayUploadGB: ul, todayRxGB: dl, todayTxGB: ul,
        todayDownloadBytes: Math.round(todayB.rx), todayUploadBytes: Math.round(todayB.tx),
        todayRxBytes: Math.round(todayB.rx), todayTxBytes: Math.round(todayB.tx),
        monthBytes: Math.round(monthB.rx + monthB.tx),
        history,
      });
    });
  });
}

async function getVnstatTextSummary(iface) {
  // Jalankan -d dan -m secara paralel
  const [dailyText, monthlyText, yearlyText] = await Promise.all([
    new Promise((resolve) => {
      execFile('vnstat', ['-i', iface, '-d'], { timeout: 8_000 }, (e, s) => resolve(e ? '' : s));
    }),
    new Promise((resolve) => {
      execFile('vnstat', ['-i', iface, '-m'], { timeout: 8_000 }, (e, s) => resolve(e ? '' : s));
    }),
    new Promise((resolve) => {
      execFile('vnstat', ['-i', iface, '-y'], { timeout: 8_000 }, (e, s) => resolve(e ? '' : s));
    }),
  ]);

  const dailyData   = parseVnstatDaily(dailyText);
  const monthlyData = parseVnstatMonthly(monthlyText);
  const yearlyData  = parseVnstatMonthly(yearlyText);

  // Today (total + breakdown download/upload)
  const todayGB         = dailyData.todayGB;
  const todayDownloadGB = dailyData.todayRxGB;
  const todayUploadGB   = dailyData.todayTxGB;

  // Week: jumlah 7 baris terakhir daily
  const weekRows  = dailyData.rows.slice(-7);
  const weekGB    = weekRows.reduce((s, r) => s + r.gb, 0);

  // Month: ambil baris bulan ini dari monthly
  const thisYm    = todayKey().slice(0, 7);
  const thisMonth = monthlyData.find(m => m.ym === thisYm);
  const monthGB   = thisMonth?.gb || 0;

  // Year: jumlah semua bulan tahun ini
  const thisYear  = todayKey().slice(0, 4);
  const yearGB    = yearlyData
    .filter(m => m.ym.startsWith(thisYear))
    .reduce((s, m) => s + m.gb, 0);

  // History 30 hari dari daily
  const history = dailyData.rows.slice(-30).map(r => ({ date: r.date, gb: +r.gb.toFixed(4) }));

  return {
    source: 'vnstat',
    iface,
    todayGB:         +todayGB.toFixed(4),
    weekGB:          +weekGB.toFixed(4),
    monthGB:         +monthGB.toFixed(4),
    yearGB:          +yearGB.toFixed(4),
    // Breakdown download/upload hari ini — beberapa alias agar cocok
    // dengan field apa pun yang dibaca Flutter client.
    todayDownloadGB: +todayDownloadGB.toFixed(4),
    todayUploadGB:   +todayUploadGB.toFixed(4),
    todayRxGB:       +todayDownloadGB.toFixed(4),
    todayTxGB:       +todayUploadGB.toFixed(4),
    todayDownloadBytes: Math.round(todayDownloadGB * 1e9),
    todayUploadBytes:   Math.round(todayUploadGB * 1e9),
    todayRxBytes:       Math.round(todayDownloadGB * 1e9),
    todayTxBytes:       Math.round(todayUploadGB * 1e9),
    history,
  };
}

// ─── Internal sampler helpers ─────────────────────────────────────────────────
function sumSinceDays(days, field = 'total') {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  return Object.entries(state.daily)
    .filter(([k]) => k >= cutoffKey)
    .reduce((s, [, v]) => s + (dayEntry_(v)[field] || 0), 0);
}

// Baca entri harian dengan aman, migrasi format lama (number) → object
function dayEntry_(v) {
  if (v && typeof v === 'object') return v;
  return { total: typeof v === 'number' ? v : 0, rx: 0, tx: 0 };
}

function getTodayGB()          { return dayEntry_(state.daily[todayKey()]).total; }
function getTodayDownloadGB()  { return dayEntry_(state.daily[todayKey()]).rx; }
function getTodayUploadGB()    { return dayEntry_(state.daily[todayKey()]).tx; }
function getWeekGB()   { return sumSinceDays(7); }
function getMonthGB()  { return sumSinceDays(30); }
function getYearGB()   { return sumSinceDays(365); }

function getDailyHistory(days = 30) {
  const keys = Object.keys(state.daily).sort().slice(-days);
  return keys.map(k => {
    const e = dayEntry_(state.daily[k]);
    return { date: k, gb: +(e.total || 0), rxGB: +(e.rx || 0), txGB: +(e.tx || 0) };
  });
}

module.exports = {
  startSampler,
  getTodayGB,
  getTodayDownloadGB,
  getTodayUploadGB,
  getWeekGB,
  getMonthGB,
  getYearGB,
  getDailyHistory,
  getVnstatSummary,
  runVnstat,
  detectInterface,
};
