#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-db.sh — Backup database Quantara ke file pg_dump + CSV trades
#
# Jalankan di VPS (langsung atau via cron). Tidak butuh password jika user
# sudah di-set di ~/.pgpass atau di DATABASE_URL.
#
# Usage:
#   bash scripts/backup-db.sh                   # backup sekarang
#   bash scripts/backup-db.sh --restore FILE    # restore dari file
#   bash scripts/backup-db.sh --list            # list semua backup
#   bash scripts/backup-db.sh --cleanup         # hapus backup > RETENTION hari
#
# Cron (tiap hari jam 02:00):
#   0 2 * * * /opt/quantara-staging/be-bot-trading/scripts/backup-db.sh >> /var/log/quantara-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Konfigurasi ───────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# Load .env jika ada
if [[ -f "${ENV_FILE}" ]]; then
  export $(grep -v '^#' "${ENV_FILE}" | grep -v '^$' | xargs) 2>/dev/null || true
fi

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-/opt/quantara-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"   # simpan 30 hari terakhir
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# ── Parse DATABASE_URL → komponen pg ─────────────────────────────────────────
# Format: postgresql://user:pass@host:port/dbname
parse_db_url() {
  local url="$1"
  # Strip schema
  url="${url#postgresql://}"
  url="${url#postgres://}"
  # user:pass@host:port/dbname
  DB_USER="${url%%:*}"
  url="${url#*:}"
  DB_PASS="${url%%@*}"
  url="${url#*@}"
  DB_HOST="${url%%:*}"
  url="${url#*:}"
  DB_PORT="${url%%/*}"
  DB_NAME="${url#*/}"
  DB_NAME="${DB_NAME%%\?*}"  # hapus query string
}

if [[ -z "${DATABASE_URL}" ]]; then
  echo "ERROR: DATABASE_URL tidak di-set. Pastikan .env ada atau export DATABASE_URL."
  exit 1
fi

parse_db_url "${DATABASE_URL}"

# ── Sub-commands ──────────────────────────────────────────────────────────────

