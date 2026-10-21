# RFMonitor Server Agent

Server Agent menyediakan HTTP API untuk monitoring mesin, metrik realtime,
PM2/Docker/systemd, log, preset, dan kontrol yang diizinkan. File Manager dan
terminal aplikasi **tidak** menggunakan Agent: keduanya terhubung langsung ke
SSH/SFTP pada alamat LAN atau Tailscale.

Repository installer: <https://github.com/RFDEVV/server-agent>

## Persyaratan

- Linux dengan systemd (Ubuntu/Debian disarankan)
- Node.js 18 atau lebih baru dan npm
- `curl`, `tar`, `sudo`, dan `visudo`
- Port TCP Agent (default `4200`) hanya dibuka untuk jaringan tepercaya, misalnya
  LAN/Tailscale atau reverse proxy HTTPS yang dikonfigurasi dengan benar
- SSH server dan subsystem SFTP aktif jika ingin memakai Terminal/File Manager

Jangan jalankan Agent sebagai root. Installer otomatis memakai akun yang
menjalankan `sudo`; jika dipanggil langsung dari root, installer membuat akun
sistem `rfmonitor-agent`.

## Setup otomatis (disarankan)

Periksa isi installer sebelum menjalankannya. Dari terminal server:

```sh
curl -fsSL https://raw.githubusercontent.com/RFDEVV/server-agent/main/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

Installer mengambil source `main` dari GitHub, memasangnya ke
`/opt/rfmonitor-agent`, membuat `.env` berisi `API_KEY` dan `JWT_SECRET`
acak, menginstal dependency production, membuat unit systemd, lalu
`enable --now` service `rfmonitor-agent`.

Pemeriksaan setelah instalasi:

```sh
sudo systemctl status rfmonitor-agent
sudo journalctl -u rfmonitor-agent -f
curl http://127.0.0.1:4200/ping
sudo grep -E '^(PORT|API_KEY)=' /opt/rfmonitor-agent/.env
```

Masukkan URL server dan `API_KEY` tersebut ke profil Server di aplikasi.
`API_KEY` adalah rahasia; jangan mengirimkannya di screenshot, chat, atau commit
GitHub. Jika `.env` sudah ada, installer tidak menimpa rahasia/kustomisasi
yang tersimpan.

### Mengaktifkan kontrol service yang diizinkan

Service yang dapat dikontrol sengaja tidak diizinkan secara default. Edit
allowlist pada server:

```sh
sudo nano /opt/rfmonitor-agent/.env
```

Contoh (hanya sebutkan unit yang memang ingin dikontrol):

```dotenv
ALLOWED_PM2_APPS=rfproject-platform,rfproject-bot
ALLOWED_SYSTEMD_SERVICES=nginx.service,docker.service
```

Kemudian pasang aturan sudo yang dibatasi tepat ke unit tersebut, validasi
sudoers, dan restart Agent:

```sh
sudo bash /opt/rfmonitor-agent/scripts/configure-systemd-sudo.sh \
  "$(systemctl show -p User --value rfmonitor-agent)"
sudo systemctl restart rfmonitor-agent
```

Perintah mengambil akun yang menjalankan Agent dari unit systemd. Script
helper hanya memberi izin `start`, `stop`, dan `restart`
untuk unit `.service` di `ALLOWED_SYSTEMD_SERVICES`; nama unit divalidasi dan
aturan diperiksa dengan `visudo`.

Untuk Docker, akun Agent harus menjadi anggota grup `docker` bila fitur
kontrol Docker dibutuhkan. Akses grup Docker pada praktiknya setara akses
root; aktifkan hanya jika memahami risikonya. Isi `ALLOWED_DOCKER_CONTAINERS`
dengan nama container yang diperbolehkan, jangan gunakan `*` kecuali memang
diinginkan.

PM2 harus dijalankan di bawah akun yang sama dengan Agent agar Agent dapat
melihat daemon dan log PM2 milik akun itu. Atur `ALLOWED_PM2_APPS` secara
eksplisit.

## Setup manual

Pastikan Node.js 18+, npm, Git, dan systemd sudah tersedia. Jalankan sebagai
akun administrator yang memiliki `sudo`; proses Agent sendiri tetap berjalan
sebagai akun non-root:

```sh
git clone --depth 1 https://github.com/RFDEVV/server-agent.git
cd server-agent
if ! id rfmonitor-agent >/dev/null 2>&1; then
  sudo useradd --system --user-group --create-home --home-dir /var/lib/rfmonitor-agent \
    --shell /usr/sbin/nologin rfmonitor-agent
