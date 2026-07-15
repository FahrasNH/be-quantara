#!/usr/bin/env bash
# prisma migrate deploy with recovery for known stuck migrations on fresh/partial DBs.
#
# Usage (from BE repo root):
#   bash scripts/prisma-migrate-deploy.sh
#
# Recovery targets:
#   - 20260610140000_add_trade_export_fields (P3018: relation "trades" does not exist)
#   - 20260625120000_add_payment_voucher_system (P3018 payment migration stuck)
#   - 20260709060000_add_pgvector (42501: permission denied to create extension vector)
#   - 20260715120000_migrate_gen1_strategy_keys (P3018/P3009: optional tables missing)
#   - 20260715200000_migrate_abbrev_to_fullword_strategy_keys (same)

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BE_DIR}"

TRADE_EXPORT_MIG="20260610140000_add_trade_export_fields"
PAYMENT_MIG="20260625120000_add_payment_voucher_system"
PGVECTOR_MIG="20260709060000_add_pgvector"
GEN1_STRATEGY_MIG="20260715120000_migrate_gen1_strategy_keys"
ABBREV_STRATEGY_MIG="20260715200000_migrate_abbrev_to_fullword_strategy_keys"

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

recover_pgvector() {
  echo "⚠️  Recover ${PGVECTOR_MIG} (provision extension as postgres, then re-apply)..."
  bash scripts/ensure-pgvector-extension.sh
  npx prisma migrate resolve --rolled-back "${PGVECTOR_MIG}" 2>/dev/null || true
}

recover_gen1_strategy_keys() {
  echo "⚠️  Recover ${GEN1_STRATEGY_MIG} (mark rolled-back, re-apply with IF EXISTS guards)..."
  npx prisma migrate resolve --rolled-back "${GEN1_STRATEGY_MIG}" 2>/dev/null || true
}

recover_abbrev_strategy_keys() {
  echo "⚠️  Recover ${ABBREV_STRATEGY_MIG} (mark rolled-back, re-apply with IF EXISTS guards)..."
  npx prisma migrate resolve --rolled-back "${ABBREV_STRATEGY_MIG}" 2>/dev/null || true
}

try_recover_and_rerun() {
  local recovered=false

  if grep -qE "${TRADE_EXPORT_MIG}|relation \"trades\" does not exist" "${LOG}"; then
    recover_trade_export
    recovered=true
  fi

  if grep -qE "${PAYMENT_MIG}|add_payment_voucher" "${LOG}"; then
    recover_payment
    recovered=true
  fi

  if grep -qE "${PGVECTOR_MIG}|create extension \"vector\"|permission denied to create extension" "${LOG}"; then
    recover_pgvector
    recovered=true
  fi

  if grep -qE "${GEN1_STRATEGY_MIG}|${ABBREV_STRATEGY_MIG}|MlShadowLog|MLShadowLog|migrate_gen1_strategy_keys|migrate_abbrev_to_fullword" "${LOG}"; then
    if grep -q "${GEN1_STRATEGY_MIG}" "${LOG}"; then recover_gen1_strategy_keys; recovered=true; fi
    if grep -q "${ABBREV_STRATEGY_MIG}" "${LOG}"; then recover_abbrev_strategy_keys; recovered=true; fi
  fi

  if grep -q "P3009" "${LOG}"; then
    if grep -q "${TRADE_EXPORT_MIG}" "${LOG}"; then recover_trade_export; recovered=true; fi
    if grep -q "${PGVECTOR_MIG}" "${LOG}"; then recover_pgvector; recovered=true; fi
    if grep -q "${GEN1_STRATEGY_MIG}" "${LOG}"; then recover_gen1_strategy_keys; recovered=true; fi
    if grep -q "${ABBREV_STRATEGY_MIG}" "${LOG}"; then recover_abbrev_strategy_keys; recovered=true; fi
  fi

  if [[ "${recovered}" == "true" ]]; then
    run_migrate
    return $?
  fi
  return 1
}

LOG="$(mktemp)"
trap 'rm -f "${LOG}"' EXIT

# Proactive: pgvector is per-database — app users cannot CREATE EXTENSION.
bash scripts/ensure-pgvector-extension.sh 2>/dev/null || true

set +e
run_migrate 2>&1 | tee "${LOG}"
CODE=${PIPESTATUS[0]}
set -e

if [[ "${CODE}" -eq 0 ]]; then
  echo "✓ prisma migrate deploy OK"
  exit 0
fi

if try_recover_and_rerun; then
  echo "✓ prisma migrate deploy OK (after recovery)"
  exit 0
fi

echo "❌ prisma migrate deploy failed — manual intervention required:"
cat "${LOG}"
exit 1
