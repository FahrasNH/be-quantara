# 🚀 RUNBOOK GO-LIVE — Quantara Bot Trading (Bitget)

Dokumen operasional untuk menaikkan platform ke **production live trading** secara aman dan terukur. Dibuat setelah audit QA (SEV1–SEV3 tuntas), integration test (`npm test`, 181 hijau), dan tersedianya canary runner (`npm run canary`).

> **Prinsip:** rilis bertahap. Jangan pernah scale-up sebelum tahap sebelumnya LOLOS dengan bukti. Uang nyata = nol toleransi untuk "kira-kira".

---

## 0. Ringkasan tahapan

| Tahap | Tujuan | Gate lulus |
|-------|--------|-----------|
| 1. Pre-deploy | Kode & test bersih | `npm test` hijau, lint OK |
| 2. Env & secrets | Konfigurasi production benar | `cfg.validate()` lolos |
| 3. Exchange safety | API key aman | No-withdraw + IP whitelist terverifikasi |
| 4. Deploy staging | Smoke test fungsional | Login/bot/balance OK |
| 5. Canary live | Uji uang kecil 24–48 jam | Verdict LOLOS canary |
| 6. Scale-up | Naikkan modal/bot bertahap | Tiap step stabil |
| 7. Monitoring rutin | Operasi berkelanjutan | Alert & backup jalan |

---

## 1. Pre-deploy checklist (kode)

- [ ] Branch rilis ter-merge & tag versi dibuat
- [ ] `npm ci` bersih (lockfile konsisten)
- [ ] `npm test` → **semua hijau** (indicators, strategies, AccountCoordinator, integration-security-risk)
- [ ] `npm run lint` tanpa error
- [ ] Tidak ada secret ter-commit (grep `apiKey`, `SECRET`, `.env`)
- [ ] Migrasi Prisma siap (`prisma migrate deploy` di target)
- [ ] CHANGELOG / catatan rilis berisi fix SEV1–SEV3

**Bukti SEV fixes (regression guard):**
```bash
npm run test:integration   # 19 test: IDOR, sizing abort, risk gate, naked, re-entrancy
npm run test:coordinator   # margin lintas-bot (#5)
```

---

## 2. Environment & secrets (production)

Wajib di-set (server fail-fast via `cfg.validate()` bila kosong/placeholder):

