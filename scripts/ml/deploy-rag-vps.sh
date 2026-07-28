#!/usr/bin/env bash
# One-command ML/RAG deploy: laptop → VPS (rsync tmp + migrate + seed + PM2 reload).
#
# Usage (from laptop with SSH to VPS):
#   npm run ml:deploy-rag-staging
#   npm run ml:deploy-rag-dev
#
#   ./scripts/ml/deploy-rag-vps.sh --env staging --from-walkforward --all-live
#   ./scripts/ml/deploy-rag-vps.sh --env dev --from-walkforward --af-all --skip-train
#   ./scripts/ml/deploy-rag-vps.sh --env staging --from-walkforward --all-live --skip-rsync
#
# When already SSH'd into the VPS checkout:
#   npm run ml:deploy-rag-dev          # auto-detects VPS path, skips rsync + ssh
#   ./scripts/ml/deploy-rag-vps.sh --env dev --from-walkforward --all-live --local
#
# Args:
#   --env staging|dev       Target environment (required unless DEPLOY_ENV set)
#   --from-walkforward      Seed TradeEmbedding from tmp/*-walkforward CSV (recommended)
#   --all-live|--seed-all   All 12 LIVE strategies (36 dirs)
#   --af-all|--ts-all|--md-all|--bs-all   Umbrella presets
#   --tf-all|--smc-all|...  Single-strategy presets (see walkforward-dir-presets.js)
#   --skip-train            Skip ml:train-win-predictor on VPS (model already in git)
#   --skip-rsync            CSVs already on VPS; skip laptop → VPS rsync
#   --local                 Force local-only mode (no ssh) — use when already on VPS
#   --min=N                 Minimum embeddings required (default 5)
#
# Env overrides:
#   VPS_HOST=root@187.77.135.156
#   RSYNC=0                 Same as --skip-rsync
#   RSYNC=1                 Force rsync (default when --from-walkforward)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DEPLOY_ENV="${DEPLOY_ENV:-}"
MIN_TRADES=5
SKIP_TRAIN=false
FROM_WALKFORWARD=false
SKIP_RSYNC=false
FORCE_LOCAL=false
LOCAL_ONLY=false
WF_ARGS=""
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --env=*) DEPLOY_ENV="${arg#*=}" ;;
    --env) ;; # value handled by next iteration — use --env=staging instead
    --skip-train) SKIP_TRAIN=true ;;
    --skip-rsync) SKIP_RSYNC=true ;;
    --local) FORCE_LOCAL=true ;;
    --min=*) MIN_TRADES="${arg#*=}" ;;
    --from-walkforward) FROM_WALKFORWARD=true ;;
    --all-live|--seed-all|--af-all|--ts-all|--md-all|--bs-all|--tf-all|--smc-all|--wyckoff-all|--vsa-all|--ms-all|--amt-all|--mr-all|--snd-all|--sa-all|--br-all|--ict-all|--ls-all|--dir=*|--strategy=*)
      WF_ARGS="${WF_ARGS} ${arg}"
      EXTRA_ARGS+=("$arg")
      ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

# Support `--env staging` (two-token form)
for ((i = 1; i < $#; i++)); do
  if [[ "${!i}" == "--env" ]]; then
    next=$((i + 1))
    if [[ $next -le $# ]]; then
      DEPLOY_ENV="${!next}"
    fi
  fi
done

if [[ -z "${DEPLOY_ENV}" ]]; then
  echo "ERROR: Missing --env staging|dev"
  echo "  npm run ml:deploy-rag-staging"
  echo "  ./scripts/ml/deploy-rag-vps.sh --env staging --from-walkforward --all-live"
  exit 1
fi

case "${DEPLOY_ENV}" in
  staging)
    VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
    REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be}"
    PM2_APP="${PM2_APP:-be-quantara-staging}"
    GIT_BRANCH="${GIT_BRANCH:-staging}"
    HEALTH_PORT="${HEALTH_PORT:-3001}"
    ;;
  dev|development)
    DEPLOY_ENV="dev"
    VPS_HOST="${VPS_HOST:-root@187.77.135.156}"
    REMOTE_BE="${REMOTE_BE:-/opt/quantara-dev/be}"
    PM2_APP="${PM2_APP:-be-quantara-dev}"
    GIT_BRANCH="${GIT_BRANCH:-development}"
    HEALTH_PORT="${HEALTH_PORT:-3002}"
    ;;
  *)
    echo "ERROR: Unknown --env '${DEPLOY_ENV}'. Use staging or dev."
    echo "       Production ML deploy is manual — see docs/ML_RAG_DEPLOY.md"
    exit 1
    ;;
