#!/usr/bin/env bash
# Deploy backend production di VPS (git pull, migrate, restart PM2).
# Bisa dijalankan langsung di server ATAU via SSH dari deploy-production.sh (FE).
#
# Usage (di VPS):
#   cd /path/to/be-bot-trading && ./scripts/deploy-production-vps.sh
#
# Env:
#   PM2_APP     — nama proses PM2 (default: be-quantara-prod — selaras ecosystem.config.js)
#   GIT_BRANCH  — branch yang di-pull (default: main)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_APP="${PM2_APP:-be-quantara-prod}"
GIT_BRANCH="${GIT_BRANCH:-main}"

cd "${BE_DIR}"

echo "==> Deploy BE production"
echo "    Path:    ${BE_DIR}"
echo "    PM2 app: ${PM2_APP}"
echo "    Branch:  ${GIT_BRANCH}"

if [[ ! -f .env ]]; then
  echo "ERROR: .env tidak ditemukan. Salin .env.production.example → .env dan isi secrets."
  exit 1
fi

echo "==> git pull origin ${GIT_BRANCH}..."
git pull origin "${GIT_BRANCH}"

bash scripts/ensure-allowed-exchanges.sh .env

echo "==> npm ci..."
npm ci

echo "==> Backup DB sebelum migrate (jaring pengaman)..."
bash scripts/backup-db.sh || {
  echo "ERROR: backup gagal — batalkan deploy sebelum menyentuh skema."
  exit 1
}

echo "==> prisma migrate deploy..."
npx prisma migrate deploy

# ── Gerbang drift: app TIDAK boleh restart di atas skema yang tak cocok ──────
# Menangkap kasus history desync (insiden 2026-06-10): migrate deploy "sukses"
# tapi skema sebenarnya tertinggal. migrate status akan melaporkan ketidakcocokan.
echo "==> Verifikasi skema (drift gate)..."
if ! npx prisma migrate status | grep -q "Database schema is up to date"; then
  echo "ERROR: Skema database TIDAK selaras dengan migrasi (drift terdeteksi)."
  echo "       App TIDAK di-restart. Investigasi: npx prisma migrate status"
  exit 1
fi

# PENTING (OOM-loop fix): `pm2 restart <nama>` TIDAK membaca ulang
# max_memory_restart dari ecosystem.config.js — opsi PM2-level itu hanya
# diterapkan saat proses dibuat DARI file ecosystem. Pakai `startOrReload` dengan
# FILE ecosystem agar limit memori (1024M) & opsi runtime lain terbaca ulang.
# Bersihkan dulu proses bernama lama `quantara-prod` (pra-rename) bila ada.
pm2 delete quantara-prod 2>/dev/null || true
echo "==> pm2 startOrReload ecosystem.config.js --only ${PM2_APP}..."
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
  || pm2 start ecosystem.config.js --only "${PM2_APP}"

pm2 save

echo ""
echo "==> Health check..."
sleep 2
curl -sf "http://127.0.0.1:3000/health" && echo "" || echo "WARN: health check gagal — cek: pm2 logs ${PM2_APP}"
echo "Done."
