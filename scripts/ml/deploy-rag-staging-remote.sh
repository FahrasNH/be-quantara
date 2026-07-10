#!/usr/bin/env bash
# Deploy RAG/ML pipeline on staging VPS (bootstrap embeddings + train model + restart).
#
# Usage (from laptop with SSH access to staging):
#   ./scripts/ml/deploy-rag-staging-remote.sh
#   ./scripts/ml/deploy-rag-staging-remote.sh --skip-train   # embeddings only
#   ./scripts/ml/deploy-rag-staging-remote.sh --min=50        # require N closed trades
#
# Env:
#   VPS_HOST=root@187.77.135.156
#   REMOTE_BE=/opt/quantara-staging/be-bot-trading
#   PM2_APP=be-quantara-staging

set -euo pipefail

VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be-bot-trading}"
PM2_APP="${PM2_APP:-be-quantara-staging}"
GIT_BRANCH="${GIT_BRANCH:-staging}"
MIN_TRADES=5
SKIP_TRAIN=false

for arg in "$@"; do
  case "$arg" in
    --skip-train) SKIP_TRAIN=true ;;
    --min=*) MIN_TRADES="${arg#*=}" ;;
  esac
done

echo "==> Deploy RAG pipeline on ${VPS_HOST}:${REMOTE_BE}"

ssh "${VPS_HOST}" bash -s <<EOF
set -euo pipefail
cd "${REMOTE_BE}"

echo "==> git fetch + reset to origin/${GIT_BRANCH}"
git fetch origin "${GIT_BRANCH}"
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"

echo "==> npm ci"
npm ci

echo "==> prisma migrate deploy"
npx prisma migrate deploy

CLOSED=\$(node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
_pool.query(\"SELECT COUNT(*)::int AS n FROM trades WHERE status='closed' AND close_time IS NOT NULL\")
  .then(r => { console.log(r.rows[0].n); return _pool.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
")
echo "==> Closed engine trades: \${CLOSED} (min ${MIN_TRADES})"

if [[ "\${CLOSED}" -lt ${MIN_TRADES} ]]; then
  echo "ERROR: Need >= ${MIN_TRADES} closed trades. Start staging bots (paper/dry-run OK) and re-run."
  echo "       pm2 logs ${PM2_APP} — ensure bot sessions are running."
  exit 1
fi

echo "==> npm run ml:bootstrap-engine-trades"
npm run ml:bootstrap-engine-trades -- --min=${MIN_TRADES}

if [[ "${SKIP_TRAIN}" != "true" ]]; then
  echo "==> npm run ml:train-win-predictor"
  npm run ml:train-win-predictor
fi

pm2 delete quantara-staging 2>/dev/null || true
echo "==> pm2 startOrReload ${PM2_APP}"
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env || pm2 start ecosystem.config.js --only "${PM2_APP}"
pm2 save

sleep 2
echo "==> Health"
curl -sf "http://127.0.0.1:3001/health" && echo "" || echo "WARN: health failed"

echo "==> RAG gate status (needs auth token for full response — check embeddingCount locally)"
node -e "
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const model = path.join('data/models/win-predictor.json');
const hasModel = fs.existsSync(model);
console.log(JSON.stringify({ hasModel, modelPath: model }, null, 2));
"
EOF

echo ""
echo "Done. Verify in browser or:"
echo "  curl -H 'Authorization: Bearer <token>' https://staging.quantara.software/api/v1/backtest/rag-gate-status"
