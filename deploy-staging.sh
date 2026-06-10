#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Deploy BE to staging VPS from local machine
#
# Usage:
#   cd be-bot-trading
#   git pull origin staging
#   chmod +x deploy-staging.sh
#   ./deploy-staging.sh
#
# Environment:
#   STAGING_VPS_HOST    — VPS hostname (default: staging-be)
#   STAGING_VPS_USER    — SSH user (default: root)
#   REMOTE_BE           — BE path (default: /opt/quantara-staging/be)
#   PM2_APP             — PM2 app name (default: quantara-staging)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Config
STAGING_VPS_HOST="${STAGING_VPS_HOST:-staging-be}"
STAGING_VPS_USER="${STAGING_VPS_USER:-root}"
REMOTE_BE="${REMOTE_BE:-/opt/quantara-staging/be}"
PM2_APP="${PM2_APP:-quantara-staging}"
GIT_BRANCH="${GIT_BRANCH:-staging}"

BE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Backend Staging Deploy"
echo "    VPS: $STAGING_VPS_USER@$STAGING_VPS_HOST"
echo "    Path: $REMOTE_BE"
echo "    PM2: $PM2_APP"
echo ""

# Verify git is clean or all changes staged
if ! git diff-index --quiet HEAD --; then
  echo "⚠️  You have uncommitted changes. Commit or stash them first:"
  git status
  exit 1
fi

echo "==> Deploying to VPS via SSH..."
ssh "$STAGING_VPS_USER@$STAGING_VPS_HOST" << REMOTE_SCRIPT
  set -euo pipefail

  REMOTE_BE="$REMOTE_BE"
  PM2_APP="$PM2_APP"
  GIT_BRANCH="$GIT_BRANCH"

  echo "==> [VPS] Deploy BE staging"
  echo "    Path:    \${REMOTE_BE}"
  echo "    PM2 app: \${PM2_APP}"
  echo "    Branch:  \${GIT_BRANCH}"

  if [[ ! -f "\$REMOTE_BE/.env" ]]; then
    echo "ERROR: .env not found at \$REMOTE_BE/.env"
    echo "       Run setup-staging-vps.sh or copy .env manually"
    exit 1
  fi

  cd "\$REMOTE_BE"

  echo "==> git fetch origin \${GIT_BRANCH}..."
  git fetch origin "\$GIT_BRANCH"

  # Deploy server: selaraskan ke origin (hindari merge conflict dari file lokal)
  echo "==> git reset --hard origin/\${GIT_BRANCH}..."
  git merge --abort 2>/dev/null || true
  git reset --hard "origin/\$GIT_BRANCH"

  echo "==> npm install (with fallback)..."
  if [[ ! -f package-lock.json ]]; then
    echo "    package-lock.json missing, using npm install..."
    npm install
  else
    npm ci
  fi

  echo "==> prisma migrate deploy..."
  npx prisma migrate deploy

  echo "==> pm2 restart \${PM2_APP}..."
  if pm2 describe "\$PM2_APP" >/dev/null 2>&1; then
    pm2 restart "\$PM2_APP"
  else
    echo "    App not in PM2 yet, starting..."
    pm2 start index.js --name "\$PM2_APP"
  fi

  pm2 save

  echo "==> Health check..."
  sleep 2
  if curl -sf "http://127.0.0.1:3001/health" >/dev/null 2>&1; then
    echo "✓ Health check passed"
  else
    echo "⚠️  Health check failed — check: pm2 logs \$PM2_APP"
  fi

  echo ""
  echo "==> Deploy complete!"
  pm2 status "\$PM2_APP" 2>/dev/null || echo "(PM2 status unavailable)"
REMOTE_SCRIPT

echo ""
echo "✓ Backend deployed successfully"
echo ""
echo "Next steps:"
echo "  1. Check VPS logs: pm2 logs $PM2_APP"
echo "  2. Check database: ssh $STAGING_VPS_USER@$STAGING_VPS_HOST"
echo "  3. Verify health: curl -sf https://staging.example.com/api/v1/health"
echo ""
