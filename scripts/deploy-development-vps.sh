#!/usr/bin/env bash
# Deploy backend development di VPS (git pull, migrate, restart PM2 be-quantara-dev).
#
# Usage (di VPS):
#   cd /opt/quantara-dev/be && ./scripts/deploy-development-vps.sh
#
# Env:
#   PM2_APP     — default: be-quantara-dev
#   GIT_BRANCH  — default: development

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PM2_APP="${PM2_APP:-be-quantara-dev}"
GIT_BRANCH="${GIT_BRANCH:-development}"

cd "${BE_DIR}"

echo "==> Deploy BE development"
echo "    Path:    ${BE_DIR}"
echo "    PM2 app: ${PM2_APP}"
echo "    Branch:  ${GIT_BRANCH}"

if [[ ! -f .env ]]; then
  echo "ERROR: .env tidak ditemukan. Salin .env.development.example → .env"
  exit 1
fi

git fetch origin "${GIT_BRANCH}"
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"

bash scripts/ensure-allowed-exchanges.sh .env

npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps

bash scripts/prisma-migrate-deploy.sh

node --check index.js
node --check src/server/app.js
node --check ecosystem.config.js

pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
  || pm2 start ecosystem.config.js --only "${PM2_APP}"

pm2 save

sleep 3
curl -sf "http://127.0.0.1:3002/api/v1/health" >/dev/null && echo "✓ health OK" \
  || echo "❌ health FAILED — pm2 logs ${PM2_APP} --lines 50"
