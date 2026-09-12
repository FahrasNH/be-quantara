#!/usr/bin/env bash
# Convenience wrapper — deploy BE development tanpa clone FE.
# Usage:
#   bash deploy-development.sh
#   bash deploy-development.sh --be-only   # same (BE-only is the only mode here)

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

case "${1:-}" in
  ""|--be-only) ;;
  --fe-only)
    echo "ERROR: FE deploy tidak didukung dari be-quantara."
    echo "       Clone fe-bot-trading dan pakai deploy-development.sh di sana, atau deploy FE terpisah."
    exit 1
    ;;
  -h|--help)
    echo "Usage: bash deploy-development.sh [--be-only]"
    echo "  Deploy BE ke VPS development (https://dev.quantara.software)."
    echo "  Pastikan sudah: git push origin development"
    exit 0
    ;;
  *)
    echo "Usage: bash deploy-development.sh [--be-only]"
    exit 1
    ;;
esac

exec bash "${ROOT}/scripts/deploy-development-remote.sh"
