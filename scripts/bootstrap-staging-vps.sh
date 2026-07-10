#!/usr/bin/env bash
# Bootstrap / repair staging VPS — jalankan SEKALI di VPS jika:
#   - scripts/deploy-staging-vps.sh tidak ditemukan
#   - repo belum di-clone ke staging branch
#   - VPS pertama kali disetup
#
# Usage (di dalam VPS):
#   bash /tmp/bootstrap-staging-vps.sh
#
# Atau via SSH dari lokal:
#   ssh root@187.77.135.156 'bash -s' < be-bot-trading/scripts/bootstrap-staging-vps.sh

set -euo pipefail

STAGING_ROOT="/opt/quantara-staging"
BE_DIR="${STAGING_ROOT}/be"
REPO_URL="https://github.com/FahrasNH/be-quantara.git"
GIT_BRANCH="staging"
PM2_APP="quantara-staging"

echo "============================================"
echo "  Quantara Staging Bootstrap"
echo "  Target: ${BE_DIR}"
echo "  Branch: ${GIT_BRANCH}"
echo "============================================"

mkdir -p "${STAGING_ROOT}"

if [[ -d "${BE_DIR}/.git" ]]; then
  echo ""
  echo "==> Repo ditemukan — switch ke branch ${GIT_BRANCH} & pull..."
  cd "${BE_DIR}"
  git fetch origin
  git checkout "${GIT_BRANCH}" || git checkout -b "${GIT_BRANCH}" origin/"${GIT_BRANCH}"
  git pull origin "${GIT_BRANCH}"
else
  echo ""
  echo "==> Repo belum ada — clone branch ${GIT_BRANCH}..."
  git clone --branch "${GIT_BRANCH}" "${REPO_URL}" "${BE_DIR}"
  cd "${BE_DIR}"
fi

echo ""
echo "==> npm ci..."
npm ci

echo ""
echo "==> Cek .env..."
if [[ ! -f .env ]]; then
  echo "ERROR: .env tidak ditemukan!"
  echo "       Buat dari template: cp .env.staging.example .env"
  echo "       Lalu isi DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY"
  exit 1
fi

echo ""
echo "==> Prisma migrate (dengan baseline otomatis jika DB sudah ada)..."
# Cek apakah _prisma_migrations table sudah ada
MIGRATIONS_EXIST=$(npx prisma migrate status 2>&1 | grep -c "migrations found" || true)

if echo "$(npx prisma migrate status 2>&1)" | grep -q "P3005"; then
  echo "    Database sudah ada tapi belum punya migration history (P3005)."
  echo "    Baseline migration lama, lalu deploy yang baru..."
  npx prisma migrate resolve --applied 20260605070912_init_postgres
  npx prisma migrate resolve --applied 20260605082249_add_token_hash_to_session
fi

npx prisma migrate deploy

echo ""
echo "==> PM2 restart ${PM2_APP}..."
if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  pm2 restart "${PM2_APP}"
else
  echo "    PM2 app belum ada — start dari ecosystem.config.js atau index.js..."
  pm2 start ecosystem.config.js --only "${PM2_APP}" 2>/dev/null \
    || pm2 start index.js --name "${PM2_APP}"
fi
pm2 save

echo ""
echo "==> Health check..."
sleep 3
if curl -sf "http://127.0.0.1:3001/health" > /dev/null; then
  echo "    ✅ Backend UP — http://127.0.0.1:3001/health"
else
  echo "    ⚠️  Health check gagal — cek: pm2 logs ${PM2_APP}"
fi

echo ""
echo "============================================"
echo "  Bootstrap selesai!"
echo "  Deploy berikutnya cukup:"
echo "    bash scripts/deploy-staging-vps.sh"
echo "============================================"
