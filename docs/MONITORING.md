# 📡 Monitoring & Threshold — Quantara Bot Trading

Apa yang dipantau saat bot LIVE, ambang batas, dan sinyal bahaya.

---

## 1. Risk gate per-bot (otomatis, `BotEngine._checkRiskGates`)

Bot **berhenti entry** otomatis bila salah satu terpenuhi:

| Gate | TS_TF | MD_MR | BS_BR |
|------|-------|-------|-------|
| Max risk/trade | 3% | 2% | 4% |
| **Daily loss limit** | 6% | 5% | 8% |
| Max trade/hari | 6 | 3 | 7 |
| Cooldown setelah loss | 10 min | 15 min | 5 min |
| Max loss beruntun | 2 | 2 | 3 |

> ⚠️ Counter (`dailyLoss`, `consecLoss`, `dailyTradeCount`) di-recompute dari trade
> hari ini saat startup → **bertahan setelah restart/redeploy** (tidak ter-reset).

## 2. Gate level-AKUN (lintas-bot, `AccountCoordinator`)

Beberapa bot berbagi 1 akun. Koordinator mencegah over-commit:

| Parameter | Default | Arti |
|-----------|---------|------|
| `maxAccountUtilization` | 0.8 | Σ margin semua posisi ≤ 80% equity |
| `maxAccountDailyLossPct` | 0.06 | Stop entry lintas-bot bila loss agregat (realized+floating) ≥ 6% |
| `maxConcurrentPositions` | 0 (∞) | Batas posisi serentak (0 = dibatasi anggaran margin) |
| per simbol | 1 | Maks 1 posisi/simbol di akun |

Konfigurasi via env: `MAX_ACCOUNT_DAILY_LOSS_PCT`, `cfg.maxAccountUtilization`, `cfg.maxConcurrentPositions`.

---

## 3. Yang HARUS dipantau manusia

| Item | Sumber | Ambang ALERT |
|------|--------|--------------|
| **Posisi tanpa SL** | log `🚨 SL tidak terkonfirmasi` | apa pun → INTERVENSI |
| **Emergency close** | log `SL_FAILED_EMERGENCY_CLOSE` | sering → cek koneksi exchange |
| Balance gagal dibaca | log `Balance gagal dibaca — skip entry` | berulang → cek API key/rate-limit |
| Entry ditahan koordinator | log `🚦 Entry ditahan koordinator` | sering → equity/margin mepet |
| Drawdown akun | equity exchange | mendekati `maxAccountDailyLossPct` |
| Daily loss per bot | `riskState.dailyLoss` di status bot | mendekati limit |
| Net vs Gross PnL | dashboard | gap besar = fee tinggi (cek leverage) |
| WS terputus | dashboard badge `○ Offline` | data tidak real-time |

## 4. Health & uptime

- `GET /health` → cek `ok:true`, `uptime` naik.
- PM2: `pm2 list`, `pm2 logs quantara --lines 50`.
- DB: pastikan `init()` jalan saat boot (migrasi kolom fee/funding idempotent).

## 5. Notifikasi

- **Telegram** (`TelegramNotifier.js`): notifikasi open/close trade — set `TELEGRAM_*` env.
- **AlertManager** (`AlertManager.js`): alert kondisi kritis.
- Logging terstruktur via DB `logs` table (per session) + stdout (PM2).

## 6. Sinyal "matikan sekarang" (lihat [EMERGENCY.md](EMERGENCY.md))

- Posisi terbuka tanpa SL yang gagal di-emergency-close.
- Daily loss akun menembus batas tapi bot tetap entry (bug gate).
- Balance turun tak wajar vs trade tercatat (kemungkinan eksekusi tak sinkron).
- API key bocor / aktivitas withdraw tak dikenal.
