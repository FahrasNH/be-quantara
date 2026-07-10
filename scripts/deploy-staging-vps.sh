#!/usr/bin/env bash
# Deploy backend staging di VPS (git pull, migrate, restart PM2).
# Bisa dijalankan langsung di server ATAU via SSH dari deploy-staging.sh (FE).
#
# Usage (di VPS):
#   cd /opt/quantara-staging/be && ./scripts/deploy-staging-vps.sh
#
# Env:
#   PM2_APP     — nama proses PM2 (default: be-quantara-staging)
#   GIT_BRANCH  — branch yang di-pull (default: staging)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_APP="${PM2_APP:-be-quantara-staging}"
GIT_BRANCH="${GIT_BRANCH:-staging}"

cd "${BE_DIR}"

echo "==> Deploy BE staging"
echo "    Path:    ${BE_DIR}"
echo "    PM2 app: ${PM2_APP}"
echo "    Branch:  ${GIT_BRANCH}"

if [[ ! -f .env ]]; then
  echo "ERROR: .env tidak ditemukan. Jalankan scripts/setup-staging-vps.sh atau salin .env.staging.example → .env"
  exit 1
fi

echo "==> git fetch origin ${GIT_BRANCH}..."
git fetch origin "${GIT_BRANCH}"

# Deploy server: selaraskan ke origin (hindari merge conflict dari file lokal/manual)
echo "==> git reset --hard origin/${GIT_BRANCH}..."
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"

bash scripts/ensure-allowed-exchanges.sh .env

echo "==> npm ci..."
npm ci

echo "==> prisma migrate deploy..."
npx prisma migrate deploy

# PENTING (OOM-loop fix): `pm2 restart <nama>` TIDAK membaca ulang
# max_memory_restart dari ecosystem.config.js — opsi PM2-level itu hanya
# diterapkan saat proses dibuat DARI file ecosystem. Akibatnya fix 512M→1024M
# tidak pernah aktif & proses tetap OOM-restart ~tiap 30s. `startOrReload` dengan
# FILE ecosystem memaksa PM2 membaca ulang seluruh opsi runtime (termasuk limit
# memori). Bersihkan dulu proses bernama lama `quantara-staging` (pra-rename)
# agar tidak ada zombie yang menahan port 3001.
pm2 delete quantara-staging 2>/dev/null || true
echo "==> pm2 startOrReload ecosystem.config.js --only ${PM2_APP}..."
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
  || pm2 start ecosystem.config.js --only "${PM2_APP}"

pm2 save

echo ""
echo "==> Health check..."
sleep 2
curl -sf "http://127.0.0.1:3001/health" && echo "" || echo "WARN: health check gagal — cek: pm2 logs ${PM2_APP}"
echo "Done."
