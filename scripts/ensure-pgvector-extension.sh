#!/usr/bin/env bash
# Provision pgvector extension in a Postgres database (requires superuser / postgres OS user).
#
# Prisma migrate runs as quantara_dev / quantara_staging — those roles cannot
# CREATE EXTENSION. Run this once per database before prisma migrate deploy.
#
# Usage (BE repo root):
#   bash scripts/ensure-pgvector-extension.sh
#   bash scripts/ensure-pgvector-extension.sh bot_trading_development
#
# Reads DATABASE_URL from .env when DB name not passed.

set -euo pipefail

BE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${BE_DIR}"

DB_NAME="${1:-}"

if [[ -z "${DB_NAME}" && -f .env ]]; then
  DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '"')"
  # postgresql://user:pass@host:5432/dbname?schema=public
  DB_NAME="$(echo "${DB_URL}" | sed -E 's|.*/([^/?]+)(\?.*)?$|\1|')"
fi

if [[ -z "${DB_NAME}" ]]; then
  echo "ERROR: database name required (arg or DATABASE_URL in .env)"
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "WARN: psql not found — run manually as postgres superuser:"
  echo "  CREATE EXTENSION IF NOT EXISTS vector;  -- database: ${DB_NAME}"
  exit 0
fi

echo "==> Ensuring pgvector extension in database '${DB_NAME}' (postgres superuser)..."

if id postgres >/dev/null 2>&1; then
  sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
else
  # Already root / superuser shell on VPS
  psql -U postgres -d "${DB_NAME}" -v ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS vector;"
fi

echo "✓ pgvector extension ready in ${DB_NAME}"
