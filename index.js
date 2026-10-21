/**
 * RFMonitor Server Agent — index.js
 * Perbaikan:
 * - Speedtest download tidak timeout (pakai stream abort + timeout 55s)
 * - Upload sink benar (baca body raw sebagai buffer)
 * - RAM metrics sekarang menyertakan usedMB / totalMB agar Flutter tidak null
 * - CPU suhu null-safe
 * - Network summary pakai vnstat (fallback ke internal sampler)
 * - Power summary pakai sudo powerstat -R 1 (fallback ke estimate)
 * - WebSocket emit 'metrics' AND 'stats' (kompatibel Flutter client)
 */

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const cors      = require('cors');
const helmet    = require('helmet');
const { Server }= require('socket.io');
const rateLimit = require('express-rate-limit');
const si        = require('systeminformation');
const jwt       = require('jsonwebtoken');
const { execFile, execFileSync, exec } = require('child_process');
const https     = require('https');
const crypto    = require('crypto');
const fs        = require('fs');
const WebSocket = require('ws');

const { requireApiKey, requireJwt, socketAuth } = require('./middleware/auth');
const { ALLOWED_PM2_APPS, isAppAllowed, isActionAllowed } = require('./utils/commandWhitelist');
const power        = require('./lib/power');
const network      = require('./lib/network');
const services     = require('./lib/services');
const spec         = require('./lib/spec');
const eventWatcher = require('./lib/events');
const presets      = require('./lib/presets');
const logger       = require('./lib/logger');
const execVerify   = require('./lib/execVerify');
const top          = require('./lib/top');
const compression  = require('compression');
const os           = require('os');

logger.attach(); // tangkap semua console.log/error sejak boot untuk GET /logs

// ─────────────────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
// gzip semua respons JSON (>512B) — hemat kuota HP
app.use(compression({ threshold: 512 }));

// Raw body untuk speedtest (upload-sink & run) — semua route lain pakai JSON parser
app.use((req, res, next) => {
  if (req.path === '/speedtest/upload-sink') return next();
  express.json({ limit: '512kb' })(req, res, next);
});

app.use(cors({ origin: (process.env.CORS_ORIGIN || '*').split(',') }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

const powerActionLimiter = rateLimit({ windowMs: 60_000, max: 3 });

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', requireApiKey, (req, res) => {
  const token = jwt.sign({ scope: 'mobile-agent' }, process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ ok: true, token, expiresIn: 43200 });
});

// Health check (no auth) — dipakai Flutter ping
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Semua route di bawah butuh JWT
app.use(requireJwt);

// ─── System Metrics ───────────────────────────────────────────────────────────
let lastCpuUsage = 0;

/**
 * Fallback baca suhu CPU langsung dari /sys/class/thermal — beberapa board
 * ARM/SBC (mis. STB Armbian) kadang tidak terbaca lengkap oleh
 * systeminformation. Ambil suhu tertinggi di antara semua thermal_zone yang
 * valid supaya representasi "seberapa panas" tetap akurat.
 */
function readThermalZoneFallbackC() {
  try {
    const base = '/sys/class/thermal';
    if (!fs.existsSync(base)) return null;
    const zones = fs.readdirSync(base).filter(n => n.startsWith('thermal_zone'));
    let maxC = null;
    for (const zone of zones) {
      try {
        const raw = fs.readFileSync(`${base}/${zone}/temp`, 'utf8').trim();
        const milli = parseInt(raw, 10);
        if (!Number.isFinite(milli)) continue;
        const c = milli > 1000 ? milli / 1000 : milli; // beberapa board sudah dalam °C
        if (c > 0 && c < 150 && (maxC === null || c > maxC)) maxC = c;
      } catch (_) { /* skip zone ini */ }
    }
    return maxC;
  } catch (_) {
    return null;
  }
}

/**
 * Sumber suhu paling akurat: perintah `sensors` dari paket lm-sensors
 * (sama seperti yang dipakai `watch sensors` di terminal). Pakai flag -u
 * (machine-readable) supaya parsing tidak tergantung locale/simbol derajat.
 * Ambil suhu TERTINGGI di antara semua sensor temp yang valid (mewakili
 * titik terpanas — biasanya Package/Core CPU).
 *
 *   sudo apt install lm-sensors && sudo sensors-detect --auto
 */
function readSensorsCommandTempC() {
  return new Promise((resolve) => {
    execFile('sensors', ['-A', '-u'], { timeout: 4_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const matches = [...stdout.matchAll(/temp\d*_input:\s*([\d.-]+)/g)];
      const vals = matches
        .map(m => parseFloat(m[1]))
        .filter(v => Number.isFinite(v) && v > 0 && v < 150);
      resolve(vals.length ? Math.max(...vals) : null);
    });
  });
}

