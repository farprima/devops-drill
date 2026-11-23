# devops-drill: tryout-api

API kecil untuk tryout sekolah (mirip TryoutPintar): siswa mengirim skor tryout, lalu ada leaderboard 10 besar. Stack-nya sama dengan yang dipakai di Newus Teknologi: TypeScript, Express 5, PostgreSQL, Redis, berjalan di Linux.

Aplikasinya sudah jadi. Yang jadi latihan adalah semua hal DevOps di sekitarnya: Dockerfile, Compose, GitHub Actions, deploy ke VM Linux, dan backup database. Lihat bagian [Latihan](#latihan).

## Isi repo

| Path | Isi |
| --- | --- |
| `src/app.ts` | `createApp({ store, cache })`: route, validasi (zod), cache leaderboard, error handler JSON |
| `src/store.ts` | Akses PostgreSQL lewat `pg` Pool (`DATABASE_URL`) |
| `src/cache.ts` | Akses Redis lewat `redis` v5 (`REDIS_URL`) |
| `src/migrate.ts` | Menjalankan `migrations/*.sql` saat startup (sekali per file, dengan advisory lock) |
| `src/server.ts` | Entry point: baca env, migrasi, listen, log JSON per request, graceful shutdown (SIGTERM/SIGINT) |
| `test/` | Test vitest + supertest dengan fake store/cache, tidak butuh database |

Perilaku yang penting untuk sisi DevOps:

- Konfigurasi hanya dari environment: `PORT` (default 3000), `HOST` (default `0.0.0.0`), `DATABASE_URL`, `REDIS_URL`. Kalau `DATABASE_URL` atau `REDIS_URL` tidak ada, proses langsung keluar dengan exit code 1.
- Migrasi jalan otomatis saat start. Kalau PostgreSQL belum bisa dihubungi, proses keluar dengan exit code 1 (jadi perlu urutan start atau restart policy yang benar).
- Redis hanya cache: aplikasi tetap start dan tetap melayani request walau Redis mati, hanya saja leaderboard selalu `X-Cache: MISS`.
- Log berupa satu baris JSON per request di stdout, contoh: `{"time":"...","level":"info","msg":"request","method":"GET","path":"/health","status":200,"ms":3.1}`.
- Saat menerima SIGTERM atau SIGINT, server berhenti menerima koneksi baru, menunggu request yang sedang jalan, menutup pool PostgreSQL dan koneksi Redis, lalu menulis log `"msg":"bye"` dan keluar dengan exit code 0. Kalau lebih dari 10 detik, dipaksa keluar dengan exit code 1.

## Menjalankan lokal tanpa Docker

Butuh Node.js 22 atau lebih baru, PostgreSQL, dan Redis yang sudah berjalan.

```bash
npm ci
cp .env.example .env          # sesuaikan DATABASE_URL dan REDIS_URL
npm test                      # tidak butuh database
npm run dev                   # tsx watch, membaca .env otomatis

# atau build lalu jalankan hasil build
npm run build
node --env-file=.env dist/server.js
```

Database `tryout` dengan user `app` / password `app` harus sudah ada, contoh di PostgreSQL lokal:

```bash
sudo -u postgres psql -c "CREATE ROLE app LOGIN PASSWORD 'app';" -c "CREATE DATABASE tryout OWNER app;"
```

Script npm: `build` (tsc ke `dist/`), `start` (`node dist/server.js`), `dev`, `test`, `typecheck`.

## Endpoint

### `GET /health`

200 kalau PostgreSQL bisa dihubungi, 503 kalau tidak. Status Redis hanya dilaporkan.

```bash
curl -i http://localhost:3000/health
# 200 {"status":"ok","db":"ok","redis":"ok"}
# 200 {"status":"ok","db":"ok","redis":"down"}   Redis mati, API tetap jalan
# 503 {"status":"error","db":"down","redis":"ok"}
```

### `POST /api/submissions`

Body: `student` (string 1-80 karakter) dan `score` (integer 0-100). Membalas 201 dengan baris yang tersimpan, dan menghapus cache leaderboard.

```bash
curl -i -X POST http://localhost:3000/api/submissions \
  -H 'Content-Type: application/json' \
  -d '{"student":"Budi","score":87}'
# 201 {"id":1,"student":"Budi","score":87,"createdAt":"2026-11-23T08:00:00.000Z"}

curl -i -X POST http://localhost:3000/api/submissions \
  -H 'Content-Type: application/json' \
  -d '{"student":"","score":150}'
# 400 {"error":"validation_failed","issues":[{"path":"student","message":"..."},{"path":"score","message":"..."}]}
```

### `GET /api/leaderboard`

10 skor tertinggi (skor turun, yang lebih dulu submit menang kalau seri). Pola cache-aside: hasil disimpan di Redis key `leaderboard` dengan TTL 30 detik, dan dihapus setiap ada submission baru. Header `X-Cache` menunjukkan sumbernya.

```bash
curl -i http://localhost:3000/api/leaderboard   # X-Cache: MISS (dari PostgreSQL)
curl -i http://localhost:3000/api/leaderboard   # X-Cache: HIT  (dari Redis)
```

## Latihan

Kerjakan berurutan, tulis sendiri semua filenya. Setiap latihan selesai kalau semua kriteria "selesai" terpenuhi. Tidak ada contoh jawaban di branch `main`.

### L1 - Dockerfile

Buat `Dockerfile` multi-stage dan `.dockerignore`.

Selesai kalau:
- `docker build -t tryout-api .` berhasil dari clone yang bersih.
- Image akhir di bawah sekitar 250 MB (`docker image ls tryout-api`).
- Image akhir hanya berisi yang dibutuhkan saat runtime: tidak ada devDependencies, tidak ada source TypeScript, tidak ada compiler.
- Proses di container tidak berjalan sebagai root (`docker run --rm tryout-api id` tidak menunjukkan `uid=0`).
- `.dockerignore` mencegah `node_modules`, `dist`, `.env`, dan `.git` masuk ke build context.
- `docker stop` pada container yang sedang jalan menghasilkan log `"msg":"bye"` dalam beberapa detik, bukan dibunuh paksa setelah 10 detik.

### L2 - Docker Compose

Buat `compose.yml` berisi tiga service: `api` (di-build dari Dockerfile L1), `postgres:17`, dan `redis:7`.

Selesai kalau:
- Setiap service punya healthcheck, dan `api` memakai `depends_on` dengan `condition: service_healthy`.
- Data PostgreSQL disimpan di named volume: setelah `docker compose down` lalu `up` lagi, data submission masih ada; setelah `docker compose down -v`, data hilang.
- Environment memakai nilai default (`${VAR:-default}`), jadi bisa jalan tanpa file `.env`, tapi tetap bisa di-override.
- `docker compose up -d --wait` selesai dengan exit code 0, lalu `curl localhost:3000/health` membalas `{"status":"ok","db":"ok","redis":"ok"}`.
- Port PostgreSQL dan Redis tidak dibuka ke host, hanya port API.

### L3 - GitHub Actions

Buat `.github/workflows/ci.yml`.

Selesai kalau:
- Job `test` (npm ci, typecheck, test) jalan di setiap push dan pull request.
- Job `smoke` menjalankan stack Compose dari L2 di runner, curl `/health`, dan gagal kalau hasilnya tidak ok. Stack dibersihkan di akhir.
- Job `image` hanya jalan setelah `test` (dan `smoke`) lulus, dan hanya mem-push di branch `main`: build lalu push ke `ghcr.io/farprima/devops-drill` dengan tag `latest` dan tag SHA commit.
- Login ke GHCR memakai `GITHUB_TOKEN` dengan permission `packages: write`, tanpa personal access token.
- Satu run di `main` hijau semua, dan image muncul di tab Packages repo ini.

### L4 - Deploy ke VM Linux

Deploy ke VM Linux di Mac (Multipass) memakai image dari GHCR, bukan build di VM.

Selesai kalau:
- Di VM sudah `docker login ghcr.io` (token dengan scope `read:packages`), dan ada file compose produksi yang memakai image GHCR, bukan `build:`.
- Update versi cukup dengan `docker compose pull && docker compose up -d`.
- nginx di VM menjadi reverse proxy di port 80: dari Mac, `curl http://<ip-vm>/health` membalas ok, sedangkan port 3000 tidak bisa diakses langsung dari luar VM.
- Setelah VM di-restart (`multipass restart <nama-vm>`), API hidup lagi tanpa perintah manual.
- Rollback: pin image ke tag SHA sebelumnya, jalankan ulang, `/health` tetap ok, dan kamu bisa menunjukkan SHA mana yang sedang berjalan.

### L5 - Backup dan restore

Buat `scripts/backup.sh`.

Selesai kalau:
- Script melakukan `pg_dump` dari container database, hasilnya di-gzip dengan nama berisi tanggal dan jam, misalnya `tryout-20261123-020000.sql.gz`.
- Hanya 7 backup terbaru yang disimpan: jalankan 9 kali, sisa 7 file.
- Script berhenti dengan exit code bukan 0 kalau ada langkah yang gagal (dan tidak meninggalkan file backup kosong sebagai "berhasil").
- Ada baris crontab yang menjalankan backup setiap hari dan menyimpan log-nya.
- Restore test: backup di-restore ke database baru yang masih kosong, lalu jumlah baris `submissions` sama dengan database asli.

### Branch `reference`

Ada branch `reference` berisi satu contoh solusi untuk L1-L5 yang sudah terbukti hijau di GitHub Actions. Jangan dibuka sebelum mencoba sendiri: mentor memakainya untuk membandingkan dan memberi petunjuk bertahap, jadi latihannya hilang kalau jawabannya sudah dibaca duluan.
