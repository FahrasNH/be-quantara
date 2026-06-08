#!/usr/bin/env bash
# Jalankan cleanup trade/sesi di VPS staging (via SSH).
# Usage:
#   ./scripts/clean-staging-remote.sh           # hapus data
#   ./scripts/clean-staging-remote.sh --dry-run # cek jumlah baris saja
#
# Env opsional:
#   VPS_HOST=root@187.77.135.156
#   REMOTE_BE=/opt/quantara-staging/be-bot-trading

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be-bot-trading}"
EXTRA_ARGS=()

for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && EXTRA_ARGS+=("--dry-run")
done

if ! ssh "${VPS_HOST}" "test -f '${REMOTE_BE}/.env'"; then
  echo "ERROR: .env staging tidak ditemukan di ${VPS_HOST}:${REMOTE_BE}"
  echo "       Cek path BE staging di VPS, lalu set REMOTE_BE=..."
  exit 1
fi

echo "==> Upload cleanup script → ${VPS_HOST}:${REMOTE_BE}/scripts/"
scp "${BE_DIR}/scripts/clean-staging-trades-sessions.js" \
  "${VPS_HOST}:${REMOTE_BE}/scripts/clean-staging-trades-sessions.js"

echo "==> Run cleanup di staging (${REMOTE_BE})..."
ssh "${VPS_HOST}" "cd '${REMOTE_BE}' && node scripts/clean-staging-trades-sessions.js ${EXTRA_ARGS[*]:-}"
