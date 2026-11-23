#!/usr/bin/env bash
# Uji restore: backup terbaru (atau file yang diberikan) di-restore ke database baru yang kosong,
# lalu jumlah baris submissions dibandingkan dengan database asli. Database uji dihapus lagi di akhir.
# Backup yang belum pernah dicoba restore belum terbukti bisa dipakai.
#
# Pemakaian: scripts/restore-test.sh [backups/tryout-YYYYmmdd-HHMMSS.sql.gz]
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-$PWD/backups}"
DB_SERVICE="${DB_SERVICE:-db}"
file="${1:-$(find "$BACKUP_DIR" -maxdepth 1 -name 'tryout-*.sql.gz' -print | sort | tail -n 1)}"
[[ -n "$file" && -f "$file" ]] || { echo "tidak ada file backup" >&2; exit 1; }

restore_db="tryout_restore_$(date +%s)"

# psql di dalam container db, sebagai user dari env container. ON_ERROR_STOP: error SQL = exit bukan 0.
psql_in_db() {
  docker compose exec -T "$DB_SERVICE" sh -c 'psql --username "$POSTGRES_USER" -v ON_ERROR_STOP=1 -qtA "$@"' psql "$@"
}

cleanup() { psql_in_db --dbname postgres -c "DROP DATABASE IF EXISTS $restore_db" >/dev/null || true; }
trap cleanup EXIT

psql_in_db --dbname postgres -c "CREATE DATABASE $restore_db" >/dev/null
gunzip -c "$file" | psql_in_db --dbname "$restore_db" >/dev/null

source_db="$(docker compose exec -T "$DB_SERVICE" sh -c 'echo "$POSTGRES_DB"')"
# Catatan: kalau ada submission baru setelah backup dibuat, angka asli bisa lebih besar. Jalankan langsung setelah backup.
original="$(psql_in_db --dbname "$source_db" -c 'SELECT count(*) FROM submissions')"
restored="$(psql_in_db --dbname "$restore_db" -c 'SELECT count(*) FROM submissions')"

echo "backup:   $file"
echo "asli:     $original baris di $source_db"
echo "restore:  $restored baris di $restore_db"
if [[ "$original" != "$restored" ]]; then
  echo "RESTORE TEST GAGAL: jumlah baris berbeda" >&2
  exit 1
fi
echo "restore test ok"
