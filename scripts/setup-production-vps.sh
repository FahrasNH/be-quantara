#!/usr/bin/env bash
# Setup backend production di VPS (first-time atau server baru).
# Jalankan DI SERVER sebagai root/sudo.
#
# Usage:
#   scp scripts/setup-production-vps.sh root@187.77.135.156:/tmp/
#   ssh root@187.77.135.156 'bash /tmp/setup-production-vps.sh'
#
# PERHATIAN: Script ini TIDAK menimpa .env jika sudah ada.

set -euo pipefail

PROD_ROOT="/opt/quantara"
BE_DIR="${PROD_ROOT}/be-bot-trading"
REPO_URL="${QUANTARA_BE_REPO:-https://github.com/FahrasNH/be-quantara.git}"
VPS_IP="${VPS_IP:-187.77.135.156}"
PM2_APP="${PM2_APP:-be-quantara}"
DB_NAME="${PROD_DB_NAME:-bot_trading}"

echo "==> Quantara production BE setup"
echo "    Path: ${BE_DIR}"
echo "    DB:   ${DB_NAME}"

mkdir -p "${PROD_ROOT}"
if [[ -d "${BE_DIR}/.git" ]]; then
  echo "==> git pull..."
  git -C "${BE_DIR}" pull origin main
else
  echo "==> git clone..."
  git clone "${REPO_URL}" "${BE_DIR}"
fi

cd "${BE_DIR}"
npm ci

if [[ ! -f .env ]]; then
  echo "==> Creating .env from .env.production.example..."
  if [[ ! -f .env.production.example ]]; then
    echo "ERROR: .env.production.example tidak ditemukan."
    exit 1
  fi
  cp .env.production.example .env
  echo ""
  echo "    PENTING: Edit ${BE_DIR}/.env — isi DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY, dll."
  echo "    Generate: openssl rand -hex 48  (JWT) | openssl rand -hex 32  (ENCRYPTION_KEY)"
  echo ""
  read -p "    Sudah edit .env? Lanjut migrate & start? [y/N] " -n 1 -r
  echo
  [[ "${REPLY}" =~ ^[Yy]$ ]] || exit 0
else
  echo "==> .env sudah ada — skip (tidak ditimpa)"
fi

echo "==> prisma migrate deploy..."
npx prisma migrate deploy

mkdir -p /var/www/quantara

NGINX_AVAIL="/etc/nginx/sites-available/quantara"
NGINX_ENABLED="/etc/nginx/sites-enabled/quantara"
if [[ ! -f "${NGINX_AVAIL}" ]]; then
  if [[ -f "${BE_DIR}/nginx/quantara-production.conf.example" ]]; then
    cp "${BE_DIR}/nginx/quantara-production.conf.example" "${NGINX_AVAIL}"
    ln -sf "${NGINX_AVAIL}" "${NGINX_ENABLED}" 2>/dev/null || true
    nginx -t && systemctl reload nginx
    echo "==> nginx production config installed"
  fi
fi

if pm2 describe "${PM2_APP}" >/dev/null 2>&1; then
  echo "==> pm2 restart ${PM2_APP}..."
  pm2 restart "${PM2_APP}"
else
  echo "==> pm2 start ${PM2_APP}..."
  pm2 start ecosystem.config.js --only quantara 2>/dev/null \
    || pm2 start index.js --name "${PM2_APP}"
fi
pm2 save

echo ""
curl -sf "http://127.0.0.1:3000/health" && echo "" || echo "WARN: health check failed"
echo ""
echo "Done. Deploy FE dari mesin lokal:"
echo "  cd fe-bot-trading && ./deploy-production.sh"
echo ""
echo "Production URLs:"
echo "  FE:  http://${VPS_IP}"
echo "  API: http://${VPS_IP}/api/v1/health"