esac

if [[ "${FROM_WALKFORWARD}" != "true" ]]; then
  echo "ERROR: --from-walkforward is required (staging rarely has enough closed engine trades)."
  echo "       Example: npm run ml:deploy-rag-staging"
  echo "       Or bootstrap from engine: ssh ${VPS_HOST} 'cd ${REMOTE_BE} && npm run ml:bootstrap-engine-trades'"
  exit 1
fi

if [[ -z "${WF_ARGS// /}" ]]; then
  WF_ARGS=" --all-live"
  EXTRA_ARGS+=("--all-live")
fi

if [[ "${RSYNC:-1}" == "0" ]]; then
  SKIP_RSYNC=true
fi

resolve_path() {
  readlink -f "$1" 2>/dev/null || cd "$1" 2>/dev/null && pwd || echo "$1"
}

REPO_ROOT_RESOLVED="$(resolve_path "${REPO_ROOT}")"
REMOTE_BE_RESOLVED="$(resolve_path "${REMOTE_BE}")"

if [[ "${FORCE_LOCAL}" == "true" ]] || [[ "${REPO_ROOT_RESOLVED}" == "${REMOTE_BE_RESOLVED}" ]]; then
  LOCAL_ONLY=true
  SKIP_RSYNC=true
  REPO_ROOT="${REMOTE_BE}"
fi

collect_rsync_dirs() {
  node -e "
    const { collectBasenamesFromArgv } = require('${REPO_ROOT}/scripts/ml/walkforward-dir-presets.js');
    const argv = process.argv.slice(1);
    for (const d of collectBasenamesFromArgv(argv)) console.log(d);
  " "${EXTRA_ARGS[@]}"
}

print_rsync_from_laptop() {
  echo ""
  echo "Run rsync from your laptop (be-bot-trading repo with tmp/ exports):"
  echo ""
  while IFS= read -r dir; do
    [[ -z "${dir}" ]] && continue
    echo "  rsync -avz tmp/${dir}/ ${VPS_HOST}:${REMOTE_BE}/tmp/${dir}/"
  done < <(collect_rsync_dirs)
  echo ""
  echo "Then re-run on VPS:"
  echo "  cd ${REMOTE_BE} && npm run ml:deploy-rag-${DEPLOY_ENV}"
  echo ""
  echo "Or seed only what exists on VPS with a narrower preset, e.g.:"
  echo "  npm run ml:seed-embeddings-walkforward -- --min=${MIN_TRADES} --ts-all"
}

count_tmp_dirs() {
  local root="$1"
  local found=0
  local missing=0
  while IFS= read -r dir; do
    [[ -z "${dir}" ]] && continue
    if [[ -d "${root}/tmp/${dir}" ]]; then
      found=$((found + 1))
    else
      missing=$((missing + 1))
    fi
  done < <(collect_rsync_dirs)
  echo "${found} ${missing}"
}

if [[ "${LOCAL_ONLY}" == "true" ]]; then
  echo "==> ML/RAG deploy (local VPS mode) → ${DEPLOY_ENV} (${REMOTE_BE}, branch ${GIT_BRANCH})"
