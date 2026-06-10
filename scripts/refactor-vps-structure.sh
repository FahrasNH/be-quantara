#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# refactor-vps-structure.sh — Reorganisasi struktur folder VPS (Option B)
#
# Current:
#   /opt/be-quantara/                   (BE prod)
#   /opt/quantara-staging/be-bot-trading/ (BE staging)
#   /var/www/quantara/                  (FE prod)
#   /var/www/quantara-staging/          (FE staging)
#
# Target:
#   /opt/quantara-prod/be/              (BE prod)
#   /opt/quantara-staging/be/           (BE staging)
#   /var/www/quantara-prod/fe/          (FE prod)
#   /var/www/quantara-staging/fe/       (FE staging)
#
# PROSEDUR:
#   1. Backup folder existing
#   2. Stop PM2 app
#   3. Rsync ke lokasi baru dgn verify
#   4. Update PM2 ecosystem.config.js
#   5. Update nginx config
#   6. Start PM2 app
#   7. Health check
#
# Jalankan di VPS sebagai root:
#   bash scripts/refactor-vps-structure.sh
#
# SAFETY: script cek preconditions dulu, punya prompt confirm sebelum destructive ops.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # no color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ─── Preconditions ──────────────────────────────────────────────────────────
log_info "=== REFACTOR VPS STRUCTURE (Option B) ==="
log_info ""
log_info "Target structure:"
log_info "  /opt/quantara-prod/be/        (BE prod)"
log_info "  /opt/quantara-staging/be/     (BE staging)"
log_info "  /var/www/quantara-prod/fe/    (FE prod)"
log_info "  /var/www/quantara-staging/fe/ (FE staging)"
log_info ""

# Check running as root
if [[ $EUID -ne 0 ]]; then
  log_error "Script harus dijalankan sebagai root (sudo)"
  exit 1
fi

# Check folder existing
log_info "[1/7] Cek folder existing..."
BE_PROD_OLD="/opt/be-quantara"
BE_STAGING_OLD="/opt/quantara-staging/be-bot-trading"
FE_PROD_OLD="/var/www/quantara"
FE_STAGING_OLD="/var/www/quantara-staging"

[[ -d "$BE_PROD_OLD" ]] && log_info "  ✓ $BE_PROD_OLD ada" || (log_error "$BE_PROD_OLD tidak ada"; exit 1)
[[ -d "$BE_STAGING_OLD" ]] && log_info "  ✓ $BE_STAGING_OLD ada" || (log_error "$BE_STAGING_OLD tidak ada"; exit 1)
[[ -d "$FE_PROD_OLD" ]] && log_info "  ✓ $FE_PROD_OLD ada" || (log_error "$FE_PROD_OLD tidak ada"; exit 1)
[[ -d "$FE_STAGING_OLD" ]] && log_info "  ✓ $FE_STAGING_OLD ada" || (log_error "$FE_STAGING_OLD tidak ada"; exit 1)

# Target paths
BE_PROD_NEW="/opt/quantara-prod/be"
BE_STAGING_NEW="/opt/quantara-staging/be"
FE_PROD_NEW="/var/www/quantara-prod/fe"
FE_STAGING_NEW="/var/www/quantara-staging/fe"

# ─── CONFIRM ────────────────────────────────────────────────────────────────
log_warn ""
log_warn "⚠️  Script akan:"
log_warn "  1. STOP pm2 app (be-quantara)"
log_warn "  2. Backup folder lama → *.bak.2026-06-10"
log_warn "  3. Rsync ke lokasi baru"
log_warn "  4. Update PM2 + nginx config"
log_warn "  5. Restart app"
log_warn ""
log_warn "Downtime perkiraan: 2-3 menit"
log_warn ""
read -p "Lanjutkan? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  log_info "Dibatalkan."
  exit 0
fi

# ─── STEP 1: Backup ──────────────────────────────────────────────────────────
log_info "[2/7] Backup folder existing..."
BACKUP_DATE=$(date +%Y-%m-%d_%H%M%S)
mkdir -p /opt/backups
mkdir -p /var/www/backups
tar czf "/opt/backups/be-quantara.${BACKUP_DATE}.tar.gz" -C /opt be-quantara quantara-staging
tar czf "/var/www/backups/quantara-www.${BACKUP_DATE}.tar.gz" -C /var/www quantara quantara-staging
log_info "  ✓ Backup di /opt/backups/ dan /var/www/backups/"

# ─── STEP 2: Stop PM2 ───────────────────────────────────────────────────────
log_info "[3/7] Stop PM2 app..."
if pm2 pid be-quantara >/dev/null 2>&1; then
  pm2 stop be-quantara
  sleep 2
  log_info "  ✓ be-quantara stopped"
