# 🔌 Dokumentasi API — Quantara Backend (untuk QA)

Base URL: `http://<host>/api/v1`
Auth: **JWT Bearer** (`Authorization: Bearer <accessToken>`) kecuali endpoint publik.

**Bentuk error konsisten:** `{ "ok": false, "statusCode": <n>, "message": "..." }`

**Rate limit:** 1000 req/15min per IP (umum); 10 req/15min produksi untuk auth POST;
refresh punya limiter sendiri (20/15min). Header `RateLimit-*` dikirim.

---

## Auth — `/api/v1/auth` (publik)

| Method | Path | Body | Catatan |
|--------|------|------|---------|
| POST | `/register` | `{ email, password }` | bcrypt cost 12 |
| POST | `/login` | `{ email, password }` | → `{ accessToken (15m), refreshToken (7d) }` |
| POST | `/refresh` | `{ refreshToken }` | rotasi; cari sesi via bcrypt-match (multi-device aman) |
| GET | `/me` | — | profil user (perlu auth) |
| POST | `/logout` | `{ refreshToken }` | hapus sesi |

**QA wajib cek:** token kadaluarsa → 401; refresh token salah → 401; rate-limit auth → 429.

---

## Bots — `/api/v1/bots` (auth, user-isolated)

| Method | Path | Fungsi |
|--------|------|--------|
| GET | `/` | semua bot milik user + live state |
| GET | `/logs` | log semua bot user |
| GET | `/strategies/available` | daftar strategi |
| GET | `/strategies/info/:key` | detail strategi |
| GET | `/:symbol` | satu bot |
| GET | `/:symbol/balance` | balance bot |
| GET | `/:symbol/logs` | log bot |
| GET | `/:symbol/position-conflicts` | konflik posisi (koordinator) |
| POST | `/:symbol/start` | start bot (live butuh API key user) |
| POST | `/:symbol/stop` | stop bot |
| POST | `/:symbol/strategy` | ganti strategi bot |

---

## Account — `/api/v1/account` (auth)

| Method | Path | Fungsi |
|--------|------|--------|
| GET | `/balance` | total modal bot user |
| GET | `/exchange-balance` | balance riil exchange (cache 60s) — `{ available, equity, unrealizedPL }` |
| GET/POST/DELETE | `/keys` | kelola API key (AES-256-GCM, di-mask saat GET) |
| GET/POST | `/strategy` | strategi aktif user |

---

## History — `/api/v1/history` (auth, **user-isolated**, IDOR-fixed)

| Method | Path | Fungsi |
|--------|------|--------|
| GET | `/sessions` · `/sessions/:id` | sesi (difilter userId) |
| GET | `/trades` · `/trades/stats/:sessionId` | trade + stats (gross/net/fee) |
| GET | `/equity/:sessionId` · `/equity-all` | equity curve |
| GET | `/db/logs/:sessionId` · `/db/info` | log & meta |
| POST | `/db/recalc-sessions` | recalc (scoped per user, rate-limit 60s) |
| GET | `/insights` | export indikator+PnL (json/csv) untuk ML |

**QA wajib cek (regresi IDOR):** user B akses `/equity/:id`, `/trades/stats/:id`,
`/sessions/:id`, `/insights`, `/equity-all` milik user A → **harus kosong/404**, bukan data A.

---

## Market — `/api/v1/market` (auth)

`GET /tickers · /balance · /positions · /candles · /candles/backtest`

## Backtest — `/api/v1/backtest` (auth)

`GET /metrics · /:symbol/summary · /:symbol/equity · /:symbol/trades`

## Legacy — `/api/v1/legacy` (auth)

`POST /bot/start · /bot/stop` · `GET /status · /config · /logs`

## Health (publik)

`GET /health` · `GET /api/v1/health` → `{ ok, timestamp, uptime }`

---

## Catatan PnL (penting untuk QA)

- `totalPnL` = **GROSS** (selisih harga). `totalFees` & `netPnL` dipisah.
- **Net = gross − fee − funding**. `final_capital` sesi pakai NET.
- Trade lama (sebelum fee-fix) `fee=0` → net=gross; hanya trade baru akurat.
