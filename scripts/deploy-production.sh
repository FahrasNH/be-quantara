#!/usr/bin/env bash
# Deploy backend production saja (dari mesin lokal → VPS via SSH).
#
# Usage:
#   ./scripts/deploy-production.sh
#
# Env: VPS_HOST, REMOTE_BE, PM2_APP (sama seperti fe-quantara/deploy-production.sh)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-prod/be}"
PM2_APP="${PM2_APP:-be-quantara-prod}"

if [[ "${SKIP_CONFIRM:-}" != "1" ]]; then
  echo "⚠️  PRODUCTION BE deploy → ${VPS_HOST}:${REMOTE_BE}"
  read -p "Lanjutkan? [y/N] " -n 1 -r
  echo
  [[ "${REPLY}" =~ ^[Yy]$ ]] || exit 0
fi

echo "==> Upload deploy script..."
scp "${BE_DIR}/scripts/deploy-production-vps.sh" "${VPS_HOST}:/tmp/deploy-production-vps.sh"

echo "==> Run deploy on VPS..."
ssh "${VPS_HOST}" "cd '${REMOTE_BE}' && PM2_APP='${PM2_APP}' bash /tmp/deploy-production-vps.sh"

echo "Done."
