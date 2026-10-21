#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="https://github.com/RFDEVV/server-agent"
INSTALL_DIR="/opt/rfmonitor-agent"
UNIT_FILE="/etc/systemd/system/rfmonitor-agent.service"
SERVICE_NAME="rfmonitor-agent"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "Jalankan dengan sudo: sudo bash install.sh"
command -v node >/dev/null || fail "Node.js 18+ belum terpasang."
command -v npm >/dev/null || fail "npm tidak ditemukan."
command -v curl >/dev/null || fail "curl tidak ditemukan."
command -v tar >/dev/null || fail "tar tidak ditemukan."
command -v systemctl >/dev/null || fail "systemd/systemctl tidak ditemukan."

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
(( NODE_MAJOR >= 18 )) || fail "Node.js minimal versi 18 diperlukan (terdeteksi $(node --version))."

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  SERVICE_USER="$SUDO_USER"
else
  SERVICE_USER="rfmonitor-agent"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "/var/lib/${SERVICE_USER}" \
      --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
fi
id "$SERVICE_USER" >/dev/null 2>&1 || fail "User service tidak ditemukan: $SERVICE_USER"
[[ "$SERVICE_USER" != "root" ]] || fail "Server Agent tidak boleh dijalankan sebagai root."
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

printf 'Mengunduh source %s...\n' "$REPOSITORY"
curl --fail --silent --show-error --location \
  "${REPOSITORY}/archive/refs/heads/main.tar.gz" \
  --output "${TMP_DIR}/server-agent.tar.gz"
mkdir "${TMP_DIR}/source"
tar -xzf "${TMP_DIR}/server-agent.tar.gz" \
  --strip-components=1 -C "${TMP_DIR}/source"
[[ -f "${TMP_DIR}/source/package.json" && -f "${TMP_DIR}/source/index.js" ]] ||
  fail "Arsip GitHub tidak berisi package.json dan index.js di root repository."

install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" "$INSTALL_DIR"
cp -a "${TMP_DIR}/source/." "$INSTALL_DIR/"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  API_KEY="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")"
  cat >"${INSTALL_DIR}/.env" <<EOF
PORT=4200
API_KEY=${API_KEY}
JWT_SECRET=${JWT_SECRET}
ALLOWED_PM2_APPS=
ALLOWED_DOCKER_CONTAINERS=
ALLOWED_SYSTEMD_SERVICES=
ALLOW_POWER_CONTROL=false
POWER_IDLE_WATT=30
POWER_MAX_EXTRA_WATT=90
PLN_RATE_PER_KWH=1445
MONTHLY_INTERNET_COST=0
COMMAND_PRESETS=
CORS_ORIGIN=*
EOF
  chown "$SERVICE_USER:$SERVICE_GROUP" "${INSTALL_DIR}/.env"
  chmod 600 "${INSTALL_DIR}/.env"
fi

if grep -Eq '^(API_KEY|JWT_SECRET)=ganti-' "${INSTALL_DIR}/.env"; then
  fail "Konfigurasi .env masih memakai nilai contoh. Ganti API_KEY/JWT_SECRET lalu jalankan ulang installer."
fi

printf 'Memasang dependency production...\n'
runuser -u "$SERVICE_USER" -- npm --prefix "$INSTALL_DIR" ci --omit=dev

NODE_BIN="$(command -v node)"
cat >"$UNIT_FILE" <<EOF
[Unit]
Description=RFMonitor Server Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT_FILE"

systemctl daemon-reload
if [[ -f "${INSTALL_DIR}/scripts/configure-systemd-sudo.sh" ]]; then
  bash "${INSTALL_DIR}/scripts/configure-systemd-sudo.sh" "$SERVICE_USER" || \
    printf 'PERINGATAN: sudoers untuk service belum dibuat; cek allowlist dan visudo.\n' >&2
fi
systemctl enable --now "$SERVICE_NAME"
systemctl --no-pager --full status "$SERVICE_NAME" || true

printf '\nInstalasi selesai.\n'
printf 'Folder: %s\nService: %s\n' "$INSTALL_DIR" "$SERVICE_NAME"
printf 'API_KEY (jaga rahasia): sudo grep "^API_KEY=" %s/.env\n' "$INSTALL_DIR"
printf 'Log: sudo journalctl -u %s -f\n' "$SERVICE_NAME"
printf 'Ping lokal: curl http://127.0.0.1:4200/ping\n'
printf 'Edit allowlist: sudo nano %s/.env lalu jalankan ulang configure-systemd-sudo.sh dan restart service.\n' "$INSTALL_DIR"