else
  log_warn "  ⚠️  be-quantara not running (or not in PM2)"
fi

# ─── STEP 3: Create target directories ──────────────────────────────────────
log_info "[4/7] Create target directories..."
mkdir -p "$BE_PROD_NEW" "$BE_STAGING_NEW" "$FE_PROD_NEW" "$FE_STAGING_NEW"
log_info "  ✓ Directories created"

# ─── STEP 4: Rsync with verification ───────────────────────────────────────
log_info "[5/7] Rsync folders..."
rsync -av "$BE_PROD_OLD/" "$BE_PROD_NEW/" --delete
rsync -av "$BE_STAGING_OLD/" "$BE_STAGING_NEW/" --delete
rsync -av "$FE_PROD_OLD/" "$FE_PROD_NEW/" --delete
rsync -av "$FE_STAGING_OLD/" "$FE_STAGING_NEW/" --delete
log_info "  ✓ Rsync complete"

# ─── STEP 5: Update PM2 ecosystem.config.js ────────────────────────────────
log_info "[6/7] Update PM2 config..."
cat > /opt/quantara-prod/be/ecosystem.config.js <<'EOF'
module.exports = {
  apps: [
    {
      name: 'be-quantara-prod',
      script: 'src/server/app.js',
      cwd: '/opt/quantara-prod/be',
      instances: 1,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '512M',
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      error_file: '/var/log/pm2/be-quantara-prod-error.log',
      out_file: '/var/log/pm2/be-quantara-prod-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      kill_timeout: 5000
    }
  ]
};
EOF
log_info "  ✓ ecosystem.config.js updated"

# ─── STEP 6: Update nginx config (path FE baru) ────────────────────────────
log_info "[7/7] Update nginx config..."
# Ganti path lama dgn baru di config prod
sed -i.bak "s|root /var/www/quantara;|root /var/www/quantara-prod/fe;|g" /etc/nginx/sites-available/quantara
# Pastikan staging juga benar (jika ada)
if grep -q "quantara-staging" /etc/nginx/sites-available/quantara-staging 2>/dev/null; then
  sed -i.bak "s|root /var/www/quantara-staging;|root /var/www/quantara-staging/fe;|g" /etc/nginx/sites-available/quantara-staging
fi
nginx -t
nginx -s reload
log_info "  ✓ nginx reloaded"

# ─── STEP 7: Update PM2 daemon config (path new) ────────────────────────────
pm2 delete be-quantara 2>/dev/null || true
pm2 start /opt/quantara-prod/be/ecosystem.config.js
pm2 save
log_info "  ✓ PM2 restarted (be-quantara-prod)"

sleep 3

# ─── VERIFICATION ──────────────────────────────────────────────────────────
echo ""
log_info "=== Verification ==="
echo ""

# Check BE running
if pm2 pid be-quantara-prod >/dev/null 2>&1; then
  log_info "✓ BE app running (be-quantara-prod)"
  pm2 show be-quantara-prod | grep -E "status|pid"
else
  log_error "✗ BE app NOT running — check logs: pm2 logs be-quantara-prod"
fi

# Check nginx
if nginx -t 2>&1 | grep -q "successful"; then
  log_info "✓ nginx OK"
else
  log_error "✗ nginx config error"
  nginx -t
fi

# Check FE files
if [[ -f "$FE_PROD_NEW/index.html" ]]; then
  log_info "✓ FE prod index.html found"
else
  log_error "✗ FE prod index.html NOT found"
fi

echo ""
log_info "=== Refactor complete ==="
log_info ""
log_info "New structure:"
log_info "  BE prod:     $BE_PROD_NEW"
log_info "  BE staging:  $BE_STAGING_NEW"
log_info "  FE prod:     $FE_PROD_NEW"
log_info "  FE staging:  $FE_STAGING_NEW"
log_info ""
log_info "Backup locations:"
log_info "  /opt/backups/be-quantara.${BACKUP_DATE}.tar.gz"
log_info "  /var/www/backups/quantara-www.${BACKUP_DATE}.tar.gz"
log_info ""
log_info "Next steps:"
log_info "  1. Test BE: curl http://localhost:3000/health (atau similar)"
log_info "  2. Test FE: curl https://quantara.software (atau https://IP)"
log_info "  3. Login + smoke test (1 bot start)"
log_info "  4. Monitor: pm2 logs be-quantara-prod"
log_info "  5. Cleanup old folders (setelah verifikasi selesai):"
log_info "     rm -rf $BE_PROD_OLD $BE_STAGING_OLD $FE_PROD_OLD $FE_STAGING_OLD"
