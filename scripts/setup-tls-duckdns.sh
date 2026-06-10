#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-tls-duckdns.sh — Aktifkan HTTPS Lets Encrypt utk domain DuckDNS (OPS-002).
#
# PRASYARAT (lakukan dulu di duckdns.org):
#   1. Login duckdns.org (via GitHub/Google) — GRATIS
#   2. Buat subdomain, mis. "quantara-app"
#   3. Isi "current ip" = 187.77.135.156 → klik "update ip"
#   4. Tunggu ~1-5 menit; verifikasi: dig +short quantara-app.duckdns.org
#      harus mengembalikan 187.77.135.156
#
# Lalu jalankan di VPS sebagai root:
#   DOMAIN=quantara-app.duckdns.org EMAIL=fahras.fnh@gmail.com \
#     bash scripts/setup-tls-duckdns.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DOMAIN="${DOMAIN:?Set DOMAIN, mis. DOMAIN=quantara-app.duckdns.org}"
EMAIL="${EMAIL:?Set EMAIL untuk notifikasi Lets Encrypt}"
NGINX_SITE="/etc/nginx/sites-available/quantara"

echo "==> [1/6] Cek DNS: $DOMAIN harus mengarah ke VPS ini..."
RESOLVED="$(dig +short "$DOMAIN" | tail -1 || true)"
echo "    $DOMAIN → ${RESOLVED:-(kosong)}"
if [[ -z "$RESOLVED" ]]; then
  echo "❌ DNS belum resolve. Pastikan IP di duckdns.org sudah di-update & tunggu propagasi."
  exit 1
fi

echo "==> [2/6] Pasang certbot + plugin nginx bila belum ada..."
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y certbot python3-certbot-nginx
fi

echo "==> [3/6] Pasang config nginx SSL (server_name=$DOMAIN)..."
# Ambil template SSL dari repo, ganti placeholder domain
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/nginx/quantara-production-ssl.conf.example"
sed "s/YOUR_SUBDOMAIN.duckdns.org/${DOMAIN}/g" "$TEMPLATE" > "$NGINX_SITE"
ln -sf "$NGINX_SITE" /etc/nginx/sites-enabled/quantara
# Hapus default site agar tidak bentrok port 80
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/html  # untuk ACME challenge

echo "==> [4/6] Test config nginx..."
nginx -t

echo "==> [5/6] Terbitkan sertifikat Lets Encrypt (certbot --nginx)..."
certbot --nginx -d "$DOMAIN" \
  --non-interactive --agree-tos -m "$EMAIL" \
  --redirect

echo "==> [6/6] Pastikan auto-renewal aktif..."
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true
certbot renew --dry-run

systemctl reload nginx
echo ""
echo "✅ HTTPS aktif: https://$DOMAIN"
echo ""
echo '⚠️  LANGKAH LANJUTAN (wajib agar FE/CORS tidak mixed-content):'
echo "   1. BE .env production -> CORS_ORIGINS=https://$DOMAIN"
echo "   2. FE .env.production -> VITE_API_URL=https://$DOMAIN"
echo "                           VITE_WS_URL=wss://$DOMAIN"
echo '   3. Rebuild FE & re-deploy:  ./deploy-production.sh --fe-only'
echo '   4. Restart BE:  pm2 restart be-quantara'
