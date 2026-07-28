#!/usr/bin/env bash
# Deploy RAG/ML pipeline on staging VPS (bootstrap embeddings + train model + restart).
#
# Usage (from laptop with SSH access to staging):
#   ./scripts/ml/deploy-rag-staging-remote.sh
#   ./scripts/ml/deploy-rag-staging-remote.sh --skip-train   # embeddings only
#   ./scripts/ml/deploy-rag-staging-remote.sh --min=50        # require N closed trades
#   ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --tf-all  # seed from CSV
#   RSYNC=1 ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --tf-all --skip-train
#
# Env:
#   VPS_HOST=root@srv1722932   (or root@187.77.135.156)
#   REMOTE_BE=/opt/quantara-staging/be
#   PM2_APP=be-quantara-staging
#   RSYNC=1  — rsync local tmp/*-walkforward before remote seed (default when --from-walkforward)
#   RSYNC=0  — skip rsync (CSVs already on VPS)

set -euo pipefail

VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be}"
PM2_APP="${PM2_APP:-be-quantara-staging}"
GIT_BRANCH="${GIT_BRANCH:-staging}"
MIN_TRADES=5
SKIP_TRAIN=false
FROM_WALKFORWARD=false
WF_ARGS=""

for arg in "$@"; do
  case "$arg" in
    --skip-train) SKIP_TRAIN=true ;;
    --min=*) MIN_TRADES="${arg#*=}" ;;
    --from-walkforward) FROM_WALKFORWARD=true ;;
    --tf-all|--smc-all|--af-all|--ts-all|--dir=*|--strategy=*) WF_ARGS="${WF_ARGS} ${arg}" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

collect_rsync_dirs() {
  local -a dirs=()
  local arg rel base
  for arg in "$@"; do
    case "$arg" in
      --tf-all)
        dirs+=(
          "tf-scalping-walkforward" "tf-intraday-walkforward" "tf-swing-walkforward"
        )
        ;;
      --smc-all)
        dirs+=(
          "smc-scalping-walkforward" "smc-intraday-walkforward" "smc-swing-walkforward"
        )
        ;;
      --af-all)
        dirs+=(
          "smc-scalping-walkforward" "smc-intraday-walkforward" "smc-swing-walkforward"
          "wyckoff-scalping-walkforward" "wyckoff-intraday-walkforward" "wyckoff-swing-walkforward"
          "vsa-scalping-walkforward" "vsa-intraday-walkforward" "vsa-swing-walkforward"
        )
        ;;
      --ts-all)
        dirs+=(
          "tf-scalping-walkforward" "tf-intraday-walkforward" "tf-swing-walkforward"
          "ms-scalping-walkforward" "ms-intraday-walkforward" "ms-swing-walkforward"
          "amt-scalping-walkforward" "amt-intraday-walkforward" "amt-swing-walkforward"
        )
        ;;
      --dir=*)
        rel="${arg#*=}"
        rel="${rel#tmp/}"
        base="$(basename "${rel%/}")"
        dirs+=("${base}")
        ;;
    esac
  done
  if [[ ${#dirs[@]} -eq 0 ]]; then
    dirs+=("tf-scalping-walkforward" "tf-intraday-walkforward" "tf-swing-walkforward")
  fi
  printf '%s\n' "${dirs[@]}" | awk '!seen[$0]++'
}

if [[ "${FROM_WALKFORWARD}" == "true" && "${RSYNC:-1}" != "0" ]]; then
  echo "==> Rsync local walkforward CSV dirs to ${VPS_HOST}:${REMOTE_BE}/tmp/"
  while IFS= read -r dir; do
    [[ -z "${dir}" ]] && continue
    local_src="${REPO_ROOT}/tmp/${dir}/"
    if [[ -d "${local_src}" ]]; then
      echo "    ${dir}/"
      rsync -avz --progress "${local_src}" "${VPS_HOST}:${REMOTE_BE}/tmp/${dir}/"
    else
      echo "    (skip ${dir} — not found locally)"
    fi
  done < <(collect_rsync_dirs "$@")
fi

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

echo "==> verify pgvector extension"
node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
_pool.query(\"SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'\")
  .then(r => {
    if (!r.rows.length) {
      console.error('pgvector extension missing after migrate deploy');
      process.exit(1);
    }
    console.log('pgvector OK:', r.rows[0]);
    return _pool.end();
  })
  .catch(e => { console.error(e.message); process.exit(1); });
"

CLOSED=\$(node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
_pool.query(\"SELECT COUNT(*)::int AS n FROM trades WHERE status='closed' AND close_time IS NOT NULL\")
  .then(r => { console.log(r.rows[0].n); return _pool.end(); })
  .catch(e => { console.error(e.message); process.exit(1); });
")
echo "==> Closed engine trades: \${CLOSED} (min ${MIN_TRADES})"

if [[ "${FROM_WALKFORWARD}" == "true" ]]; then
  echo "==> Seeding TradeEmbedding from walkforward CSV (uses VPS DATABASE_URL + pgvector)"
  npm run ml:seed-embeddings-walkforward -- --min=${MIN_TRADES}${WF_ARGS}
elif [[ "\${CLOSED}" -lt ${MIN_TRADES} ]]; then
  echo "ERROR: Need >= ${MIN_TRADES} closed trades. Start staging bots (paper/dry-run OK) and re-run."
  echo "       Or use: RSYNC=1 ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --tf-all --min=${MIN_TRADES}"
  echo "       pm2 logs ${PM2_APP} — ensure bot sessions are running."
  exit 1
else
  echo "==> npm run ml:bootstrap-engine-trades"
  npm run ml:bootstrap-engine-trades -- --min=${MIN_TRADES}
fi

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

echo "==> TradeEmbedding counts (direct DB — rag-gate-status needs JWT on public URL)"
node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
Promise.all([
  _pool.query('SELECT COUNT(*)::int AS n FROM \"TradeEmbedding\"'),
  _pool.query(\"SELECT metadata->>'strategyKey' AS k, COUNT(*)::int AS n FROM \\\"TradeEmbedding\\\" GROUP BY 1 ORDER BY n DESC LIMIT 10\"),
]).then(([all, byStrat]) => {
  console.log(JSON.stringify({
    embeddingCount: all.rows[0].n,
    topStrategies: byStrat.rows,
  }, null, 2));
  return _pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
"

if [[ "${SKIP_TRAIN}" != "true" ]]; then
  echo "==> WinPredictor model"
  node -e "
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const model = path.join('data/models/win-predictor.json');
const hasModel = fs.existsSync(model);
console.log(JSON.stringify({ hasModel, modelPath: model }, null, 2));
"
fi
EOF

echo ""
echo "Done. Verify in browser or:"
echo "  curl -H 'Authorization: Bearer <token>' https://staging.quantara.software/api/v1/backtest/rag-gate-status"
