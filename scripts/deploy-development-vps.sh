#!/usr/bin/env bash
# Deploy backend development di VPS (git pull, migrate, restart PM2).
# Bisa dijalankan langsung di server ATAU via scripts/deploy-development-remote.sh.
#
# Usage (di VPS):
#   cd /opt/quantara-dev/be && ./scripts/deploy-development-vps.sh
#
# Env:
#   PM2_APP     — nama proses PM2 (default: be-quantara-dev)
#   GIT_BRANCH  — branch yang di-pull (default: development)

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
  echo "ERROR: .env tidak ditemukan. Salin .env.development.example → .env lalu isi secrets."
  exit 1
fi

echo "==> git fetch origin ${GIT_BRANCH}..."
git fetch origin "${GIT_BRANCH}"

echo "==> git reset --hard origin/${GIT_BRANCH}..."
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"

bash scripts/ensure-allowed-exchanges.sh .env 2>/dev/null || true

echo "==> npm ci..."
npm ci --legacy-peer-deps 2>/dev/null || npm ci || npm install --legacy-peer-deps

echo "==> prisma migrate deploy..."
bash scripts/prisma-migrate-deploy.sh

echo "==> Syntax check (fail fast before PM2 reload)..."
node --check index.js
node --check src/server/app.js
node --check ecosystem.config.js

echo "==> pm2 startOrReload ecosystem.config.js --only ${PM2_APP}..."
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
  || pm2 start ecosystem.config.js --only "${PM2_APP}"

pm2 save

echo ""
echo "==> Health check..."
sleep 3
HEALTH_OK=false
if curl -sf "http://127.0.0.1:3002/health" >/dev/null 2>&1; then
  echo "✓ GET /health OK"
  HEALTH_OK=true
else
  echo "❌ GET /health FAILED — cek: pm2 logs ${PM2_APP} --lines 50"
fi
if curl -sf "http://127.0.0.1:3002/api/v1/health" >/dev/null 2>&1; then
  echo "✓ GET /api/v1/health OK"
  HEALTH_OK=true
else
  echo "❌ GET /api/v1/health FAILED"
  HEALTH_OK=false
fi
LOGIN_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:3002/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"deploy-check@test.com","password":"wrong"}' || echo "000")
if [[ "${LOGIN_CODE}" == "401" || "${LOGIN_CODE}" == "400" ]]; then
  echo "✓ POST /api/v1/auth/login reachable (HTTP ${LOGIN_CODE})"
else
  echo "❌ POST /api/v1/auth/login returned HTTP ${LOGIN_CODE} (expect 401/400, not 502/000)"
  HEALTH_OK=false
fi
if [[ "${HEALTH_OK}" != "true" ]]; then
  echo "WARN: development BE not fully healthy — investigate before QA"
  pm2 logs "${PM2_APP}" --lines 30 --nostream 2>&1 | tail -35 || true
fi
echo "Done: https://dev.quantara.software"
