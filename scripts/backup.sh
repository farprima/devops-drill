#!/usr/bin/env bash
# Backup database tryout dari container db (Compose) ke backups/tryout-YYYYmmdd-HHMMSS.sql.gz,
# lalu simpan hanya KEEP backup terbaru.
#
# Pemakaian (dari folder yang berisi compose.yml, atau set COMPOSE_FILE):
#   scripts/backup.sh
#   BACKUP_DIR=/var/backups/tryout KEEP=14 scripts/backup.sh
#
# Crontab (crontab -e), setiap hari jam 02:00, output ke log. cron tidak memakai PATH dan cwd shell biasa,
# jadi cd dulu dan pakai path absolut:
#   0 2 * * * cd /opt/tryout && ./scripts/backup.sh >> /var/log/tryout-backup.log 2>&1

# -e: berhenti di error pertama, -u: variabel kosong = error, pipefail: pipeline gagal kalau pg_dump gagal,
# bukan hanya kalau perintah terakhir (gzip) gagal. Tanpa pipefail, dump yang gagal tetap "sukses".
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
KEEP="${KEEP:-7}"
DB_SERVICE="${DB_SERVICE:-db}"

mkdir -p "$BACKUP_DIR"

# Satu backup dalam satu waktu: kalau cron masih jalan dan dipanggil lagi, yang kedua langsung keluar.
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo "backup lain masih berjalan" >&2; exit 1; }

stamp="$(date +%Y%m%d-%H%M%S)"
target="$BACKUP_DIR/tryout-$stamp.sql.gz"
# Tulis ke file sementara dulu, baru rename setelah sukses: backup setengah jadi tidak pernah terlihat
# seperti backup yang valid, dan trap menghapusnya kalau script gagal di tengah jalan.
partial="$target.partial"
trap 'rm -f "$partial"' EXIT

# -T: tanpa TTY. Wajib di cron (tidak ada terminal) dan supaya output biner tidak dirusak TTY.
# Kredensial diambil dari env container itu sendiri, jadi password tidak ditulis di script ini.
# --clean --if-exists: dump berisi DROP ... IF EXISTS, jadi bisa di-restore ke database yang sudah berisi.
docker compose exec -T "$DB_SERVICE" sh -c \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-owner --clean --if-exists' \
  | gzip -9 > "$partial"

# Pastikan file gzip utuh sebelum dianggap backup.
gzip -t "$partial"
mv "$partial" "$target"
echo "$(date -Is) backup ok: $target ($(du -h "$target" | cut -f1))"

# Rotasi: nama file berisi timestamp, jadi urutan nama = urutan waktu. Hapus semua kecuali KEEP terbaru.
find "$BACKUP_DIR" -maxdepth 1 -name 'tryout-*.sql.gz' -print | sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
