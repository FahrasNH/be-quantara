#!/usr/bin/env bash
# Deploy BE development ke VPS dari laptop (tanpa clone FE).
#
# Usage (dari root be-quantara):
#   bash scripts/deploy-development-remote.sh
#   npm run deploy:dev
#
# Prasyarat:
#   1. Kode sudah di-push ke origin/development
#   2. SSH ke VPS jalan (ssh root@187.77.135.156)
#
# Env opsional:
#   VPS_HOST=root@187.77.135.156
#   REMOTE_BE=/opt/quantara-dev/be
#   SKIP_PUSH_CHECK=1   — lewati peringatan unpushed commits

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-dev/be}"
GIT_BRANCH="${GIT_BRANCH:-development}"

cd "${BE_DIR}"

echo "==> Deploy BE development (remote)"
echo "    VPS:    ${VPS_HOST}"
echo "    Path:   ${REMOTE_BE}"
echo "    Branch: ${GIT_BRANCH}"
echo ""

if [[ "${SKIP_PUSH_CHECK:-0}" != "1" ]]; then
  git fetch origin "${GIT_BRANCH}" 2>/dev/null || true
  LOCAL_SHA="$(git rev-parse HEAD 2>/dev/null || echo "")"
  REMOTE_SHA="$(git rev-parse "origin/${GIT_BRANCH}" 2>/dev/null || echo "")"
  if [[ -n "${LOCAL_SHA}" && -n "${REMOTE_SHA}" && "${LOCAL_SHA}" != "${REMOTE_SHA}" ]]; then
    echo "⚠️  Local HEAD (${LOCAL_SHA:0:7}) ≠ origin/${GIT_BRANCH} (${REMOTE_SHA:0:7})"
    echo "    Server akan pull dari GitHub. Push dulu jika ingin deploy commit lokal:"
    echo "      git push origin ${GIT_BRANCH}"
    echo ""
  fi
  if [[ -n "$(git status --porcelain 2>/dev/null | grep -v '^??' || true)" ]]; then
    echo "⚠️  Ada perubahan lokal yang belum di-commit — tidak ikut ter-deploy."
    echo ""
  fi
fi

if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "${VPS_HOST}" "test -d '${REMOTE_BE}/.git'" 2>/dev/null; then
  # BatchMode may fail if password auth — retry interactive check
  if ! ssh -o ConnectTimeout=15 "${VPS_HOST}" "test -d '${REMOTE_BE}/.git'"; then
    echo "ERROR: ${VPS_HOST}:${REMOTE_BE} bukan git checkout BE."
    echo "       Cek REMOTE_BE / bootstrap BE di VPS dulu."
    exit 1
  fi
fi

echo "==> SSH → pull + migrate + PM2 reload..."
# Pull dulu agar scripts/deploy-development-vps.sh terbaru tersedia, lalu jalankan.
# Fallback: inline deploy jika script belum ada di remote (chicken-and-egg first push).
ssh "${VPS_HOST}" "REMOTE_BE='${REMOTE_BE}' GIT_BRANCH='${GIT_BRANCH}' bash -s" << 'REMOTE'
set -euo pipefail
cd "${REMOTE_BE}"
git fetch origin "${GIT_BRANCH}"
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"
if [[ -f scripts/deploy-development-vps.sh ]]; then
  bash scripts/deploy-development-vps.sh
else
  echo "WARN: scripts/deploy-development-vps.sh belum ada di remote — inline fallback"
  PM2_APP=be-quantara-dev
  bash scripts/ensure-allowed-exchanges.sh .env 2>/dev/null || true
  npm ci --legacy-peer-deps 2>/dev/null || npm ci || npm install --legacy-peer-deps
  bash scripts/prisma-migrate-deploy.sh
  node --check index.js
  pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
    || pm2 start ecosystem.config.js --only "${PM2_APP}"
  pm2 save
  sleep 3
  curl -sf "http://127.0.0.1:3002/api/v1/health" && echo "" || echo "WARN: health check gagal"
fi
REMOTE

echo ""
echo "==> Done: https://dev.quantara.software"