fi
sudo install -d -o rfmonitor-agent -g rfmonitor-agent /opt/rfmonitor-agent
sudo cp -a . /opt/rfmonitor-agent/
sudo chown -R rfmonitor-agent:rfmonitor-agent /opt/rfmonitor-agent
sudo -u rfmonitor-agent cp /opt/rfmonitor-agent/.env.example \
  /opt/rfmonitor-agent/.env
```

Buat nilai rahasia yang berbeda dan acak, lalu ganti `API_KEY` dan `JWT_SECRET`
di `.env`. Jangan memakai nilai contoh. Batasi izin file:

```sh
sudo chmod 600 /opt/rfmonitor-agent/.env
sudo -u rfmonitor-agent -H npm --prefix /opt/rfmonitor-agent ci --omit=dev
```

Salin unit contoh lalu sesuaikan path Node.js bila bukan `/usr/bin/node`:

```sh
sudo cp /opt/rfmonitor-agent/systemd/rfmonitor-agent.service \
  /etc/systemd/system/rfmonitor-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now rfmonitor-agent
sudo systemctl status rfmonitor-agent
```

Unit contoh memakai `User=rfmonitor-agent`, `Group=rfmonitor-agent`, dan
`WorkingDirectory=/opt/rfmonitor-agent`. Jika memakai nama akun lain, ubah dua
baris `User`/`Group` dan pastikan akun memiliki akses baca ke source dan `.env`.
Untuk aturan systemd terbatas, isi `ALLOWED_SYSTEMD_SERVICES` kemudian jalankan
helper konfigurasi sudo di bagian setup otomatis.

### Menjalankan sementara/manual tanpa systemd

```sh
cd /opt/rfmonitor-agent
sudo -u rfmonitor-agent npm start
```

Proses berjalan di foreground dan berhenti saat terminal ditutup. Jangan
menjalankan mode ini bersamaan dengan service systemd pada port yang sama.

## Memperbarui Agent

Untuk instalasi otomatis, unduh ulang installer dari branch `main` dan
jalankan kembali. Installer memperbarui source/dependency dan unit, tetapi
mempertahankan `.env` yang ada. Setelah update:

```sh
sudo systemctl status rfmonitor-agent
sudo journalctl -u rfmonitor-agent -n 100 --no-pager
```

## Koneksi aplikasi dan jaringan

- `/ping` adalah health check tanpa autentikasi.
- Endpoint API lain memerlukan `API_KEY` untuk `POST /auth/login`, lalu token
  JWT.
- Agent memakai port `4200` secara default; ubah `PORT` di `.env` dan sesuaikan
  firewall/profil server jika perlu.
- Gunakan Local/Tailscale untuk koneksi privat. Jangan membuka port Agent ke
  internet tanpa HTTPS, firewall, dan reverse proxy yang dikelola dengan benar.
- Batasi `CORS_ORIGIN` bila aplikasi/proxy menggunakan origin browser tertentu.
- Service discovery mengembalikan error eksplisit bila seluruh provider gagal.
  Kegagalan provider tunggal dicatat dan tidak menghilangkan hasil provider
  yang lain.

## File Manager dan Terminal SSH

File Manager dan terminal memakai SSH/SFTP langsung dari perangkat ke server
melalui IP LAN atau Tailscale. Keduanya tidak melewati Server Agent dan tidak
memakai URL Cloudflare Tunnel. Pastikan port SSH dapat dijangkau, subsystem
SFTP aktif, dan akun SSH memiliki izin filesystem yang sesuai. Hindari
menggunakan akun root untuk koneksi aplikasi.

## Troubleshooting

```sh
sudo systemctl status rfmonitor-agent
sudo journalctl -u rfmonitor-agent -n 200 --no-pager
curl -v http://127.0.0.1:4200/ping
```

- **Service gagal start:** periksa log journal, path Node.js, file `.env`, dan
  kepemilikan folder.
- **Tidak bisa login dari aplikasi:** pastikan host/port, `API_KEY`, firewall,
  dan endpoint `/ping`.
- **PM2 kosong:** pastikan PM2 dijalankan oleh akun service Agent dan
  `ALLOWED_PM2_APPS` memuat nama aplikasi yang benar.
- **Kontrol systemd ditolak:** cek `ALLOWED_SYSTEMD_SERVICES`, jalankan ulang
  `configure-systemd-sudo.sh`, lalu periksa `visudo -c`.
- **File Manager gagal:** cek koneksi SSH/SFTP dan host LAN/Tailscale; masalah
  tersebut bukan berasal dari HTTP Agent.
