/**
 * lib/spec.js
 * Hardware spec + USB devices (keyboard, dll) + network interfaces.
 */

const si    = require('systeminformation');
const https = require('https');

// Cache public IP 10 menit — jarang berubah, hindari hit ke layanan luar tiap request
let publicIpCache = { ip: null, ts: 0 };
const PUBLIC_IP_TTL_MS = 10 * 60 * 1000;

function fetchJsonIp(hostname, path) {
  return new Promise((resolve) => {
    const req = https.get({ hostname, path, timeout: 5_000 }, (resp) => {
      let body = '';
      resp.on('data', (c) => (body += c));
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve((parsed.ip || '').trim() || null);
        } catch (_) {
          const plain = body.trim();
          resolve(/^[0-9a-fA-F.:]+$/.test(plain) ? plain : null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getPublicIp() {
  const now = Date.now();
  if (publicIpCache.ip && (now - publicIpCache.ts) < PUBLIC_IP_TTL_MS) {
    return publicIpCache.ip;
  }
  // Coba beberapa provider secara berurutan — resilient jika satu down/diblok
  let ip = await fetchJsonIp('api.ipify.org', '/?format=json');
  if (!ip) ip = await fetchJsonIp('ifconfig.co', '/json');
  if (ip) publicIpCache = { ip, ts: now };
  return ip;
}

async function getSpec() {
  const [cpu, osInfo, system, mem, blockDevices, fsSize, usb, diskLayout, networkIfaces, defaultIface, publicIp] =
    await Promise.all([
      si.cpu(),
      si.osInfo(),
      si.system(),
      si.mem(),
      si.blockDevices().catch(() => []),
      si.fsSize().catch(() => []),
      si.usb().catch(() => []),
      si.diskLayout().catch(() => []),
      si.networkInterfaces().catch(() => []),
      si.networkInterfaceDefault().catch(() => null),
      getPublicIp().catch(() => null),
    ]);

  const activeIfaces = networkIfaces.filter(n => !n.internal && n.ifaceName !== 'lo' && (n.ip4 || n.ip6));

  // IP lokal — utamakan interface default, fallback ke interface aktif pertama
  const defaultEntry = activeIfaces.find(n => (n.ifaceName || n.iface) === defaultIface);
  const localIp = (defaultEntry && defaultEntry.ip4) || (activeIfaces[0] && activeIfaces[0].ip4) || null;

  return {
    system: {
      manufacturer:     system.manufacturer || null,
      model:            system.model || null,
      cpuModel:         `${cpu.manufacturer} ${cpu.brand}`.trim(),
      cpuCores:         cpu.cores,
      cpuPhysicalCores: cpu.physicalCores,
      totalRamGB:       +(mem.total / 1e9).toFixed(1),
      osDistro:         osInfo.distro,
      osRelease:        osInfo.release,
      osCodename:       osInfo.codename || null,
      cpuSpeedGHz:      cpu.speed || null,
      osKernel:         osInfo.kernel,
      osArch:           osInfo.arch,
      hostname:         osInfo.hostname,
    },
    storage: diskLayout
      .filter(d => d.size > 0)
      .map(d => ({
        device:        d.device || null,
        type:          d.type || 'Unknown',   // HD | SSD | NVMe
        name:          d.name || null,
        sizeGB:        +(d.size / 1e9).toFixed(1),
        interfaceType: d.interfaceType || null,
        serialNum:     d.serialNum || null,
      })),
    // Block devices — termasuk removable (USB flash / SD card)
    blockDevices: blockDevices.map(b => ({
      name:      b.name,
      type:      b.type,
      fsType:    b.fsType || null,
      mount:     b.mount || null,
      sizeGB:    +(b.size / 1e9).toFixed(2),
      removable: !!b.removable,
      protocol:  b.protocol || null,
      label:     b.label || null,
    })),
    // Mount points (untuk lihat pemakaian disk per partisi)
    mounts: fsSize
      .filter(f => f.size > 0)
      .map(f => ({
        fs:          f.fs,
        type:        f.type,
        mount:       f.mount,
        sizeGB:      +(f.size / 1e9).toFixed(1),
        usedGB:      +(f.used / 1e9).toFixed(1),
        usedPercent: +(f.use || 0),
      })),
    // USB peripherals (keyboard, mouse, hub, dongle, dll — bukan hanya storage)
    usbDevices: usb.map(u => ({
      name:      (u.name || u.deviceName || 'Unknown USB device').trim(),
      vendor:    u.manufacturer || null,
      type:      u.type || null,
      removable: !!u.removable,
    })),
    // Network interfaces (untuk tahu interface mana yang aktif)
    networkInterfaces: activeIfaces.map(n => ({
      iface:     n.ifaceName || n.iface,
      ip4:       n.ip4 || null,
      ip6:       n.ip6 || null,
      mac:       n.mac || null,
      type:      n.type || null,
      speed:     n.speed || null,
      dhcp:      n.dhcp || null,
      virtual:   n.virtual || false,
    })),
    // IP lokal (LAN) — beberapa alias field agar cocok dengan Flutter client
    localIp,
    ip:          localIp,
    // IP publik (WAN, terdeteksi via layanan luar) — beberapa alias field
    publicIp,
    externalIp:  publicIp,
    wanIp:       publicIp,
  };
}

module.exports = { getSpec, getPublicIp };
