# 🚨 Prosedur Darurat — Quantara Bot Trading

Langkah saat terjadi kondisi kritis pada bot LIVE (uang riil). Urut dari paling cepat.

> **Prinsip:** Saat ragu, **hentikan entry dulu, amankan posisi, baru investigasi.**
> Lebih baik melewatkan peluang daripada kehilangan modal tak terkendali.

---

## 🔴 SKENARIO 1 — Posisi terbuka TANPA Stop Loss

**Gejala:** log `🚨 SL tidak terkonfirmasi` atau `‼️ GAGAL tutup darurat — INTERVENSI MANUAL DIPERLUKAN`.

**Tindakan (segera):**
1. Buka **Bitget** langsung (web/app) — jangan andalkan bot.
2. Pasang **Stop Loss manual** pada posisi tersebut, ATAU **tutup posisi** market.
3. Setelah aman, stop bot simbol itu: `POST /api/v1/bots/:symbol/stop`.
4. Cek log penyebab (gagal `setTPSL`? rate-limit? koneksi?).

> Bot sudah punya proteksi: jika SL preset gagal → 3× retry → **emergency close**.
> Skenario ini hanya terjadi bila emergency close JUGA gagal (mis. exchange down).

---

## 🔴 SKENARIO 2 — Hentikan SEMUA bot segera

**Via API (per user):**
```bash
# stop tiap simbol
curl -X POST http://<host>/api/v1/bots/BTCUSDT/stop -H "Authorization: Bearer <token>"
# ulangi untuk ETHUSDT, SOLUSDT, dst
```

**Via server (paling cepat, hentikan proses):**
```bash
pm2 stop quantara          # produksi (hentikan engine)
pm2 logs quantara --lines 100   # cek kondisi terakhir
```

> ⚠️ `pm2 stop` menghentikan loop bot, TAPI **posisi terbuka tetap ada di exchange**.
> Posisi akan dipulihkan & dikelola lagi saat `pm2 restart`. Untuk benar-benar
> bebas risiko: **tutup posisi manual di Bitget** setelah stop.

---

## 🔴 SKENARIO 3 — Dugaan API key bocor / aktivitas tak dikenal

1. **Bitget:** revoke/hapus API key yang dipakai bot **sekarang**.
2. Pastikan API key bot **tanpa permission withdraw** + **IP whitelist** aktif (preventif).
3. Di app: `DELETE /api/v1/account/keys` (putus exchange) → bot live tak bisa entry.
4. Ganti password akun & rotasi kredensial.

---

## 🔴 SKENARIO 4 — Balance turun tak wajar vs trade tercatat

Kemungkinan eksekusi tak sinkron (slippage besar, fee, posisi manual, funding).
1. Stop bot simbol terkait.
2. Bandingkan: `GET /api/v1/account/exchange-balance` (equity riil) vs `GET /api/v1/history/trades/stats/:sessionId` (net PnL).
3. Ingat: `totalPnL` dashboard = **gross**; selisih balance = **net** (lihat [API.md](API.md)). Gap wajar = fee + funding.
4. Jika gap tak terjelaskan → jangan restart bot live; investigasi dulu.

---

## 🟠 SKENARIO 5 — Daily-loss limit tertembus tapi bot tetap entry

Indikasi bug gate. Bot seharusnya stop otomatis (lihat [MONITORING.md](MONITORING.md)).
1. Stop bot segera (Skenario 2).
2. Cek `riskState` di status bot: `dailyLoss`, `cooldownUntil`, `consecLoss`.
3. Cek koordinator akun: `GET /api/v1/bots/:symbol/position-conflicts`.
4. Laporkan + jangan jalankan live sampai gate diverifikasi.

---

## 🔧 Rollback deployment

```bash
# di VPS, kembali ke commit stabil sebelumnya
cd /opt/be-quantara
git log --oneline -5
git reset --hard <commit-stabil>
npm ci && pm2 restart quantara
```
DB: migrasi bersifat idempotent & aditif (kolom fee/funding) → rollback kode aman,
data tidak hilang. **Jangan** drop kolom.

---

## Kontak & checklist pasca-insiden

- [ ] Semua posisi aman (SL terpasang / ditutup).
- [ ] Bot dihentikan / di-rollback.
- [ ] Penyebab dicatat (log + timestamp).
- [ ] API key aman (jika relevan).
- [ ] Postmortem singkat sebelum live lagi.

> Nomor kontak tim / channel on-call: _isi sesuai tim Anda_.