/**
 * Urutan sumber suhu CPU (dari paling akurat/disukai):
 *  1. `sensors` (lm-sensors) — paling akurat, sama seperti `watch sensors`
 *  2. systeminformation si.cpuTemperature()
 *  3. baca langsung /sys/class/thermal (fallback terakhir untuk board ARM/STB)
 */
let _tempCache = { at: 0, val: null };
async function resolveAccurateTempC(siMainTemp) {
  if (Date.now() - _tempCache.at < 8_000) return _tempCache.val;
  const v = await _resolveTempUncached(siMainTemp);
  _tempCache = { at: Date.now(), val: v };
  return v;
}
async function _resolveTempUncached(siMainTemp) {
  const fromSensors = await readSensorsCommandTempC().catch(() => null);
  if (typeof fromSensors === 'number') return fromSensors;
  if (typeof siMainTemp === 'number' && Number.isFinite(siMainTemp)) return siMainTemp;
  return readThermalZoneFallbackC();
}

let _defIface = { at: 0, name: null };
async function getDefaultIface() {
  if (Date.now() - _defIface.at < 60_000) return _defIface.name;
  const name = await si.networkInterfaceDefault().catch(() => null);
  _defIface = { at: Date.now(), name };
  return name;
}

async function collectMetrics() {
  const [cpuLoad, cpuTemp, mem, fsArr, netArr, sysTime] = await Promise.all([
    si.currentLoad(),
    si.cpuTemperature().catch(() => ({ main: null })),
    si.mem(),
    si.fsSize().catch(() => []),
    si.networkStats().catch(() => []),
    si.time(),
  ]);

  lastCpuUsage = cpuLoad.currentLoad ?? 0;

  // Suhu CPU real — urutan: sensors (lm-sensors) → systeminformation →
  // thermal_zone langsung. Tidak boleh error walau salah satu sumber gagal.
  const siMainTemp = typeof cpuTemp.main === 'number' && Number.isFinite(cpuTemp.main) ? cpuTemp.main : null;
  const tempC = await resolveAccurateTempC(siMainTemp).catch(() => null);

  // Disk utama = filesystem yang di-mount di "/" (sama dengan `df -h /`);
  // fallback ke filesystem nyata terbesar jika "/" tidak ditemukan.
  const real = fsArr.filter(f => f.size > 1e8 && !/^(tmpfs|devtmpfs|overlay|squashfs)/.test(f.type || '') && !String(f.fs).startsWith('tmp') && !String(f.fs).startsWith('dev'));
  const disk = fsArr.find(f => f.mount === '/') || real.sort((a, b) => b.size - a.size)[0] || fsArr[0] || {};

  // Interface jaringan = default route (bukan lo/docker0/veth yang trafiknya ~0)
  const defIface = await getDefaultIface();
  const net = netArr.find(n => n.iface === defIface)
    || netArr.filter(n => n.iface !== 'lo' && !/^(docker|br-|veth|virbr)/.test(n.iface)).sort((a, b) => (b.rx_bytes || 0) - (a.rx_bytes || 0))[0]
    || netArr[0] || {};

  // RAM "terpakai" = total − available (sama dengan kolom used di `free` / htop),
  // BUKAN mem.active. Satuan MiB (1024²) agar angkanya identik dengan `free -m`.
  const MIB = 1048576, GIB = 1073741824;
  const totalMem   = mem.total ?? 0;
  const availMem   = mem.available ?? mem.free ?? 0;
  const usedMem    = Math.max(0, totalMem - availMem);
  const usedMB     = Math.round(usedMem / MIB);
  const totalMB    = Math.round(totalMem / MIB);
  const usedPercent = totalMem > 0 ? +((usedMem / totalMem) * 100).toFixed(1) : 0;

  const lastPower = power.getLastSample();

  return {
    cpu: {
      usagePercent: +lastCpuUsage.toFixed(1),
      tempC: typeof tempC === 'number' ? +tempC.toFixed(1) : null,
      cores: (cpuLoad.cpus || []).length,
      perCore: (cpuLoad.cpus || []).map(c => Math.round(c.load || 0)),
      loadAvg: os.loadavg().map(v => +v.toFixed(2)),
    },
    ram: {
      // usedMB / totalMB — wajib untuk Flutter agar tidak null
      usedMB,
      totalMB,
      usedGB:      +(usedMem / GIB).toFixed(2),
      totalGB:     +(totalMem / GIB).toFixed(2),
      freeMB:      Math.round(availMem / MIB),          // sisa RAM yang benar-benar bisa dipakai
      freeGB:      +(availMem / GIB).toFixed(2),
      swapUsedMB:  Math.round((mem.swapused || 0) / MIB),
      swapTotalMB: Math.round((mem.swaptotal || 0) / MIB),
      usedPercent,
    },
    disk: {
      mount:       disk.mount || '/',
      usedGB:      +((disk.used || 0) / GIB).toFixed(2),
      totalGB:     +((disk.size || 0) / GIB).toFixed(2),
      freeGB:      +((disk.available || 0) / GIB).toFixed(2),   // = kolom Avail di `df -h`
      usedPercent: typeof disk.use === 'number' ? +disk.use.toFixed(1) : (disk.size ? +((disk.used / disk.size) * 100).toFixed(1) : 0),
    },
    network: {
      rxBytesPerSec: Math.round(net.rx_sec || 0),
      txBytesPerSec: Math.round(net.tx_sec || 0),
      downloadMbps:  +((net.rx_sec || 0) * 8 / 1e6).toFixed(2),
      uploadMbps:    +((net.tx_sec || 0) * 8 / 1e6).toFixed(2),
    },
    power: {
      currentWatts: lastPower.watts,
      source:       lastPower.source,
    },
    uptimeSeconds: sysTime.uptime ?? 0,
    timestamp:     Date.now(),
  };
}