cmd_list() {
  echo "=== Backup yang tersimpan di ${BACKUP_DIR} ==="
  if [[ -d "${BACKUP_DIR}" ]]; then
    ls -lh "${BACKUP_DIR}"/*.sql.gz "${BACKUP_DIR}"/*.csv 2>/dev/null \
      | awk '{print $5, $9}' \
      | sort -r \
      || echo "(belum ada backup)"
  else
    echo "(folder belum ada)"
  fi
}

cmd_restore() {
  local file="${1:-}"
  if [[ -z "${file}" ]]; then
    echo "ERROR: Sebutkan file backup. Contoh: --restore /opt/quantara-backups/quantara_20260606_020000.sql.gz"
    exit 1
  fi
  if [[ ! -f "${file}" ]]; then
    echo "ERROR: File tidak ditemukan: ${file}"
    exit 1
  fi
  echo "⚠️  RESTORE akan MENIMPA database ${DB_NAME} di ${DB_HOST}:${DB_PORT}!"
  echo "    File: ${file}"
  read -p "Lanjutkan? [y/N] " -n 1 -r; echo
  [[ "${REPLY}" =~ ^[Yy]$ ]] || { echo "Dibatalkan."; exit 0; }

  echo "==> Restore dari ${file}..."
  PGPASSWORD="${DB_PASS}" gunzip -c "${file}" \
    | PGPASSWORD="${DB_PASS}" psql -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_NAME}"
  echo "✅ Restore selesai."
}

cmd_cleanup() {
  echo "==> Hapus backup lebih dari ${RETENTION_DAYS} hari..."
  find "${BACKUP_DIR}" -name "quantara_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete -print \
    | while read f; do echo "  Dihapus: $f"; done
  echo "   Cleanup selesai."
}

# ── Backup utama ──────────────────────────────────────────────────────────────

cmd_backup() {
  mkdir -p "${BACKUP_DIR}"

  local DUMP_FILE="${BACKUP_DIR}/quantara_${TIMESTAMP}.sql.gz"
  local TRADES_CSV="${BACKUP_DIR}/trades_${TIMESTAMP}.csv"
  local SESSIONS_CSV="${BACKUP_DIR}/sessions_${TIMESTAMP}.csv"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ==> Backup dimulai"
  echo "    DB      : ${DB_NAME}@${DB_HOST}:${DB_PORT}"
  echo "    Output  : ${DUMP_FILE}"
  echo "    Retain  : ${RETENTION_DAYS} hari"

  # 1. Full pg_dump (semua tabel, compressed)
  PGPASSWORD="${DB_PASS}" pg_dump \
    -h "${DB_HOST}" \
    -p "${DB_PORT}" \
    -U "${DB_USER}" \
    "${DB_NAME}" \
    | gzip > "${DUMP_FILE}"

  local SIZE
  SIZE="$(du -sh "${DUMP_FILE}" | cut -f1)"
  echo "    Dump OK : ${DUMP_FILE} (${SIZE})"

  # 2. CSV trades — lightweight, human-readable, mudah di-inspect
  PGPASSWORD="${DB_PASS}" psql \
    -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_NAME}" \
    -c "\COPY (
          SELECT t.id, t.session_id, s.user_id, t.exchange, t.symbol, t.side,
                 t.entry_price, t.exit_price, t.sl, t.tp, t.size, t.pnl, t.pnl_pct,
                 t.reason, t.open_time, t.close_time, t.dry_run, t.order_id, t.atr
          FROM trades t
          LEFT JOIN bot_sessions s ON s.id = t.session_id
          ORDER BY t.open_time DESC
        ) TO STDOUT WITH CSV HEADER" \
    > "${TRADES_CSV}" 2>/dev/null && \
    echo "    CSV OK  : ${TRADES_CSV} ($(wc -l < "${TRADES_CSV}") baris)" || \
    echo "    CSV     : gagal (non-fatal)"

  # 3. CSV sessions
  PGPASSWORD="${DB_PASS}" psql \
    -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" "${DB_NAME}" \
    -c "\COPY (
          SELECT id, user_id, exchange, symbol, mode, initial_capital, final_capital,
                 total_trades, wins, losses, started_at, stopped_at
          FROM bot_sessions
          ORDER BY started_at DESC
        ) TO STDOUT WITH CSV HEADER" \
    > "${SESSIONS_CSV}" 2>/dev/null && \
    echo "    CSV OK  : ${SESSIONS_CSV} ($(wc -l < "${SESSIONS_CSV}") baris)" || \
    echo "    CSV     : gagal (non-fatal)"

  # 4. Buat symlink ke backup terbaru (mudah untuk cek cepat)
  ln -sf "${DUMP_FILE}"    "${BACKUP_DIR}/latest.sql.gz"
  ln -sf "${TRADES_CSV}"   "${BACKUP_DIR}/trades_latest.csv"
  ln -sf "${SESSIONS_CSV}" "${BACKUP_DIR}/sessions_latest.csv"

  # 5. Cleanup backup lama
  local DELETED
  DELETED=$(find "${BACKUP_DIR}" -name "quantara_*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete -print | wc -l)
  find "${BACKUP_DIR}" -name "trades_*.csv" -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
  find "${BACKUP_DIR}" -name "sessions_*.csv" -mtime "+${RETENTION_DAYS}" -delete 2>/dev/null || true
  [[ "${DELETED}" -gt 0 ]] && echo "    Cleanup : ${DELETED} backup lama dihapus"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Backup selesai"
}

# ── Router ────────────────────────────────────────────────────────────────────
case "${1:-backup}" in
  --restore) cmd_restore "${2:-}" ;;
  --list)    cmd_list ;;
  --cleanup) cmd_cleanup ;;
  backup|*)  cmd_backup ;;
esac
