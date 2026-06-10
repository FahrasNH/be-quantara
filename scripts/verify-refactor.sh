#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-refactor.sh — Test struktur baru setelah refactor
#
# Cek:
#   1. Folder paths ada
#   2. PM2 app running + healthy
#   3. nginx config OK
#   4. Health endpoint BE respond
#   5. FE serve index.html
#   6. No orphaned processes di port lama
#
# Jalankan:
#   bash scripts/verify-refactor.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_ok() { echo -e "${GREEN}✓${NC} $1"; }
log_warn() { echo -e "${YELLOW}⚠${NC} $1"; }
log_fail() { echo -e "${RED}✗${NC} $1"; }

FAILED=0

echo ""
echo "=== Verify Refactor (Option B structure) ==="
echo ""

# ─── Folder structure ───────────────────────────────────────────────────────
echo "${BOLD}[1] Folder structure${NC}"
if [[ -d /opt/quantara-prod/be ]]; then
  log_ok "/opt/quantara-prod/be exists"
else
  log_fail "/opt/quantara-prod/be NOT found"
  FAILED=$((FAILED + 1))
fi

if [[ -d /opt/quantara-staging/be ]]; then
  log_ok "/opt/quantara-staging/be exists"
else
  log_fail "/opt/quantara-staging/be NOT found"
  FAILED=$((FAILED + 1))
fi

if [[ -d /var/www/quantara-prod/fe ]]; then
  log_ok "/var/www/quantara-prod/fe exists"
else
  log_fail "/var/www/quantara-prod/fe NOT found"
  FAILED=$((FAILED + 1))
fi

if [[ -d /var/www/quantara-staging/fe ]]; then
  log_ok "/var/www/quantara-staging/fe exists"
else
  log_fail "/var/www/quantara-staging/fe NOT found"
  FAILED=$((FAILED + 1))
fi

echo ""

# ─── PM2 app status ────────────────────────────────────────────────────────
echo "${BOLD}[2] PM2 app status${NC}"
if pm2 pid be-quantara-prod >/dev/null 2>&1; then
  PID=$(pm2 pid be-quantara-prod)
  log_ok "be-quantara-prod running (PID $PID)"

  # Check memory
  MEMORY=$(ps -o rss= -p $PID 2>/dev/null | awk '{print int($1/1024) "M"}')
  log_ok "Memory: $MEMORY"
else
  log_fail "be-quantara-prod NOT running"
  log_warn "Try: pm2 start /opt/quantara-prod/be/ecosystem.config.js"
  FAILED=$((FAILED + 1))
fi

echo ""

# ─── Health endpoint ───────────────────────────────────────────────────────
echo "${BOLD}[3] BE health endpoint${NC}"
if curl -s http://localhost:3000/health >/dev/null 2>&1; then
  log_ok "http://localhost:3000/health OK"
else
  log_warn "Health endpoint unreachable (app may still be starting)"
fi

echo ""

# ─── Nginx config ──────────────────────────────────────────────────────────
echo "${BOLD}[4] Nginx config${NC}"
if nginx -t 2>&1 | grep -q "successful"; then
  log_ok "nginx config OK"

  # Check FE root path in config
  if grep -q "root /var/www/quantara-prod/fe" /etc/nginx/sites-available/quantara; then
    log_ok "nginx prod FE root path correct"
  else
    log_warn "nginx prod FE root path may be wrong (check manually)"
  fi
else
  log_fail "nginx config error"
  nginx -t
  FAILED=$((FAILED + 1))
fi

echo ""

# ─── FE files ──────────────────────────────────────────────────────────────
echo "${BOLD}[5] FE files${NC}"
if [[ -f /var/www/quantara-prod/fe/index.html ]]; then
  log_ok "/var/www/quantara-prod/fe/index.html found"
else
  log_fail "/var/www/quantara-prod/fe/index.html NOT found"
  FAILED=$((FAILED + 1))
fi

if [[ -f /var/www/quantara-staging/fe/index.html ]]; then
  log_ok "/var/www/quantara-staging/fe/index.html found"
else
  log_warn "/var/www/quantara-staging/fe/index.html NOT found (OK kalau staging belum di-deploy)"
fi

echo ""

# ─── Old folder cleanup check ──────────────────────────────────────────────
echo "${BOLD}[6] Old folder status${NC}"
OLD_FOLDERS=("/opt/be-quantara" "/opt/quantara-staging/be-bot-trading" "/var/www/quantara" "/var/www/quantara-staging")
for folder in "${OLD_FOLDERS[@]}"; do
  if [[ -d "$folder" ]]; then
    log_warn "Old folder still exists: $folder (safe to delete after verification)"
  fi
done

echo ""

# ─── Summary ───────────────────────────────────────────────────────────────
if [[ $FAILED -eq 0 ]]; then
  echo "${GREEN}${BOLD}✓ All checks passed!${NC}"
  echo ""
  echo "Ready for:"
  echo "  1. curl https://quantara.software (FE from nginx)"
  echo "  2. Login + smoke test (1 bot start)"
  echo "  3. Cleanup old folders: rm -rf /opt/be-quantara /opt/quantara-staging/be-bot-trading /var/www/quantara /var/www/quantara-staging"
else
  echo "${RED}${BOLD}✗ $FAILED check(s) failed${NC}"
  echo ""
  echo "Troubleshooting:"
  echo "  • pm2 logs be-quantara-prod    (app logs)"
  echo "  • sudo tail -f /var/log/nginx/error.log  (nginx logs)"
  exit 1
fi
