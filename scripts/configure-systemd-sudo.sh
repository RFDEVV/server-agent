#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/opt/rfmonitor-agent/.env"
SUDOERS_FILE="/etc/sudoers.d/rfmonitor-agent"
SERVICE_USER="${1:-rfmonitor-agent}"
SYSTEMCTL="$(command -v systemctl || true)"

[[ "${EUID}" -eq 0 ]] || {
  echo "Jalankan sebagai root: sudo bash scripts/configure-systemd-sudo.sh [service-user]" >&2
  exit 1
}
[[ -f "$ENV_FILE" ]] || {
  echo "File konfigurasi tidak ditemukan: $ENV_FILE" >&2
  exit 1
}
[[ -n "$SYSTEMCTL" ]] || {
  echo "systemctl tidak ditemukan." >&2
  exit 1
}
id "$SERVICE_USER" >/dev/null 2>&1 || {
  echo "User service tidak ditemukan: $SERVICE_USER" >&2
  exit 1
}

ALLOWLIST="$(sed -n 's/^ALLOWED_SYSTEMD_SERVICES=//p' "$ENV_FILE" | tail -n 1)"
ALLOWLIST="${ALLOWLIST//[[:space:]]/}"
if [[ -z "$ALLOWLIST" ]]; then
  if [[ -f "$SUDOERS_FILE" ]]; then
    rm "$SUDOERS_FILE"
    echo "Allowlist kosong; aturan sudo khusus Server Agent dihapus."
  else
    echo "Allowlist kosong; tidak ada aturan sudo yang diperlukan."
  fi
  exit 0
fi

IFS=',' read -r -a UNITS <<< "$ALLOWLIST"
COMMANDS=()
for unit in "${UNITS[@]}"; do
  [[ "$unit" =~ ^[A-Za-z0-9_.@:-]+\.service$ ]] || {
    echo "Nama unit tidak aman/tidak valid: $unit (gunakan nama lengkap berakhiran .service)" >&2
    exit 1
  }
  for action in start stop restart; do
    COMMANDS+=("${SYSTEMCTL} ${action} ${unit}")
  done
done

COMMAND_LIST="$(IFS=', '; echo "${COMMANDS[*]}")"
TEMP_FILE="$(mktemp /etc/sudoers.d/rfmonitor-agent.XXXXXX)"
trap 'rm -f "$TEMP_FILE"' EXIT
printf '%s ALL=(root) NOPASSWD: %s\n' "$SERVICE_USER" "$COMMAND_LIST" > "$TEMP_FILE"
chmod 0440 "$TEMP_FILE"
visudo -cf "$TEMP_FILE"
install -o root -g root -m 0440 "$TEMP_FILE" "$SUDOERS_FILE"
visudo -c
echo "Aturan sudo systemd dibuat hanya untuk unit yang diizinkan: ${UNITS[*]}"
