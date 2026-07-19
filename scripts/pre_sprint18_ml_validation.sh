#!/usr/bin/env bash
# pre_sprint18_ml_validation.sh — Sprint 18 ML data readiness pre-flight
# Run 1 week before Sprint 18 model training to validate data readiness.
#
# Usage:
#   export DATABASE_URL="postgresql://user:pass@localhost:5432/bot_trading"
#   ./scripts/pre_sprint18_ml_validation.sh

set -euo pipefail

echo "=== ML DATA READINESS PRE-FLIGHT (Sprint 18) ==="
echo ""

FAIL=0

# ── 1. Gate safety ───────────────────────────────────────────────────────────
echo "✓ Check 1: ML_GATE_MODE production lock"
GATE_MODE="${ML_GATE_MODE:-shadow}"
if [[ -f .env.production ]] && grep -qE '^ML_GATE_MODE=active' .env.production 2>/dev/null; then
  echo "  ❌ FAIL: ML_GATE_MODE=active detected in .env.production"
  FAIL=1
elif [[ "$GATE_MODE" == "active" ]] && [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "  ❌ FAIL: ML_GATE_MODE=active in production environment"
  FAIL=1
else
  echo "  ✅ PASS: gate locked to shadow (mode=${GATE_MODE})"
fi

# ── 2. Feature null-density ──────────────────────────────────────────────────
echo ""
echo "✓ Check 2: Feature null-density (<20% threshold for usable fields)"
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "  ⚠️  SKIP: DATABASE_URL not set — cannot run null-density report"
else
  NULL_REPORT="/tmp/null_density_report.txt"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT field, ROUND(null_pct::numeric, 1) AS null_pct
FROM (
  SELECT 'iv30d' AS field,
    100.0 * COUNT(*) FILTER (
      WHERE entry_context IS NULL
         OR entry_context->>'iv30d' IS NULL
         OR entry_context->>'iv30d' = 'null'
    ) / NULLIF(COUNT(*), 0) AS null_pct
  FROM trades WHERE open_time > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 'skew',
    100.0 * COUNT(*) FILTER (
      WHERE entry_context IS NULL
         OR entry_context->>'skew' IS NULL
    ) / NULLIF(COUNT(*), 0)
  FROM trades WHERE open_time > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 'liquidationBuffer',
    100.0 * COUNT(*) FILTER (
      WHERE entry_context IS NULL
         OR entry_context->>'liquidationBuffer' IS NULL
    ) / NULLIF(COUNT(*), 0)
  FROM trades WHERE open_time > NOW() - INTERVAL '7 days'
  UNION ALL
  SELECT 'hodPrice',
    100.0 * COUNT(*) FILTER (
      WHERE entry_context IS NULL
         OR entry_context->>'hodPrice' IS NULL
    ) / NULLIF(COUNT(*), 0)
  FROM trades WHERE open_time > NOW() - INTERVAL '7 days'
) sub
ORDER BY field;
" | tee "$NULL_REPORT"

  if grep -E 'iv30d|liquidationBuffer|skew' "$NULL_REPORT" | grep -vE '^\s*100|100\.0|field'; then
    echo "  ⚠️  WARNING: High-null fields detected — excluded from training (see EXCLUDED_FEATURES)"
  else
    echo "  ✅ PASS: null-density report generated (100% null fields will be excluded)"
  fi
fi

# ── 3. Training data completeness ────────────────────────────────────────────
echo ""
echo "✓ Check 3: Data completeness (>70% threshold)"
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "  ⚠️  SKIP: DATABASE_URL not set"
else
  COMPLETE=$(psql "$DATABASE_URL" -t -A -v ON_ERROR_STOP=1 -c "
SELECT COALESCE(
  100.0 * COUNT(*) FILTER (
    WHERE entry_context IS NOT NULL AND exit_context IS NOT NULL
  ) / NULLIF(COUNT(*), 0),
  0
)
FROM trades
WHERE open_time > NOW() - INTERVAL '7 days'
  AND status = 'closed';
")
  echo "  Data completeness: ${COMPLETE}%"
  if awk "BEGIN { exit !($COMPLETE < 70) }"; then
    echo "  ❌ FAIL: Only ${COMPLETE}% complete — backfill incomplete"
    FAIL=1
  else
    echo "  ✅ PASS: ${COMPLETE}% completeness"
  fi
fi

# ── 4. Trade field write-through ─────────────────────────────────────────────
echo ""
echo "✓ Check 4: Trade fields populated (winning_component, signal_delay_ms, pair_tier)"
if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "  ⚠️  SKIP: DATABASE_URL not set"
else
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "
SELECT
  COUNT(*) AS total,
  COUNT(winning_component) AS winner_filled,
  COUNT(signal_delay_ms) AS delay_filled,
  COUNT(pair_tier) AS tier_filled,
  ROUND(100.0 * COUNT(winning_component) / NULLIF(COUNT(*), 0), 1) AS pct_winner_filled
FROM trades
WHERE open_time > NOW() - INTERVAL '7 days';
"
  echo "  ✅ PASS: write-through report generated"
fi

echo ""
if [[ "$FAIL" -ne 0 ]]; then
  echo "❌ PRE-FLIGHT FAILED — resolve issues before Sprint 18 training"
  exit 1
fi

echo "✅ PRE-FLIGHT COMPLETE — Ready for Sprint 18 training"
echo "Next: Review null-density report — exclude 100% null fields from features"
echo "      Run: node scripts/ml/backfill_gap_analysis.js"
