# syntax=docker/dockerfile:1

# Satu ARG di atas supaya versi Node cukup diganti di satu tempat (dan bisa di-override: --build-arg NODE_VERSION=22).
ARG NODE_VERSION=24

# Alpine: base image jauh lebih kecil dari node:24 (Debian), ukuran image akhir jadi sekitar 1/5.
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

# --- Stage deps: hanya dependency production untuk image akhir.
# --platform=$BUILDPLATFORM: stage ini jalan di arsitektur mesin build (amd64 di GitHub), tidak lewat emulasi
# saat membuat image arm64 (Mac M-series / Multipass). Aman karena semua dependency pure JS.
# Kalau nanti ada native module (bcrypt, sharp), hapus --platform di stage ini.
FROM --platform=$BUILDPLATFORM base AS deps
# Copy manifest dulu, source belakangan: layer npm ci tetap ke-cache selama package*.json tidak berubah.
COPY package.json package-lock.json ./
# Cache mount: download npm dipakai ulang antar build tanpa ikut masuk ke layer image.
# --ignore-scripts: tidak ada dependency yang butuh install script, jadi script pihak ketiga tidak dijalankan saat build.
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

# --- Stage build: devDependencies (typescript) hanya ada di sini, lalu dibuang.
FROM --platform=$BUILDPLATFORM base AS build
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage runtime: yang dikirim ke server. Tidak ada compiler, source TS, atau devDependencies.
FROM base AS runtime
ENV NODE_ENV=production
# File tetap milik root (hanya bisa dibaca oleh user node), jadi proses app tidak bisa mengubah kodenya sendiri.
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Migrasi dibaca saat startup dari ../migrations relatif ke dist/, jadi wajib ikut.
COPY migrations ./migrations
# User "node" (uid 1000) sudah ada di image resmi; jangan jalankan app sebagai root.
USER node
EXPOSE 3000
# Exec form (array), bukan "npm start": node jadi PID 1 dan menerima SIGTERM langsung dari docker stop,
# sehingga graceful shutdown di server.ts benar-benar jalan. npm/sh tidak meneruskan sinyal dengan benar.
CMD ["node", "dist/server.js"]
