#!/usr/bin/env bash
# Local ML refresh workflow: bootstrap dataset → train model → print VPS deploy steps.
#
# Run on laptop (no Postgres required for train if ml-engine-dataset.json exists).
#
# Usage:
#   ./scripts/ml/full-rag-refresh.sh
#   ./scripts/ml/full-rag-refresh.sh --dry-run-seed   # count embeddings only
#   ./scripts/ml/full-rag-refresh.sh --skip-train     # bootstrap only
#
# After this script:
#   git add data/ml-engine-dataset.json data/models/win-predictor.json
#   git commit && git push
#   npm run ml:deploy-rag-staging   # rsync tmp + seed VPS embeddings

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${REPO_ROOT}"

DRY_RUN_SEED=false
SKIP_TRAIN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run-seed) DRY_RUN_SEED=true ;;
    --skip-train) SKIP_TRAIN=true ;;
  esac
done

echo "==> [1/3] Dry-run seed count (all 12 LIVE strategies)"
npm run ml:seed-all-live:dry-run

echo ""
echo "==> [2/3] Bootstrap ml-engine-dataset.json from all walkforward dirs"
echo "       (Individual strategy bootstraps can be added; for now use walkforward seed on VPS.)"
echo "       Tip: ensure tmp/*-walkforward exists locally from walkforward exports."

if [[ "${SKIP_TRAIN}" != "true" ]]; then
  echo ""
  echo "==> [3/3] Train WinPredictor locally"
  npm run ml:train-win-predictor
  echo ""
  echo "Model written: data/models/win-predictor.json"
  echo "Report:        data/models/win-predictor-training-report.json (if generated)"
else
  echo ""
  echo "==> [3/3] Skipped train (--skip-train)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Next steps (VPS — embeddings live in Postgres, not git):"
echo ""
echo "  1. Commit model artifacts:"
echo "       git add data/ml-engine-dataset.json data/models/win-predictor.json"
echo "       git commit -m 'chore(ml): refresh win-predictor after walkforward'"
echo "       git push origin staging   # then merge to development"
echo ""
echo "  2. One-command VPS deploy (from laptop):"
echo "       npm run ml:deploy-rag-staging"
echo "     or dev:"
echo "       npm run ml:deploy-rag-dev"
echo ""
echo "  See docs/ML_RAG_DEPLOY.md for troubleshooting."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ "${DRY_RUN_SEED}" == "true" ]]; then
  echo "(--dry-run-seed: seed count shown above; no VPS action)"
fi
