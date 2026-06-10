#!/usr/bin/env bash
# Deploy backend staging di VPS (git pull, migrate, restart PM2).
# Bisa dijalankan langsung di server ATAU via SSH dari deploy-staging.sh (FE).
#
# Usage (di VPS):
#   cd /opt/quantara-staging/be-bot-trading && ./scripts/deploy-staging-vps.sh
#
# Env:
#   PM2_APP     — nama proses PM2 (default: quantara-staging)
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

echo "==> npm ci..."
npm ci

echo "==> prisma migrate deploy..."
npx prisma migrate deploy

if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  echo "==> pm2 restart ${PM2_APP}..."
  pm2 restart "${PM2_APP}"
else
  echo "==> pm2 start (app belum ada)..."
  pm2 start ecosystem.config.js --only be-quantara-staging 2>/dev/null \
    || pm2 start index.js --name "${PM2_APP}"
fi

pm2 save

echo ""
echo "==> Health check..."
sleep 2
curl -sf "http://127.0.0.1:3001/health" && echo "" || echo "WARN: health check gagal — cek: pm2 logs ${PM2_APP}"
echo "Done."
