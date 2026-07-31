#!/usr/bin/env bash
# Back-compat wrapper — prefer deploy-rag-vps.sh or npm run ml:deploy-rag-staging.
#
# Usage:
#   ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --all-live --skip-train
#   RSYNC=1 ./scripts/ml/deploy-rag-staging-remote.sh --from-walkforward --tf-all

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/deploy-rag-vps.sh" --env staging "$@"