app.get('/metrics', async (req, res) => {
  try {
    res.json({ ok: true, data: await collectMetrics() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Power — background sampler + summary endpoint ────────────────────────────
power.startSampler(
  () => lastCpuUsage,
  Number(process.env.POWER_IDLE_WATT   || 30),
  Number(process.env.POWER_MAX_EXTRA_WATT || 90),
);

app.get('/power/summary', (req, res) => {
  const tariff         = Number(req.query.tariffPerKwh      || process.env.PLN_RATE_PER_KWH   || 1445);
  const internetCostMo = Number(req.query.monthlyInternetCost || process.env.MONTHLY_INTERNET_COST || 0);

  const todayKwh = power.getTodayKwh();
  const weekKwh  = power.getWeekKwh();
  const monthKwh = power.getMonthKwh();
  const yearKwh  = power.getYearKwh();
  const sample   = power.getLastSample();

  const monthElec  = Math.round(monthKwh * tariff);
  const monthTotal = monthElec + Math.round(internetCostMo);

  res.json({
    ok: true,
    data: {
      currentWatts:            sample.watts,
      source:                  sample.source,      // 'powerstat' | 'estimate'
      todayKwh:                +todayKwh.toFixed(3),
      todayCostRp:             Math.round(todayKwh * tariff),
      weekKwh:                 +weekKwh.toFixed(3),
      weekCostRp:              Math.round(weekKwh * tariff),
      monthKwh:                +monthKwh.toFixed(3),
      monthElectricityCostRp:  monthElec,
      yearKwh:                 +yearKwh.toFixed(3),
      yearCostRp:              Math.round(yearKwh * tariff),
      monthlyInternetCostRp:   Math.round(internetCostMo),
      monthTotalCostRp:        monthTotal,
      history:                 power.getHourlyHistory(),   // [{h:"00:00", kwh}, ...] — hari ini per jam
      dailyHistory:            power.getDailyHistory(30),  // [{date, kwh}, ...] — trend 30 hari (ekstra)
    },
  });
});

// Backward-compat estimate endpoint
app.post('/power/estimate', (req, res) => {
  const {
    cpuUsagePercent    = 0,
    idleWatt           = 30,
    maxExtraWatt       = 90,
    hoursPerDay        = 24,
    tariffPerKwh       = Number(process.env.PLN_RATE_PER_KWH   || 1445),
    monthlyInternetCost= Number(process.env.MONTHLY_INTERNET_COST || 0),
  } = req.body || {};

  const estimatedWatt        = idleWatt + (maxExtraWatt * cpuUsagePercent) / 100;
  const dailyKwh             = (estimatedWatt * hoursPerDay) / 1000;
  const monthlyElectricityRp = Math.round(dailyKwh * 30 * tariffPerKwh);

  res.json({
    ok: true,
    data: {
      estimatedWatt:        +estimatedWatt.toFixed(1),
      dailyCostRp:          Math.round(dailyKwh * tariffPerKwh),
      monthlyElectricityRp,
      monthlyInternetCostRp: Math.round(monthlyInternetCost),
      monthlyTotalRp:        monthlyElectricityRp + Math.round(monthlyInternetCost),
    },
  });
});

// ─── Network summary — vnstat (jika ada) lalu fallback internal sampler ───────
network.startSampler();

app.get('/network/summary', async (req, res) => {
  // Coba pakai vnstat untuk data yang akurat
  const vnstatData = await network.getVnstatSummary().catch(() => null);

  let payload;
  if (vnstatData) {
    payload = vnstatData;
  } else {
    // Fallback ke internal sampler
    const todayDownloadGB = network.getTodayDownloadGB();
    const todayUploadGB   = network.getTodayUploadGB();
    payload = {
      source:   'internal-sampler',
      todayGB:  +network.getTodayGB().toFixed(3),
      weekGB:   +network.getWeekGB().toFixed(3),
      monthGB:  +network.getMonthGB().toFixed(3),
      yearGB:   +network.getYearGB().toFixed(3),
      // Breakdown download/upload hari ini — beberapa alias agar cocok
      // dengan field apa pun yang dibaca Flutter client.
      todayDownloadGB:    +todayDownloadGB.toFixed(4),
      todayUploadGB:      +todayUploadGB.toFixed(4),
      todayRxGB:          +todayDownloadGB.toFixed(4),
      todayTxGB:          +todayUploadGB.toFixed(4),
      todayDownloadBytes: Math.round(todayDownloadGB * 1e9),
      todayUploadBytes:   Math.round(todayUploadGB * 1e9),
      todayRxBytes:       Math.round(todayDownloadGB * 1e9),
      todayTxBytes:       Math.round(todayUploadGB * 1e9),
      dailyHistory: network.getDailyHistory(30),
    };
  }

  // history ringkas berbasis kategori (dipakai untuk bar chart Today/Week/Month/Year)
  const dailyHistory = payload.dailyHistory || payload.history || [];
  res.json({
    ok: true,
    data: {
      ...payload,
      history: [
        { label: 'Today', gb: payload.todayGB },
        { label: 'Week',  gb: payload.weekGB },
        { label: 'Month', gb: payload.monthGB },
        { label: 'Year',  gb: payload.yearGB },
      ],
      dailyHistory,
    },
  });
});

// vnstat raw — untuk tampilkan tabel di app jika diperlukan
app.get('/network/vnstat', async (req, res) => {
  const period = req.query.period || 'd'; // d | m | y | h | t
  try {
    const data = await network.runVnstat(period);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── PM2 ────────────────────────────────────────────────────────────────────
app.get('/pm2/list', async (req, res) => {
  try {
    const list = await services.listPm2();
    const filtered = list
      .filter(p => ALLOWED_PM2_APPS.length === 0 || ALLOWED_PM2_APPS.includes(p.name))
      .map(p => ({
        name:     p.name,
        status:   p.status,
        cpu:      p.cpuPercent,
        memoryMB: p.memoryMB,
        uptimeMs: p.uptimeMs,
        restarts: p.restarts,
      }));
    res.json({ ok: true, data: filtered });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/pm2/action', async (req, res) => {
  const { name, action } = req.body || {};
  if (!isAppAllowed(name))   return res.status(400).json({ ok: false, error: 'App not in allowlist' });
  if (!isActionAllowed(action)) return res.status(400).json({ ok: false, error: 'Action not allowed' });
  try {
    await services.control('pm2', name, action);
    res.json({ ok: true, message: `${action} sent to ${name}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Logs PM2 — baca file fisik, kompatibel dengan Flutter client
app.get('/pm2/logs', async (req, res) => {
  const { name } = req.query;
  const lines    = Math.min(Number(req.query.lines) || 150, 500);
  try {
    const data = await services.tailLogs('pm2', name, lines);
    const combined = [data.out, data.error].filter(Boolean).join('\n').trim();
    res.json({ ok: true, data: { output: combined }, out: data.out, error: data.error });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Unified Services (PM2 + Docker + systemd) ────────────────────────────────
app.get('/services/list', async (req, res) => {
  try {
    res.json({ ok: true, data: await services.listAll() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/services/action', async (req, res) => {
  const { type, name, action } = req.body || {};
  try {
    await services.control(type, name, action);
    res.json({ ok: true, message: `${action} sent to ${type}:${name}` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/services/logs', async (req, res) => {
  const { type, name } = req.query;
  const lines = Math.min(Number(req.query.lines) || 150, 500);
  try {
    const data    = await services.tailLogs(type, name, lines);
    const combined = [data.out, data.error].filter(Boolean).join('\n').trim();
    res.json({ ok: true, data: { output: combined }, out: data.out, error: data.error });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── Command Presets ──────────────────────────────────────────────────────────
app.get('/presets/list', (req, res) => res.json({ ok: true, data: presets.listPresets() }));

app.post('/presets/run', async (req, res) => {
  const { name } = req.body || {};
  try {
    const output = await presets.runPreset(name);
    res.json({ ok: true, data: { output } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─── System Spec ─────────────────────────────────────────────────────────────
let _specCache = { at: 0, data: null };
app.get('/system/spec', async (req, res) => {
  try {
    // cache 60 detik: getSpec memanggil banyak probe hardware (usb, disk, publicIp)
    if (!_specCache.data || Date.now() - _specCache.at > 60_000) {
      _specCache = { at: Date.now(), data: await spec.getSpec() };
    }
    res.json({ ok: true, data: _specCache.data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── System Uptime ────────────────────────────────────────────────────────────
app.get('/system/uptime', async (req, res) => {
  try {
    const t = await si.time();
    res.json({ ok: true, uptime: t.uptime, data: { uptimeSeconds: t.uptime } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Power Control (reboot / shutdown) ────────────────────────────────────────
app.post('/system/:action(reboot|shutdown)', powerActionLimiter, (req, res) => {
  if (process.env.ALLOW_POWER_CONTROL !== 'true') {
    return res.status(403).json({ ok: false, error: 'Power control disabled' });
  }
  const { action } = req.params;
  const expected = action === 'reboot' ? 'CONFIRM REBOOT' : 'CONFIRM SHUTDOWN';
  if ((req.body || {}).confirmPhrase !== expected) {
    return res.status(400).json({ ok: false, error: 'Missing/incorrect confirmation phrase' });
  }
  const args = action === 'reboot' ? [] : ['-h', 'now'];
  execFile('sudo', [action === 'reboot' ? 'reboot' : 'shutdown', ...args], (err) => {
    if (err) console.error(`[power] ${action} error:`, err.message);
  });
  res.json({ ok: true, message: `${action} triggered` });
});

// ─── Speedtest (100% di SERVER — bukan HP) ────────────────────────────────────
// Semua trafik tes terjadi antara server ↔ Cloudflare. HP hanya menerima angka
// progress kecil lewat WebSocket, jadi TIDAK memakai kuota HP.
const net = require('net');

/** Ping = RTT TCP sebenarnya (waktu connect), ambil yang terkecil dari 5 percobaan. */
function measurePing(host = 'speed.cloudflare.com', attempts = 5, timeoutMs = 3_000) {
  const once = () => new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect({ host, port: 443 });
    const fail = () => { sock.destroy(); resolve(null); };
    sock.setTimeout(timeoutMs, fail);
    sock.once('error', fail);
    sock.once('connect', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      sock.destroy();
      resolve(ms);
    });
  });
  return (async () => {
    const r = [];
    for (let i = 0; i < attempts; i++) { const v = await once(); if (v != null) r.push(v); }
    if (!r.length) throw new Error('Ping gagal (host tidak terjangkau)');
    return +Math.min(...r).toFixed(1);
  })();
}

/**
 * Download: beberapa koneksi paralel supaya benar-benar menjenuhkan link
 * (satu koneksi TCP sering tidak cukup di link cepat). Waktu dihitung dari
 * byte pertama yang diterima, bukan dari awal koneksi/TLS.
 */
function measureDownload({ streams = 4, bytesPerStream = 25_000_000, timeoutMs = 30_000, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    let received = 0, ended = 0, firstAt = 0, settled = false;
    let lastTick = { t: Date.now(), bytes: 0 };
    const reqs = [];

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker); clearTimeout(timer);
      reqs.forEach(r => r.destroy());
      if (received <= 0) return reject(err || new Error('Download gagal'));
      const sec = Math.max((Date.now() - firstAt) / 1000, 0.05);
      resolve(+((received * 8) / sec / 1e6).toFixed(2));
    };
    const timer  = setTimeout(() => finish(), timeoutMs);      // waktu habis = pakai hasil sejauh ini
    const ticker = setInterval(() => {
      if (!onProgress || !firstAt) return;
      const now = Date.now();
      const dt  = (now - lastTick.t) / 1000;
      const inst = dt > 0 ? ((received - lastTick.bytes) * 8) / dt / 1e6 : 0;
      lastTick = { t: now, bytes: received };
      onProgress(+inst.toFixed(2), +((received * 8) / Math.max((now - firstAt) / 1000, 0.05) / 1e6).toFixed(2));
    }, 200);

    for (let i = 0; i < streams; i++) {
      const r = https.get(`https://speed.cloudflare.com/__down?bytes=${bytesPerStream}`, (resp) => {
        if (resp.statusCode !== 200) { resp.resume(); if (++ended === streams) finish(new Error(`Cloudflare HTTP ${resp.statusCode}`)); return; }
        resp.on('data', (c) => { if (!firstAt) { firstAt = Date.now(); lastTick = { t: firstAt, bytes: 0 }; } received += c.length; });
        resp.on('end',  () => { if (++ended === streams) finish(); });
        resp.on('error', () => { if (++ended === streams) finish(new Error('Download terputus')); });
      });
      r.on('error', () => { if (++ended === streams) finish(new Error('Koneksi ke Cloudflare gagal')); });
      reqs.push(r);
    }
  });
}

/**
 * Upload: server MENGIRIM data ke Cloudflare (/__up) lewat beberapa koneksi
 * paralel. Progress dihitung dari `socket.bytesWritten` (byte yang benar-benar
 * ditulis ke socket), bukan dari asumsi.
 */
function measureUpload({ streams = 3, bytesPerStream = 10_000_000, timeoutMs = 30_000, onProgress = null } = {}) {
  return new Promise((resolve, reject) => {
    const CHUNK = 65_536;
    const payload = crypto.randomBytes(bytesPerStream);
    const sockets = [];
    let done = 0, startAt = 0, settled = false;
    let lastTick = { t: 0, bytes: 0 };
    const written = () => sockets.reduce((a, s) => a + (s.bytesWritten || 0), 0);

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker); clearTimeout(timer);
      const total = written();
      reqs.forEach(r => r.destroy());
      if (!startAt || total <= 0) return reject(err || new Error('Upload gagal'));
      const sec = Math.max((Date.now() - startAt) / 1000, 0.05);
      resolve(+((total * 8) / sec / 1e6).toFixed(2));
    };
    const timer  = setTimeout(() => finish(), timeoutMs);
    const ticker = setInterval(() => {
      if (!onProgress || !startAt) return;
      const now = Date.now(), w = written();
      const dt = (now - lastTick.t) / 1000;
      const inst = dt > 0 ? ((w - lastTick.bytes) * 8) / dt / 1e6 : 0;
      lastTick = { t: now, bytes: w };
      onProgress(+inst.toFixed(2), +((w * 8) / Math.max((now - startAt) / 1000, 0.05) / 1e6).toFixed(2));
    }, 200);

    const reqs = [];
    for (let i = 0; i < streams; i++) {
      const r = https.request({
        hostname: 'speed.cloudflare.com', path: '/__up', method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length },
      }, (resp) => { resp.resume(); resp.on('end', () => { if (++done === streams) finish(); }); });
      r.on('socket', (s) => {
        sockets.push(s);
        const go = () => { if (!startAt) { startAt = Date.now(); lastTick = { t: startAt, bytes: written() }; } };
        if (s.connecting) s.once('secureConnect', go); else go();
      });
      r.on('error', () => { if (++done === streams) finish(new Error('Upload ke Cloudflare gagal')); });
      reqs.push(r);

      let off = 0;
      const pump = () => {
        if (settled) return;
        let ok = true;
        while (off < payload.length && ok) {
          const end = Math.min(off + CHUNK, payload.length);
          ok = r.write(payload.subarray(off, end));
          off = end;
        }
        if (off >= payload.length) r.end(); else r.once('drain', pump);
      };
      pump();
    }
  });
}

let speedtestBusy = false;
app.post('/speedtest/run', async (req, res) => {
  if (speedtestBusy) return res.status(409).json({ ok: false, error: 'Speedtest sedang berjalan' });
  speedtestBusy = true;
  res.setTimeout(110_000, () => {
    if (!res.headersSent) res.status(504).json({ ok: false, error: 'Speedtest gateway timeout (110s)' });
  });
  // Progress realtime ke HP lewat WebSocket (angka kecil, ~40 byte/200ms)
  const emit = (phase, inst = 0, avg = 0) => { try { broadcastEvent({ kind: 'speedtest_progress', phase, instantMbps: inst, avgMbps: avg }); } catch (_) {} };

  try {
    emit('ping');
    const pingMs = await measurePing().catch(() => null);

    emit('download');
    const downloadMbps = await measureDownload({ onProgress: (i, a) => emit('download', i, a) });

    emit('upload');
    const uploadMbps = await measureUpload({ onProgress: (i, a) => emit('upload', i, a) }).catch((e) => { console.error('[speedtest] upload:', e.message); return null; });

    emit('done');
    res.json({ ok: true, data: { pingMs, downloadMbps, uploadMbps, source: 'server' } });
  } catch (err) {
    emit('error');
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  } finally {
    speedtestBusy = false;
  }
});

/**
 * Upload sink — Flutter client upload data mentah ke sini.
 * Baca stream mentah tanpa JSON parser.
 */
app.post('/speedtest/upload-sink', (req, res) => {
  const start  = Date.now();
  let received = 0;

  req.on('data',  (chunk) => (received += chunk.length));
  req.on('end',   () => {
    const seconds = Math.max((Date.now() - start) / 1000, 0.05);
    res.json({
      ok: true,
      data: {
        uploadMbps:    +((received * 8) / seconds / 1e6).toFixed(2),
        bytesReceived: received,
      },
    });
  });
  req.on('error', () => {
    if (!res.headersSent) res.status(400).json({ ok: false, error: 'Upload stream interrupted' });
  });
});

// ─── Server Logs (umum, tanpa allowlist PM2 — cukup JWT standar) ─────────────
app.get('/logs', (req, res) => {
  const lines = Math.min(Number(req.query.lines) || 200, 2000);
  res.json({ ok: true, data: { output: logger.getLogs(lines) } });
});

// Log inkremental untuk SEMUA tipe (generic/pm2/docker/systemd): klien kirim
// `cursor` terakhir → server hanya balas baris baru (hemat kuota, realtime).
app.get('/logs/stream', async (req, res) => {
  const { type = 'generic', name = '', cursor } = req.query;
  const initial = Number(req.query.lines) || 200;
  try {
    if (type === 'generic') {
      const r = logger.getSince(cursor, Math.min(initial, 500));
      return res.json({ ok: true, data: r });
    }
    const r = await services.streamLogs(type, name, cursor, initial);
    res.json({ ok: true, data: r });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/logs/stream', async (req, res) => {
  const { type = 'generic', name = '' } = req.query;
  try {
    if (type === 'generic') { logger.clear(); return res.json({ ok: true, data: { cleared: true } }); }
    const r = await services.clearLogs(type, name);
    res.json({ ok: true, data: { cleared: true, ...r } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Hapus log yang tampil (buffer di-reset) — dipakai tombol "Clear" di app.
app.delete('/logs', (req, res) => {
  logger.clear();
  res.json({ ok: true, data: { cleared: true } });
});

// ─── CMD Exec — command bebas dari HP, dilindungi verifikasi 2FA ─────────────
// PERINGATAN: endpoint ini menjalankan command APA PUN yang diketik user di
// shell server. JWT saja dianggap tidak cukup untuk fitur ini, jadi ditambah
// kode verifikasi 6-digit yang HANYA muncul di console/log server (lihat
// lib/execVerify.js) — tidak pernah dikirim balik lewat response API.
app.post('/system/exec', async (req, res) => {
  const { cmd, verifyCode } = req.body || {};
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return res.status(400).json({ ok: false, error: 'Command kosong' });
  }

  if (!execVerify.isSessionVerified()) {
    if (!verifyCode) {
      execVerify.generateCode();
      return res.status(401).json({
        ok: false,
        needsVerification: true,
        error: 'Perlu kode verifikasi. Cek console/log server (GET /logs) untuk melihat kodenya.',
      });
    }
    if (!execVerify.verify(verifyCode)) {
      execVerify.generateCode();
      return res.status(401).json({
        ok: false,
        needsVerification: true,
        error: 'Kode salah/kadaluarsa. Kode baru sudah dibuat — cek log server lagi.',
      });
    }
  }

  exec(cmd, { timeout: 25_000, maxBuffer: 2 * 1024 * 1024, shell: '/bin/bash' }, (err, stdout, stderr) => {
    res.json({
      ok: true,
      data: {
        output:   (stdout || '') + (stderr ? `\n--- STDERR ---\n${stderr}` : ''),
        exitCode: err ? (err.code ?? 1) : 0,
        timedOut: err?.killed === true,
        sessionRemainingMs: execVerify.remainingSessionMs(),
      },
    });
  });
});

// ─── Service Event Watcher ────────────────────────────────────────────────────
eventWatcher.start();

function broadcastEvent(payload) {
  io.emit('event', payload);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'event', data: payload }));
  }
}
eventWatcher.on('change', broadcastEvent);

// ─── Socket.io (web clients / fallback) ───────────────────────────────────────
const io = new Server(server, {
  cors: { origin: (process.env.CORS_ORIGIN || '*').split(',') },
});
io.use(socketAuth);

io.on('connection', (socket) => { if (latestMetrics) socket.emit('metrics', latestMetrics); });

// ─── Plain WebSocket (Flutter primary channel) ────────────────────────────────
// wss://<host>/ws?token=<jwt>
// permessage-deflate: pesan WS dikompres (JSON metrics jadi ~40% ukuran asli)
const wss = new WebSocket.Server({
  noServer: true,
  perMessageDeflate: { threshold: 128, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

server.on('upgrade', (req, socket, head) => {
  const url   = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const token = url.searchParams.get('token');
  jwt.verify(token || '', process.env.JWT_SECRET, (err) => {
    if (err) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
});

wss.on('connection', (ws) => {
  // Kirim sampel terakhir langsung supaya UI tidak menunggu interval berikutnya
  if (latestMetrics && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'metrics', data: latestMetrics }));
  }
  ws.on('error', () => {});
});

// ─── Sampler metrics BERSAMA (1x kumpul → semua client) ───────────────────────
// Dulu setiap client menjalankan collectMetrics sendiri tiap 2s dan mengirim
// DUA pesan identik ('metrics' + 'stats'). Sekarang satu sampler, satu pesan.
const METRICS_INTERVAL_MS = 3000;
const HISTORY_MAX = 120;                 // 120 × 3s = 6 menit
const metricsHistory = [];
let latestMetrics = null;
let sampling = false;

async function sampleMetrics() {
  if (sampling) return;
  sampling = true;
  try {
    const m = await collectMetrics();
    latestMetrics = m;
    metricsHistory.push({
      t: m.timestamp,
      cpu: m.cpu.usagePercent,
      ram: m.ram.usedPercent,
      disk: m.disk.usedPercent,
      temp: m.cpu.tempC,
      rx: m.network.rxBytesPerSec,
      tx: m.network.txBytesPerSec,
    });
    if (metricsHistory.length > HISTORY_MAX) metricsHistory.shift();

    const msg = JSON.stringify({ type: 'metrics', data: m });
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    io.emit('metrics', m);
  } catch (err) {
    console.error('[metrics] sample error:', err.message);
  } finally {
    sampling = false;
  }
}
setInterval(sampleMetrics, METRICS_INTERVAL_MS);
sampleMetrics();
top.start();

// Riwayat 6 menit terakhir — array paralel (kecil, ~2KB gzip)
app.get('/metrics/history', (req, res) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 6, 1), 6);
  const cutoff  = Date.now() - minutes * 60_000;
  const rows    = metricsHistory.filter(r => r.t >= cutoff);
  res.json({ ok: true, data: {
    intervalMs: METRICS_INTERVAL_MS,
    t:    rows.map(r => r.t),
    cpu:  rows.map(r => r.cpu),
    ram:  rows.map(r => r.ram),
    disk: rows.map(r => r.disk),
    temp: rows.map(r => r.temp),
    rx:   rows.map(r => r.rx),
    tx:   rows.map(r => r.tx),
  }});
});

// Proses terberat CPU/RAM (ringan, aman di-poll ±3 detik) + direktori terbesar (cache)
app.get('/system/top', async (req, res) => {
  try {
    const procs = await top.topProcesses(5);
    res.json({ ok: true, data: { ...procs, dirs: top.getBiggestDirs() } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post('/system/top/refresh', (req, res) => { top.refreshBiggestDirs(); res.json({ ok: true }); });

// ─── Boot ────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 4200);
server.listen(PORT, () => {
  console.log(`\n🚀  RFMonitor Agent listening on :${PORT}`);
  console.log(`    Allowed PM2 apps : ${ALLOWED_PM2_APPS.join(', ') || '(none)'}`);
  console.log(`    Power control    : ${process.env.ALLOW_POWER_CONTROL === 'true' ? 'ENABLED' : 'disabled'}`);
  console.log(`    powerstat        : checking...\n`);
  // Cek apakah powerstat tersedia
  execFile('which', ['powerstat'], (err) => {
    if (err) console.warn('    ⚠️  powerstat not found — gunakan: sudo apt install powerstat');
    else     console.log('    ✅ powerstat found');
  });
  execFile('which', ['vnstat'], (err) => {
    if (err) console.warn('    ⚠️  vnstat not found — gunakan: sudo apt install vnstat && sudo systemctl enable --now vnstat');
    else     console.log('    ✅ vnstat found\n');
  });
});

// Graceful shutdown
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
