#!/usr/bin/env bash
# Deploy backend production di VPS (git pull, migrate, restart PM2).
# Bisa dijalankan langsung di server ATAU via SSH dari deploy-production.sh (FE).
#
# Usage (di VPS):
#   cd /path/to/be-bot-trading && ./scripts/deploy-production-vps.sh
#
# Env:
#   PM2_APP     — nama proses PM2 (default: be-quantara)
#   GIT_BRANCH  — branch yang di-pull (default: main)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_APP="${PM2_APP:-be-quantara}"
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

echo "==> npm ci..."
npm ci

echo "==> prisma migrate deploy..."
npx prisma migrate deploy

if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  echo "==> pm2 restart ${PM2_APP}..."
  pm2 restart "${PM2_APP}"
else
  echo "==> pm2 start (app belum ada)..."
  pm2 start ecosystem.config.js --only quantara 2>/dev/null \
    || pm2 start index.js --name "${PM2_APP}"
fi

pm2 save

echo ""
echo "==> Health check..."
sleep 2
curl -sf "http://127.0.0.1:3000/health" && echo "" || echo "WARN: health check gagal — cek: pm2 logs ${PM2_APP}"
echo "Done."
