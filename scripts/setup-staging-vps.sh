#!/usr/bin/env bash
# Setup backend staging di VPS (jalankan DI SERVER sebagai root atau sudo).
# Prasyarat: Postgres, Node.js, PM2, git, nginx.
#
# Usage:
#   scp be-bot-trading/scripts/setup-staging-vps.sh root@187.77.135.156:/tmp/
#   ssh root@187.77.135.156 'bash /tmp/setup-staging-vps.sh'

set -euo pipefail

STAGING_ROOT="/opt/quantara-staging"
BE_DIR="${STAGING_ROOT}/be"
REPO_URL="${QUANTARA_BE_REPO:-https://github.com/FahrasNH/be-quantara.git}"
VPS_IP="${VPS_IP:-187.77.135.156}"
DB_NAME="bot_trading_staging"
DB_USER="quantara_staging"
DB_PASS="${STAGING_DB_PASS:-$(openssl rand -hex 16)}"

echo "==> Quantara staging BE setup"
echo "    Path: ${BE_DIR}"
echo "    DB:   ${DB_NAME}"

# ── Postgres database + user ─────────────────────────────────────────────────
if command -v psql >/dev/null 2>&1; then
  echo "==> Creating Postgres database (if not exists)..."
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
  sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
  sudo -u postgres psql -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};" 2>/dev/null || true
  sudo -u postgres psql -d "${DB_NAME}" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null || true
  echo "    DB user: ${DB_USER}"
  echo "    DB pass: ${DB_PASS}  (simpan — dipakai di .env)"
else
  echo "WARN: psql not found — buat database ${DB_NAME} manual."
fi

# ── Clone / update repo ──────────────────────────────────────────────────────
mkdir -p "${STAGING_ROOT}"
if [[ -d "${BE_DIR}/.git" ]]; then
  echo "==> git pull..."
  git -C "${BE_DIR}" pull origin main
else
  echo "==> git clone..."
  git clone "${REPO_URL}" "${BE_DIR}"
fi

cd "${BE_DIR}"
npm ci

# ── .env dari template (hanya jika belum ada) ────────────────────────────────
if [[ ! -f .env ]]; then
  echo "==> Creating .env from .env.staging.example..."
  cp .env.staging.example .env
  sed -i "s|GANTI_PASSWORD|${DB_PASS}|g" .env
  sed -i "s|GANTI_DENGAN_HASIL_openssl_rand_hex_48|$(openssl rand -hex 48)|g" .env
  sed -i "s|GANTI_DENGAN_HASIL_BERBEDA_openssl_rand_hex_48|$(openssl rand -hex 48)|g" .env
  sed -i "s|GANTI_DENGAN_HASIL_openssl_rand_hex_32|$(openssl rand -hex 32)|g" .env
  echo "    .env created — review ${BE_DIR}/.env"
else
  echo "==> .env already exists — skip"
fi

# ── Migrate ──────────────────────────────────────────────────────────────────
echo "==> prisma migrate deploy..."
npx prisma migrate deploy

# ── PM2 ──────────────────────────────────────────────────────────────────────
if pm2 describe quantara-staging >/dev/null 2>&1; then
  echo "==> pm2 restart quantara-staging..."
  pm2 restart quantara-staging
else
  echo "==> pm2 start quantara-staging (port 3001)..."
  pm2 start ecosystem.config.js --only quantara-staging
fi
pm2 save

# ── Nginx + FE dir ───────────────────────────────────────────────────────────
mkdir -p /var/www/quantara-staging
NGINX_AVAIL="/etc/nginx/sites-available/quantara-staging"
NGINX_ENABLED="/etc/nginx/sites-enabled/quantara-staging"

if [[ ! -f "${NGINX_AVAIL}" ]]; then
  if [[ -f "${BE_DIR}/nginx/quantara-staging.conf.example" ]]; then
    cp "${BE_DIR}/nginx/quantara-staging.conf.example" "${NGINX_AVAIL}"
  else
    cat > "${NGINX_AVAIL}" << 'NGINX_EOF'
upstream backend_staging {
  server 127.0.0.1:3001;
}
server {
  listen 8080;
  server_name 187.77.135.156;
  location /api/ {
    proxy_pass http://backend_staging;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
  }
  location /ws {
    proxy_pass http://backend_staging;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  location / {
    root /var/www/quantara-staging;
    try_files $uri $uri/ /index.html;
  }
}
NGINX_EOF
  fi
fi

if [[ -f "${NGINX_AVAIL}" ]] && [[ ! -L "${NGINX_ENABLED}" ]]; then
  ln -sf "${NGINX_AVAIL}" "${NGINX_ENABLED}"
  nginx -t && systemctl reload nginx
  echo "==> nginx staging enabled on :8080"
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow 8080/tcp 2>/dev/null || true
fi

echo ""
echo "==> Backend staging health check:"
sleep 2
curl -sf "http://127.0.0.1:3001/health" && echo "" || echo "WARN: health check failed — cek pm2 logs quantara-staging"

echo ""
echo "Done. Next: deploy FE dari mesin lokal:"
echo "  ./deploy-staging.sh"
echo ""
echo "Staging URLs:"
echo "  FE:  http://${VPS_IP}:8080"
echo "  API: http://${VPS_IP}:8080/api/v1/health"
