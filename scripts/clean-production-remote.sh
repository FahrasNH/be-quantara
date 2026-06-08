#!/usr/bin/env bash
# Jalankan cleanup trade/sesi di VPS PRODUCTION (via SSH).
#
# Usage:
#   ./scripts/clean-production-remote.sh              # dry-run
#   ./scripts/clean-production-remote.sh --apply      # hapus data (butuh konfirmasi)
#
# Env opsional:
#   VPS_HOST=root@187.77.135.156
#   REMOTE_BE=/opt/be-quantara
#   SKIP_CONFIRM=1  — lewati prompt konfirmasi (hati-hati)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/be-quantara}"
EXTRA_ARGS=()
APPLY=false

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=true; EXTRA_ARGS+=("--apply") ;;
    --dry-run) ;;
    *) echo "Usage: $0 [--dry-run|--apply]"; exit 1 ;;
  esac
done

if [[ "${APPLY}" == true && "${SKIP_CONFIRM:-}" != "1" ]]; then
  echo "⚠️  PRODUCTION cleanup — akan HAPUS trades + bot_sessions di ${VPS_HOST}:${REMOTE_BE}"
  echo "    User, settings, dan backtest history TIDAK dihapus."
  read -p "Ketik 'production' untuk lanjut: " -r
  echo
  [[ "${REPLY}" == "production" ]] || { echo "Dibatalkan."; exit 0; }
fi

if ! ssh "${VPS_HOST}" "test -f '${REMOTE_BE}/.env'"; then
  echo "ERROR: .env production tidak ditemukan di ${VPS_HOST}:${REMOTE_BE}"
  echo "       Set path manual: REMOTE_BE=/path/to/be-bot-trading"
  exit 1
fi

echo "==> Upload cleanup script → ${VPS_HOST}:${REMOTE_BE}/scripts/"
scp "${BE_DIR}/scripts/clean-production-trades-sessions.js" \
  "${VPS_HOST}:${REMOTE_BE}/scripts/clean-production-trades-sessions.js"

echo "==> Run cleanup di production (${REMOTE_BE})..."
ssh "${VPS_HOST}" "cd '${REMOTE_BE}' && node scripts/clean-production-trades-sessions.js ${EXTRA_ARGS[*]:-}"
