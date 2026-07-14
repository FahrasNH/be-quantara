#!/usr/bin/env bash
# prisma migrate deploy with recovery for known stuck migrations on fresh/partial DBs.
#
# Usage (from BE repo root):
#   bash scripts/prisma-migrate-deploy.sh
#
# Recovery targets:
#   - 20260610140000_add_trade_export_fields (P3018: relation "trades" does not exist)
#   - 20260625120000_add_payment_voucher_system (P3018 payment migration stuck)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BE_DIR}"

TRADE_EXPORT_MIG="20260610140000_add_trade_export_fields"
PAYMENT_MIG="20260625120000_add_payment_voucher_system"

run_migrate() {
  npx prisma migrate deploy "$@"
}

recover_trade_export() {
  echo "⚠️  Recover ${TRADE_EXPORT_MIG} (mark rolled-back, re-apply with trades bootstrap)..."
  npx prisma migrate resolve --rolled-back "${TRADE_EXPORT_MIG}" 2>/dev/null || true
}

recover_payment() {
  echo "⚠️  Recover ${PAYMENT_MIG} (P3018 idempotent re-deploy)..."
  npx prisma migrate resolve --rolled-back "${PAYMENT_MIG}" 2>/dev/null || true
}

LOG="$(mktemp)"
trap 'rm -f "${LOG}"' EXIT

set +e
run_migrate 2>&1 | tee "${LOG}"
CODE=${PIPESTATUS[0]}
set -e

if [[ "${CODE}" -eq 0 ]]; then
  echo "✓ prisma migrate deploy OK"
  exit 0
fi

if grep -qE "${TRADE_EXPORT_MIG}|relation \"trades\" does not exist|P3009.*${TRADE_EXPORT_MIG}" "${LOG}"; then
  recover_trade_export
  run_migrate
  exit 0
fi

if grep -qE "${PAYMENT_MIG}|P3018.*payment" "${LOG}"; then
  recover_payment
  run_migrate
  exit 0
fi

if grep -q "P3009" "${LOG}" && grep -q "${TRADE_EXPORT_MIG}" "${LOG}"; then
  recover_trade_export
  run_migrate
  exit 0
fi

echo "❌ prisma migrate deploy failed — manual intervention required:"
cat "${LOG}"
exit 1
