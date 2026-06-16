#!/usr/bin/env bash
# Pastikan ALLOWED_EXCHANGES di .env mencakup bitget, okx, binance.
# Dipanggil dari deploy-production-vps.sh / deploy-staging-vps.sh.
#
# Usage: bash scripts/ensure-allowed-exchanges.sh [path-to-.env]
# Default: .env di cwd repo BE.

set -euo pipefail

ENV_FILE="${1:-.env}"
TARGET="bitget,okx,binance"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "WARN: ${ENV_FILE} tidak ditemukan — lewati ensure ALLOWED_EXCHANGES"
  exit 0
fi

if grep -q '^ALLOWED_EXCHANGES=' "${ENV_FILE}"; then
  current=$(grep '^ALLOWED_EXCHANGES=' "${ENV_FILE}" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  if [[ "${current}" == "${TARGET}" ]]; then
    echo "==> ALLOWED_EXCHANGES sudah benar: ${current}"
    exit 0
  fi
  # Upgrade dari bitget-only atau daftar tidak lengkap
  if [[ "${current}" == "bitget" ]] || [[ "${current}" != *"binance"* ]] || [[ "${current}" != *"okx"* ]]; then
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s/^ALLOWED_EXCHANGES=.*/ALLOWED_EXCHANGES=${TARGET}/" "${ENV_FILE}"
    else
      sed -i "s/^ALLOWED_EXCHANGES=.*/ALLOWED_EXCHANGES=${TARGET}/" "${ENV_FILE}"
    fi
    echo "==> ALLOWED_EXCHANGES diperbarui: ${current} → ${TARGET}"
  else
    echo "==> ALLOWED_EXCHANGES: ${current} (tidak diubah)"
  fi
else
  echo "ALLOWED_EXCHANGES=${TARGET}" >> "${ENV_FILE}"
  echo "==> ALLOWED_EXCHANGES ditambahkan: ${TARGET}"
fi
