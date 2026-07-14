#!/usr/bin/env bash
# One-time development BE setup on VPS (Postgres + clone + .env + migrate + PM2).
#
# Usage (on VPS as root):
#   bash scripts/setup-development-vps.sh
#
# Or from local machine (after SSH key or password auth works):
#   ssh root@187.77.135.156 'bash -s' < be-bot-trading/scripts/setup-development-vps.sh
#
# Env overrides:
#   QUANTARA_BE_REPO  — default https://github.com/FahrasNH/be-quantara.git
#   DEV_DB_PASS       — Postgres password (auto-generated if unset)

set -euo pipefail

DEV_ROOT="/opt/quantara-dev"
BE_DIR="${DEV_ROOT}/be"
REPO_URL="${QUANTARA_BE_REPO:-https://github.com/FahrasNH/be-quantara.git}"
GIT_BRANCH="${GIT_BRANCH:-development}"
PM2_APP="${PM2_APP:-be-quantara-dev}"
DB_NAME="bot_trading_development"
DB_USER="quantara_dev"
DB_PASS="${DEV_DB_PASS:-$(openssl rand -hex 16)}"

echo "==> Quantara development BE setup"
echo "    Path:   ${BE_DIR}"
echo "    Branch: ${GIT_BRANCH}"
echo "    DB:     ${DB_NAME}"
echo "    PM2:    ${PM2_APP} (port 3002)"

if command -v psql >/dev/null 2>&1; then
  echo "==> Creating Postgres database (if not exists)..."
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  sudo -u postgres psql -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};" 2>/dev/null || true
  echo "    DB user: ${DB_USER}"
  echo "    DB pass: ${DB_PASS}  (saved into .env — store securely)"
else
  echo "WARN: psql not found — create database ${DB_NAME} and user ${DB_USER} manually."
fi

mkdir -p "${DEV_ROOT}"
if [[ -d "${BE_DIR}/.git" ]]; then
  echo "==> git fetch + checkout ${GIT_BRANCH}..."
  git -C "${BE_DIR}" fetch origin "${GIT_BRANCH}"
  git -C "${BE_DIR}" checkout "${GIT_BRANCH}" 2>/dev/null \
    || git -C "${BE_DIR}" checkout -b "${GIT_BRANCH}" "origin/${GIT_BRANCH}"
  git -C "${BE_DIR}" reset --hard "origin/${GIT_BRANCH}"
else
  echo "==> git clone branch ${GIT_BRANCH}..."
  git clone --branch "${GIT_BRANCH}" "${REPO_URL}" "${BE_DIR}"
fi

cd "${BE_DIR}"

if [[ ! -f package-lock.json ]]; then
  npm install --legacy-peer-deps
else
  npm ci --legacy-peer-deps 2>/dev/null || npm install --legacy-peer-deps
fi

if [[ ! -f .env ]]; then
  if [[ ! -f .env.development.example ]]; then
    echo "ERROR: .env.development.example missing in repo — pull latest development branch."
    exit 1
  fi
  echo "==> Creating .env from .env.development.example..."
  cp .env.development.example .env
  sed -i.bak "s|GANTI_PASSWORD|${DB_PASS}|g" .env && rm -f .env.bak
  sed -i.bak "s|GANTI_DENGAN_HASIL_openssl_rand_hex_48|$(openssl rand -hex 48)|g" .env && rm -f .env.bak
  sed -i.bak "s|GANTI_DENGAN_HASIL_BERBEDA_openssl_rand_hex_48|$(openssl rand -hex 48)|g" .env && rm -f .env.bak
  sed -i.bak "s|GANTI_DENGAN_HASIL_openssl_rand_hex_32|$(openssl rand -hex 32)|g" .env && rm -f .env.bak
  echo "    .env created at ${BE_DIR}/.env"
else
  echo "==> .env already exists — skip"
fi

bash scripts/ensure-allowed-exchanges.sh .env 2>/dev/null || true

echo "==> prisma migrate deploy..."
npx prisma migrate deploy || {
  echo "⚠️  migrate deploy failed — recovering stuck payment migration (P3018)..."
  npx prisma migrate resolve --rolled-back 20260625120000_add_payment_voucher_system || true
  npx prisma migrate deploy
}

node --check index.js
node --check ecosystem.config.js

echo "==> pm2 startOrReload ${PM2_APP}..."
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env \
  || pm2 start ecosystem.config.js --only "${PM2_APP}"
pm2 save

mkdir -p /var/www/quantara-dev/fe

sleep 2
if curl -sf "http://127.0.0.1:3002/api/v1/health" >/dev/null; then
  echo "✓ GET /api/v1/health OK"
else
  echo "⚠️  Health check failed — run: pm2 logs ${PM2_APP} --lines 50"
fi

echo ""
echo "==> Development BE setup complete."
echo "    Next: cd fe-bot-trading && ./deploy-development.sh --be-only"
echo "    (FE may already be deployed to /var/www/quantara-dev/fe)"
