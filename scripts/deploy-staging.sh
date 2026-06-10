#!/usr/bin/env bash
# Deploy backend staging saja (dari mesin lokal → VPS via SSH).
#
# Usage:
#   ./scripts/deploy-staging.sh
#
# Env: VPS_HOST, REMOTE_BE, PM2_APP (sama seperti fe-quantara/deploy-staging.sh)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be}"
PM2_APP="${PM2_APP:-be-quantara-staging}"

if [[ "${SKIP_CONFIRM:-}" != "1" ]]; then
  echo "⚠️  STAGING BE deploy → ${VPS_HOST}:${REMOTE_BE}"
  read -p "Lanjutkan? [y/N] " -n 1 -r
  echo
  [[ "${REPLY}" =~ ^[Yy]$ ]] || exit 0
fi

if ! ssh "${VPS_HOST}" "test -d '${REMOTE_BE}'"; then
  echo "ERROR: ${REMOTE_BE} tidak ada di VPS."
  echo "       Jalankan scripts/setup-staging-vps.sh di VPS dulu."
  exit 1
fi

echo "==> Run deploy on VPS..."
ssh "${VPS_HOST}" "cd '${REMOTE_BE}' && PM2_APP='${PM2_APP}' bash scripts/deploy-staging-vps.sh"

echo "Done."
