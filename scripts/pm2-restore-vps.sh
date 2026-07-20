#!/usr/bin/env bash
# Restore PM2 processes for prod / staging / dev on the shared VPS.
#
# WHY: ecosystem.config.js uses cwd=__dirname. Each app MUST be started from its
# own checkout. Running `pm2 start ecosystem.config.js` from /opt/quantara-prod/be
# without --only does NOT recreate dev/staging in their own paths — and may bind
# all apps to prod code + .env.
#
# Usage (on VPS as root):
#   bash scripts/pm2-restore-vps.sh           # restore all three
#   bash scripts/pm2-restore-vps.sh dev       # dev only
#   bash scripts/pm2-restore-vps.sh staging   # staging only
#   bash scripts/pm2-restore-vps.sh prod      # prod only
#
# Env overrides:
#   PROD_BE=/opt/quantara-prod/be
#   STAGING_BE=/opt/quantara-staging/be
#   DEV_BE=/opt/quantara-dev/be

set -euo pipefail

PROD_BE="${PROD_BE:-/opt/quantara-prod/be}"
STAGING_BE="${STAGING_BE:-/opt/quantara-staging/be}"
DEV_BE="${DEV_BE:-/opt/quantara-dev/be}"

start_one() {
  local dir="$1"
  local app="$2"
  if [[ ! -f "${dir}/ecosystem.config.js" ]]; then
    echo "❌ skip ${app}: ${dir}/ecosystem.config.js not found"
    return 1
  fi
  if [[ ! -f "${dir}/.env" ]]; then
    echo "❌ skip ${app}: ${dir}/.env missing"
    return 1
  fi
  echo "==> ${app} @ ${dir}"
  cd "${dir}"
  node --check index.js
  node --check ecosystem.config.js
  pm2 delete "${app}" 2>/dev/null || true
  pm2 start ecosystem.config.js --only "${app}" --update-env
  echo "    ✓ ${app} started (port from ecosystem env)"
}

restore_prod() { start_one "${PROD_BE}" "be-quantara-prod"; }
restore_staging() { start_one "${STAGING_BE}" "be-quantara-staging"; }
restore_dev() { start_one "${DEV_BE}" "be-quantara-dev"; }

TARGET="${1:-all}"

case "${TARGET}" in
  prod) restore_prod ;;
  staging) restore_staging ;;
  dev|development) restore_dev ;;
  all)
    restore_prod
    restore_staging
    restore_dev
    ;;
  *)
    echo "Usage: $0 [all|prod|staging|dev]"
    exit 1
    ;;
esac

pm2 save
echo ""
pm2 list
echo ""
echo "Health checks:"
curl -sf "http://127.0.0.1:3000/api/v1/health" >/dev/null && echo "  ✓ prod  :3000" || echo "  ❌ prod  :3000"
curl -sf "http://127.0.0.1:3001/api/v1/health" >/dev/null && echo "  ✓ staging :3001" || echo "  ❌ staging :3001"
curl -sf "http://127.0.0.1:3002/api/v1/health" >/dev/null && echo "  ✓ dev   :3002" || echo "  ❌ dev   :3002"
