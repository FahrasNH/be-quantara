#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-firewall.sh — Hardening firewall VPS Quantara (OPS-006).
# TIDAK butuh domain — bisa langsung dijalankan SEKARANG.
#
# Membuka HANYA: 22 (SSH), 80 (HTTP), 443 (HTTPS).
# Menutup sisanya — termasuk 3000/3001 (app) & 5432 (PostgreSQL) dari publik.
# Plus fail2ban untuk proteksi brute-force SSH.
#
# Jalankan di VPS sebagai root:
#   bash scripts/setup-firewall.sh
#
# AMAN: SSH (22) di-allow LEBIH DULU sebelum ufw enable, jadi tidak akan
# mengunci Anda keluar. Idempoten — boleh dijalankan berulang.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

echo "==> [1/5] Pasang ufw + fail2ban bila belum ada..."
if ! command -v ufw >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y ufw
fi
if ! command -v fail2ban-server >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y fail2ban
fi

echo "==> [2/5] Set default policy (deny incoming, allow outgoing)..."
ufw default deny incoming
ufw default allow outgoing

echo "==> [3/5] Allow SSH(22) DULU, lalu HTTP(80) + HTTPS(443)..."
# SSH pertama — krusial agar tidak terkunci keluar
ufw allow 22/tcp   comment 'SSH'
ufw allow 80/tcp   comment 'HTTP (nginx, redirect ke HTTPS)'
ufw allow 443/tcp  comment 'HTTPS (nginx)'

# Port app & DB SENGAJA TIDAK di-allow → hanya bisa diakses dari localhost.
# Pastikan juga app & PostgreSQL bind ke 127.0.0.1 (lihat catatan di bawah).

echo "==> [4/5] Aktifkan ufw..."
ufw --force enable
ufw reload

echo "==> [5/5] Konfigurasi fail2ban (jail SSH dasar)..."
cat > /etc/fail2ban/jail.local <<'JAIL'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = 22
JAIL
systemctl enable fail2ban
systemctl restart fail2ban

echo ""
echo "==> Status firewall:"
ufw status verbose
echo ""
echo "✅ Firewall aktif. Port terbuka: 22, 80, 443 saja."
echo ""
echo "⚠️  CATATAN PENTING — pastikan app & DB bind ke localhost (bukan 0.0.0.0):"
echo "   • PostgreSQL: /etc/postgresql/*/main/postgresql.conf →"
echo "       listen_addresses = 'localhost'   (lalu: systemctl restart postgresql)"
echo "   • Node app sudah pakai HOST dari .env — set HOST=127.0.0.1 di .env production"
echo "     (nginx tetap bisa proxy ke 127.0.0.1:3000)."
echo "   Verifikasi tak ada port bocor:  ss -tlnp | grep -E '3000|3001|5432'"
echo "   → harus tampil 127.0.0.1, BUKAN 0.0.0.0 / *"