else
  echo "==> ML/RAG deploy → ${DEPLOY_ENV} (${VPS_HOST}:${REMOTE_BE}, branch ${GIT_BRANCH})"
fi

if [[ "${FROM_WALKFORWARD}" == "true" && "${SKIP_RSYNC}" != "true" ]]; then
  echo "==> Rsync local walkforward CSV dirs → ${VPS_HOST}:${REMOTE_BE}/tmp/"
  RSYNC_MISSING=0
  RSYNC_OK=0
  while IFS= read -r dir; do
    [[ -z "${dir}" ]] && continue
    local_src="${REPO_ROOT}/tmp/${dir}/"
    if [[ -d "${local_src}" ]]; then
      echo "    ${dir}/"
      rsync -avz "${local_src}" "${VPS_HOST}:${REMOTE_BE}/tmp/${dir}/"
      RSYNC_OK=$((RSYNC_OK + 1))
    else
      echo "    (skip ${dir} — not found locally; run walkforward export first)"
      RSYNC_MISSING=$((RSYNC_MISSING + 1))
    fi
  done < <(collect_rsync_dirs)
  if [[ "${RSYNC_OK}" -eq 0 ]]; then
    echo "ERROR: No local tmp/*-walkforward dirs found."
    echo "       Run walkforward exports locally, then retry from laptop."
    echo "       See: docs/ML_RAG_DEPLOY.md § Local refresh"
    exit 1
  fi
  if [[ "${RSYNC_MISSING}" -gt 0 ]]; then
    echo "WARN: ${RSYNC_MISSING} preset dir(s) missing locally — seed will use what exists on VPS."
  fi
elif [[ "${FROM_WALKFORWARD}" == "true" && "${SKIP_RSYNC}" == "true" ]]; then
  read -r TMP_FOUND TMP_MISSING <<< "$(count_tmp_dirs "${REPO_ROOT}")"
  if [[ "${LOCAL_ONLY}" == "true" ]]; then
    echo "==> Skipping rsync (already on VPS at ${REMOTE_BE})"
  else
    echo "==> Skipping rsync (--skip-rsync or RSYNC=0)"
  fi
  echo "    tmp dirs on target: ${TMP_FOUND} found, ${TMP_MISSING} missing for preset"
  if [[ "${TMP_FOUND}" -eq 0 ]]; then
    echo "ERROR: No tmp/*-walkforward dirs on VPS."
    print_rsync_from_laptop
    exit 1
  fi
  if [[ "${TMP_MISSING}" -gt 0 ]]; then
    echo "WARN: ${TMP_MISSING} preset dir(s) missing on VPS — seed will use what exists."
    if [[ "${LOCAL_ONLY}" == "true" ]]; then
      echo "       To sync missing dirs from laptop:"
      while IFS= read -r dir; do
        [[ -z "${dir}" ]] && continue
        [[ -d "${REPO_ROOT}/tmp/${dir}" ]] && continue
        echo "         rsync -avz tmp/${dir}/ ${VPS_HOST}:${REMOTE_BE}/tmp/${dir}/"
      done < <(collect_rsync_dirs)
    fi
  fi
fi