- [ ] `DATABASE_URL` → Postgres production
- [ ] `JWT_SECRET` (kuat, unik) — **≠** `JWT_REFRESH_SECRET`
- [ ] `JWT_REFRESH_SECRET` (kuat, unik)
- [ ] `ENCRYPTION_KEY` = 64 hex char (`openssl rand -hex 32`) — **untuk enkripsi API key user**
- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGINS` = domain frontend production
- [ ] `TRUST_PROXY_HOPS` = jumlah hop nginx (umumnya `1`)
- [ ] `AUTH_RATE_LIMIT` / `API_RATE_LIMIT` sesuai kebutuhan
- [ ] (Opsional) `MAX_ACCOUNT_DAILY_LOSS_PCT` — batas kerugian harian AGREGAT lintas-bot per akun (default `0.06` = 6%). Lihat #5.
- [ ] (Opsional) `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` untuk alert

> ⚠️ Setelah `ENCRYPTION_KEY` di-set di production, **jangan pernah diganti** tanpa migrasi — API key user yang sudah terenkripsi akan gagal di-decrypt.

Verifikasi:
```bash
node -e "require('./src/config/env').validate(); console.log('ENV OK')"
```

---

## 3. Exchange safety (Bitget) — WAJIB sebelum live

Untuk **setiap** akun user yang akan live:

- [ ] API key Bitget dibuat dengan permission **Read + Trade SAJA** — **TANPA Withdraw** ❗
- [ ] **IP whitelist** aktif → hanya IP server production
- [ ] Margin mode akun = sesuai strategi (bot set `crossed` otomatis; verifikasi di log `Leverage diset ✓`)
- [ ] Saldo akun = **modal kecil** untuk fase canary (lihat tahap 5)
- [ ] Passphrase benar (Bitget butuh 3 field: key, secret, passphrase)
- [ ] Uji koneksi: `GET /api/v1/account/exchange-balance` → `configured: true`, equity benar

---

## 4. Deploy staging + smoke test

- [ ] Deploy ke staging (`scripts/deploy-staging-vps.sh`)
- [ ] `prisma migrate deploy` sukses
- [ ] Health check: `GET /health` → `ok:true`
- [ ] Smoke fungsional:
  - [ ] Register/login → token keluar
  - [ ] Set API key di Settings → tersimpan terenkripsi (`/account/keys` mask, bukan plaintext)
  - [ ] Start bot **dry-run** → status running, log mengalir (WS)
  - [ ] `GET /bots/:symbol` → config+state terisi
  - [ ] **IDOR check**: user B coba akses sesi/equity milik user A → `404/kosong` (bukan data A)
- [ ] Stop bot dry-run → bersih

---

## 5. Canary live (24–48 jam) — gate paling penting

**Tujuan:** membuktikan eksekusi live aman dengan uang minimal sebelum modal nyata.

### 5.1 Persiapan
- [ ] Akun Bitget canary berisi **modal kecil** (mis. $20–$50), tidak lebih
- [ ] `ENCRYPTION_KEY` & API key user terpasang (tahap 2 & 3)
- [ ] Backend production jalan & sehat

### 5.2 Jalankan
```bash
cp .env.canary.example .env.canary    # edit: email, password, capital, drawdown
export $(grep -v '^#' .env.canary | xargs) && npm run canary
```
Canary akan:
- Pre-flight (tolak jalan bila equity akun > `CANARY_MAX_ACCOUNT_USDT`)
- Start **1 bot live** modal kecil
- Monitor equity/posisi/log; **auto-stop** bila drawdown ≥ batas (default 5%) atau naked/SL-failure terdeteksi
- Kirim alert Telegram + cetak SUMMARY akhir

### 5.3 Pantau langsung (24–48 jam)
- [ ] Heartbeat berjalan tiap interval, equity wajar
- [ ] Order live tereksekusi & SL/TP **benar-benar terpasang** di Bitget (cek manual di dashboard exchange untuk ≥1 trade)
- [ ] Tidak ada log danger (naked/SL gagal/intervensi manual)
- [ ] Notifikasi Telegram open/close masuk
- [ ] Restart bot di tengah → risk counter (daily loss/streak) **tetap** (tidak reset) — verifikasi log "🛡️ Risk dipulihkan dari DB"

### 5.4 Kriteria LULUS canary (semua harus YA)
- [ ] Verdict canary = **✅ LOLOS** (bukan naked, drawdown tidak tembus)
- [ ] Min. 1 siklus open→close live terverifikasi benar (entry, SL/TP, PnL, fee tercatat)
- [ ] Tidak ada intervensi manual diperlukan
- [ ] Balance exchange cocok dengan PnL net yang dilaporkan (toleransi fee/funding)

> Jika **GAGAL**: jangan lanjut. Investigasi root cause, perbaiki, ulang dari tahap 1.

---

## 6. Scale-up bertahap (setelah canary LOLOS)

Naikkan **satu dimensi per langkah**, minimal 48 jam stabil sebelum step berikutnya. Hentikan & evaluasi bila ada anomali.

| Step | Modal | Bot/Simbol | Catatan |
|------|-------|-----------|---------|
| S1 | $20–50 | 1 bot | = canary |
| S2 | $100–200 | 1 bot | konfirmasi sizing proporsional |
| S3 | $100–200 | 2–3 bot | **uji AccountCoordinator** — margin total ≤ 80% equity |
| S4 | naikkan modal | 2–3 bot | sesuai toleransi risiko user |

**Cek khusus saat multi-bot (S3+):**
- [ ] Log koordinator: entry ditahan bila margin akun akan over-commit ("🚦 Entry ditahan koordinator akun")
- [ ] Total margin terpakai tidak pernah > 80% equity
- [ ] **Daily-loss agregat akun aktif** (default 6%, `MAX_ACCOUNT_DAILY_LOSS_PCT`): entry seluruh bot ditahan bila Σ(realized+floating) loss harian lintas-bot ≥ batas — mencegah akumulasi 3×4%=12%. Verifikasi via log gate akun saat diuji.

---

## 7. Monitoring & operasi rutin

- [ ] Alert Telegram aktif (open/close/error)
- [ ] Backup DB otomatis jalan (`scripts/setup-cron-backup.sh`) & **restore teruji**
- [ ] Pantau: error beruntun bot, gap balance vs PnL, latency exchange, rate-limit 429
- [ ] Health check eksternal (uptime monitor) ke `/health`
- [ ] Review mingguan: win rate, drawdown, anomali log

---

## 8. Prosedur ROLLBACK / Emergency stop

### 8.1 Emergency stop (hentikan trading SEGERA)
1. **Stop bot via API/dashboard:** `POST /api/v1/bots/:symbol/stop` (per bot)
2. Bila canary aktif: `Ctrl-C` → canary stop bot otomatis + summary
3. **Tutup posisi manual di Bitget** bila perlu (jangan andalkan bot bila bot bermasalah)
4. **Cabut/disable API key** di Bitget bila dicurigai kompromi (`DELETE /account/keys` + revoke di Bitget)

### 8.2 Rollback rilis (kode/DB)
**Sebelum deploy** pastikan ada:
- [ ] Tag versi sebelumnya (untuk checkout cepat)
- [ ] Snapshot/backup DB terbaru (sebelum `migrate deploy`)

**Langkah rollback:**
1. Stop semua bot (8.1) — pastikan tidak ada order live menggantung
2. Deploy ulang tag versi stabil sebelumnya
3. Bila migrasi DB tak kompatibel → restore DB dari backup pre-deploy
4. Verifikasi `/health` + login + `npm run test:integration` (di staging mirror)
5. Post-mortem: catat root cause sebelum mencoba rilis ulang

### 8.3 Kontak & eskalasi
- [ ] PIC on-call + nomor exchange support tercatat
- [ ] Lokasi backup DB & cara restore terdokumentasi
- [ ] Akses dashboard Bitget untuk intervensi manual tersedia

---

## 9. Sign-off go-live

| Peran | Verifikasi | Nama | Tanggal |
|-------|-----------|------|---------|
| QA | SEV1–3 fixed, test hijau, canary LOLOS | | |
| Dev | Env/secrets/migrasi benar | | |
| Ops | Backup+monitoring+rollback siap | | |
| Owner | Modal & toleransi risiko disetujui | | |

> Production GO hanya bila **keempat sign-off** lengkap **dan** canary verdict ✅ LOLOS.

---

## Lampiran — perintah cepat

```bash
# Test & bukti regresi
npm test
npm run test:integration

# Validasi env production
node -e "require('./src/config/env').validate(); console.log('ENV OK')"

# Canary live (modal kecil)
export $(grep -v '^#' .env.canary | xargs) && npm run canary

# Emergency stop satu bot (butuh TOKEN)
curl -X POST "$API/api/v1/bots/BTCUSDT/stop" -H "Authorization: Bearer $TOKEN"

# Cek balance exchange riil
curl "$API/api/v1/account/exchange-balance" -H "Authorization: Bearer $TOKEN"
```

---

**Referensi:** audit QA (SEV1–SEV3), `test/integration-security-risk.test.js`, `scripts/canary.js`, `.env.canary.example`.
