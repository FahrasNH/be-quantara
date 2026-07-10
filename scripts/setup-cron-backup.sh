#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-cron-backup.sh — Daftarkan backup otomatis via cron di VPS
#
# Jalankan SEKALI di VPS (sebagai root atau user yang menjalankan app):
#   bash /opt/quantara-staging/be/scripts/setup-cron-backup.sh
#
# Jadwal default: setiap hari jam 02:00 WIB (UTC+7 = 19:00 UTC)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-db.sh"
LOG_FILE="/var/log/quantara-backup.log"
CRON_TAG="quantara-backup"

# Jam backup (UTC). 19:00 UTC = 02:00 WIB
CRON_HOUR="${CRON_HOUR:-19}"
CRON_MIN="${CRON_MIN:-0}"

if [[ ! -f "${BACKUP_SCRIPT}" ]]; then
  echo "ERROR: ${BACKUP_SCRIPT} tidak ditemukan."
  exit 1
fi

chmod +x "${BACKUP_SCRIPT}"
touch "${LOG_FILE}" 2>/dev/null || LOG_FILE="/tmp/quantara-backup.log"

CRON_LINE="${CRON_MIN} ${CRON_HOUR} * * * bash ${BACKUP_SCRIPT} >> ${LOG_FILE} 2>&1  # ${CRON_TAG}"

echo "==> Mendaftarkan cron job backup..."
echo "    Script  : ${BACKUP_SCRIPT}"
echo "    Jadwal  : ${CRON_MIN} ${CRON_HOUR} * * * (setiap hari ${CRON_HOUR}:${CRON_MIN} UTC = ~02:00 WIB)"
echo "    Log     : ${LOG_FILE}"
echo ""

# Hapus entry lama (jika ada), lalu tambahkan yang baru
( crontab -l 2>/dev/null | grep -v "${CRON_TAG}" ; echo "${CRON_LINE}" ) | crontab -

echo "==> Cron terdaftar. Verifikasi:"
crontab -l | grep "${CRON_TAG}"

echo ""
echo "==> Test backup sekarang (opsional)..."
read -p "Jalankan backup sekarang untuk verifikasi? [y/N] " -n 1 -r; echo
if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
  bash "${BACKUP_SCRIPT}"
fi

echo ""
echo "Selesai. Untuk melihat backup:"
echo "  ls -lh /opt/quantara-backups/"
echo "  bash ${BACKUP_SCRIPT} --list"
echo ""
echo "Untuk restore (HATI-HATI — akan timpa DB):"
echo "  bash ${BACKUP_SCRIPT} --restore /opt/quantara-backups/quantara_YYYYMMDD_HHMMSS.sql.gz"