deploy_remote_script() {
  cat <<EOF
set -euo pipefail
cd "${REMOTE_BE}"

echo "==> git fetch + reset to origin/${GIT_BRANCH}"
if ! git fetch origin "${GIT_BRANCH}"; then
  echo "ERROR: git fetch failed — check VPS network and branch name (${GIT_BRANCH})"
  exit 1
fi
git merge --abort 2>/dev/null || true
git reset --hard "origin/${GIT_BRANCH}"

echo "==> npm ci"
npm ci

echo "==> prisma migrate deploy"
if ! npx prisma migrate deploy; then
  echo "ERROR: prisma migrate deploy failed"
  echo "       Fix migrations on ${GIT_BRANCH}, push, and re-run deploy."
  exit 1
fi

echo "==> verify pgvector + TradeEmbedding table"
node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
(async () => {
  try {
    const ext = await _pool.query(\"SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1\");
    if (!ext.rows.length) {
      console.error('ERROR: pgvector extension missing after migrate deploy');
      console.error('       Run: npx prisma migrate deploy');
      console.error('       Verify: SELECT * FROM pg_extension WHERE extname=\\'vector\\';');
      process.exit(1);
    }
    const tbl = await _pool.query(
      \"SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='TradeEmbedding' LIMIT 1\"
    );
    if (!tbl.rows.length) {
      console.error('ERROR: TradeEmbedding table missing — run: npx prisma migrate deploy');
      process.exit(1);
    }
    console.log('DB OK — pgvector', ext.rows[0].extversion);
  } catch (e) {
    const msg = e.message || String(e);
    console.error('ERROR: DB preflight failed:', msg);
    if (/ECONNREFUSED|connect/i.test(msg)) {
      console.error('       DATABASE_URL in ${REMOTE_BE}/.env may be wrong or Postgres is down.');
      console.error('       Seed must run ON VPS — not laptop localhost.');
    }
    process.exit(1);
  } finally {
    await _pool.end();
  }
})();
"

echo "==> Seeding TradeEmbedding from walkforward CSV (VPS DATABASE_URL + pgvector)"
if ! npm run ml:seed-embeddings-walkforward -- --min=${MIN_TRADES}${WF_ARGS}; then
  echo "ERROR: seed failed — check CSV paths under ${REMOTE_BE}/tmp/"
  echo "       Dry-run locally: npm run ml:seed-all-live:dry-run"
  exit 1
fi

if [[ "${SKIP_TRAIN}" != "true" ]]; then
  echo "==> npm run ml:train-win-predictor"
  npm run ml:train-win-predictor || {
    echo "WARN: train failed — git-pulled win-predictor.json may still work if committed."
  }
else
  echo "==> Skipping train (--skip-train; using data/models/win-predictor.json from git)"
fi

pm2 delete quantara-staging 2>/dev/null || true
echo "==> pm2 startOrReload ${PM2_APP}"
pm2 startOrReload ecosystem.config.js --only "${PM2_APP}" --update-env || pm2 start ecosystem.config.js --only "${PM2_APP}"
pm2 save

sleep 2
echo "==> Health (port ${HEALTH_PORT})"
curl -sf "http://127.0.0.1:${HEALTH_PORT}/health" && echo "" || echo "WARN: health check failed — pm2 logs ${PM2_APP}"

echo "==> TradeEmbedding counts"
node -e "
require('dotenv').config();
const { _pool } = require('./src/infrastructure/db/database');
Promise.all([
  _pool.query('SELECT COUNT(*)::int AS n FROM \"TradeEmbedding\"'),
  _pool.query(\"SELECT metadata->>'strategyKey' AS k, COUNT(*)::int AS n FROM \\\"TradeEmbedding\\\" GROUP BY 1 ORDER BY n DESC LIMIT 12\"),
]).then(([all, byStrat]) => {
  console.log(JSON.stringify({ embeddingCount: all.rows[0].n, byStrategy: byStrat.rows }, null, 2));
  return _pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
"

if [[ "${SKIP_TRAIN}" != "true" ]]; then
  node -e "
const fs = require('fs');
const model = 'data/models/win-predictor.json';
console.log(JSON.stringify({ hasModel: fs.existsSync(model), modelPath: model }, null, 2));
"
fi
EOF
}

if [[ "${LOCAL_ONLY}" == "true" ]]; then
  deploy_remote_script | bash
else
  deploy_remote_script | ssh "${VPS_HOST}" bash -s
fi

echo ""
echo "Done (${DEPLOY_ENV}). Verify:"
echo "  curl -H 'Authorization: Bearer <token>' https://staging.quantara.software/api/v1/backtest/rag-gate-status"
echo "  docs/ML_RAG_DEPLOY.md § Troubleshooting"
