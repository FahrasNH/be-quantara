# Product Requirements Document (PRD)
## Quantara — Automated Crypto Trading Bot Platform

**Versi dokumen:** 2.2  
**Tanggal:** 13 Juli 2026  
**Status produk:** Active Development (Backend v2.1.0, Frontend v1.0.0 — Sprint 10/11/12 landed)  
**Proyek:** `be-bot-trading` + `fe-bot-trading`

> **SSOT (DOC-SSOT-01, 11 Jul 2026):** Tier→strategy entitlement follows
> [`be-bot-trading/src/domain/tierConfig.js`](be-bot-trading/src/domain/tierConfig.js).
> Canonical Gen2 strategy keys follow [`be-bot-trading/src/config/strategies.js`](be-bot-trading/src/config/strategies.js)
> (+ FE [`tierStrategyMap.js`](fe-bot-trading/src/utils/tierStrategyMap.js)).
> Historical Gen1→Gen2 map: [`be-bot-trading/ARCHITECTURE.md`](be-bot-trading/ARCHITECTURE.md) §1.
> If this PRD disagrees with those files, **code wins**.

---

## 1. Ringkasan Eksekutif

**Quantara** adalah platform trading bot otomatis untuk pasar crypto futures (non-custodial). Pengguna menghubungkan API key exchange mereka sendiri (Bitget, OKX, Binance), memilih strategi sesuai tier langganan, lalu bot mengeksekusi trade 24/7 dengan manajemen risiko bawaan.

Produk terdiri dari:

- **Backend** (`be-bot-trading`) — engine trading, REST API, WebSocket, database PostgreSQL, payment gateway, admin system
- **Frontend** (`fe-bot-trading`) — dashboard web React dengan landing page, auth, monitoring real-time, admin panel, checkout

Model bisnis berbasis **tier langganan** (FOUNDRY → FORGE → MINT → VAULT) yang membuka akses ke strategi dan kapasitas posisi berbeda. Billing terintegrasi dengan **Midtrans** (IDR).

---

## 2. Visi & Tujuan Produk

### 2.1 Visi

Menyediakan alat trading otomatis yang aman, transparan, dan dapat diandalkan bagi retail trader crypto — tanpa menguasai dana pengguna.

### 2.2 Tujuan Bisnis

| Tujuan | Metrik |
|--------|--------|
| Akuisisi pengguna | Registrasi + aktivasi bot pertama |
| Retensi | Langganan tier berbayar (upgrade path) |
| Kepercayaan | Zero insiden kehilangan dana via platform |
| Operasional | Uptime bot ≥ 99%, response API < 500ms |

### 2.3 Tujuan Produk

1. Otomatisasi eksekusi strategi dengan risk management ketat
2. Transparansi penuh: backtest, history, equity curve, statistik
3. Non-custodial: dana tetap di exchange pengguna
4. Skalabilitas multi-bot, multi-strategi per koin (tier tinggi)
5. Payment gateway terintegrasi (Midtrans IDR) untuk monetisasi

---

## 3. Masalah yang Diselesaikan

| Masalah | Solusi Quantara |
|---------|-----------------|
| Trader tidak bisa memantau pasar 24/7 | Bot berjalan otomatis dengan loop tick berkala |
| Emosi mengganggu keputusan trading | Eksekusi rule-based, tanpa intervensi emosional |
| Position sizing tidak konsisten | Risk per trade otomatis (% modal) |
| Strategi tidak teruji | Backtest engine dengan data historis |
| Risiko over-trading / over-leverage | Daily loss limit, cooldown, AccountCoordinator |
| Setup bot kompleks | Dashboard 5 menit: connect API → pilih strategi → start |
| Biaya langganan tidak transparan | Midtrans checkout dengan voucher + billing cycle |

---

## 4. Persona Pengguna

### Persona 1: Rafi — Pemula (FOUNDRY)

- Modal: Rp 3–5 juta (~$200–350)
- Butuh: strategi berbasis struktur pasar (SMC), dry-run dulu, edukasi risiko
- Tier: FOUNDRY (Rp149.000/bulan) — Adaptive Fusion (`AF_SMC` pool) saja

### Persona 2: Dina — Growth Trader (FORGE/MINT)

- Modal: Rp 2–15 juta
- Butuh: multi-strategi, trend following + mean reversion
- Tier: FORGE (Rp399.000) atau MINT (Rp899.000)

### Persona 3: Budi — Advanced (VAULT)

- Modal: Rp 100 juta+
- Butuh: semua strategi termasuk Breakout Trading, Grok AI confirm, support SLA 2 jam
- Tier: VAULT (Rp1.599.000/bulan)

### Persona 4: Operator/DevOps

- Butuh: monitoring, emergency stop, runbook, PM2 deployment
- Akses: health endpoint, logs, Telegram alert

### Persona 5: Admin Platform

- Butuh: manajemen user, tier, voucher, revenue, suspense user
- Akses: Admin Dashboard (`/admin/*`), SUPER_ADMIN role

---

## 5. Ruang Lingkup Produk

### 5.1 In Scope (Saat Ini)

- Registrasi & login (JWT + refresh token) + email verification + forgot password
- Koneksi API key Bitget/OKX/Binance (encrypted, no withdraw permission)
- 4 umbrella engines + **12 live race components** (race-to-confirm per umbrella)
- Start/stop/emergency-stop bot per simbol; **max 1 posisi per simbol** (semua tier)
- Dry-run dan live trading mode
- Dashboard real-time via WebSocket
- Backtest historis (synthetic + real OHLCV via HistoricalKlinesService)
- History trade + statistik + equity curve
- Tier entitlement & subscription dengan billing **Midtrans** (IDR, bulanan/tahunan)
- Voucher system (PERCENT/FIXED, per-user limits)
- Telegram notification + Telegram Bot interactive (poller)
- Risk gates per-bot dan per-akun
- Admin Dashboard (RBAC: USER/ADMIN/SUPER_ADMIN)
- Grok AI confirm gate per bot
- Pair classification (LIQUID/STABLE/VOLATILE) untuk SL/sizing override
- Deployment staging & production (VPS + PM2 + Nginx)

### 5.2 Out of Scope (Saat Ini)

- Mobile app native
- Social/copy trading
- AI optimizer dinamis (VAULT — Fase 3, feature flag tersedia)
- Exchange selain Bitget/OKX/Binance
- Custodial wallet / deposit langsung ke platform
- OKX live trading (hanya market data + key onboarding; client dihapus)
- Binance live trading (hanya market data + key onboarding)

---

## 6. Fitur Utama

### 6.1 Landing Page (`/`)

Halaman pemasaran publik dengan:

- Hero + mockup dashboard
- Trust bar (non-custodial, 24/7, backtest 5+ tahun)
- Feature cards (SMC, ATR SL, position sizing, backtest, Telegram, API key)
- Penjelasan strategi SMC + tier tiers
- **License Plans** — 4 tier dengan statistik simulasi
- Disclaimer risiko (hasil simulasi ≠ jaminan profit)
- Flow "Get Started" → login/register

### 6.2 Autentikasi & Akun

| Fitur | Detail |
|-------|--------|
| Register | Email, username, password (bcrypt) |
| Login | JWT access + refresh token (hash di DB) |
| Email Verification | Token via Nodemailer; banner di app; `emailVerifiedAt` di schema |
| Forgot Password | `PasswordResetToken` + email link; expired 1 jam |
| Protected routes | Frontend redirect ke `/login` jika belum auth |
| Audit log | Semua aksi penting tercatat (IP, user-agent) |
| Session management | Multi-session dengan expiry |

### 6.3 Dashboard (`/dashboard`)

- Ringkasan bot live (running/stopped, ROI, posisi terbuka)
- Statistik all-time (win rate, profit factor, drawdown)
- History trade terbaru
- Quick links ke tab lain
- Indikator offline jika backend down

### 6.4 Bot Control (`/bot`)

- Pilih simbol via **Command Palette (⌘K / Ctrl+K)** dari daftar pair perpetual exchange (`GET /api/v1/market/symbols`)
- Start / Stop / Emergency Stop bot per simbol
- **Trading mode global** (Simulation/Dry-run vs Live) diatur dari tab **Settings**
- Pilih strategi (tergantung tier) + multi-strategy per coin (tier MINT+)
- **TP Mode**: switch **Full / Partial** (`tpMode` di backend)
- **Grok Confirm Gate** toggle per bot (`grokConfirmEnabled`)
- Dashboard Live Bot dengan layout 3 kolom:
  - Add Bot panel (symbol, capital, TP Mode, Grok confirm toggle, confirm saat Live)
  - Account Risk panel (equity/margin budget + risk guardrails, concurrent positions cap)
  - Log sidebar (filter per simbol)
- Bot details drawer (ringkas): stats, posisi, config, stop, MiniEquitySparkline
- Real-time status & log stream via WebSocket + exchange badge di header/sidebar saat terhubung
- `maxConcurrentPositions` ditampilkan dan di-enforce per tier (4/8/12/16)
- `maxActiveBots` per tier (10/25/40/50)

### 6.5 History (`/history`)

- Daftar trade tertutup dengan filter (wins/losses)
- Statistik agregat per periode
- Equity curve chart
- Export data (XLSX via frontend)

### 6.6 Backtest (`/backtest`)

- Jalankan simulasi strategi pada data historis via **server-side real engine**
  (`RealStrategyBacktestService` — parity 1:1 dengan live umbrellas/racers)
- **Async job model:** `POST /api/v1/backtest/run-real` → `jobId` → poll status;
  eksekusi di **child_process worker** terisolasi (`workers/backtestJobWorker.js`) —
  mencegah OOM/502 pada API live
- **Shared candle cache:** L1 worker-local (`BacktestCandleCache.js`) + L2 DB `candle_cache`
  untuk reuse OHLCV antar job (Compare mode / tier packages)
- DataSourcePanel: synthetic / real OHLCV via `HistoricalKlinesService`
- **Advance mode:** multi-select komponen race per umbrella (`TIER_PACKAGE_COMPONENTS`);
  `COMPONENT_TO_ENGINE` collapse racers → satu run per umbrella engine
- **Compare Multiple Tiers:** jalankan paket tier penuh side-by-side (FOUNDRY…VAULT);
  union komponen entitlement; equal-weight capital split antar engine dalam paket
- Optional gates: **Grok Gate** (AI filter) · **RAG Gate (ML)** (`WinPredictor` + pgvector;
  `GET /backtest/rag-gate-status`; fail-open bila model/embeddings absent)
- Output: return, CAGR, max drawdown, win rate, profit factor, per-component frequency,
  CSV enrichment (`strategyReasonFormatters.js` — termasuk MD_SD/MD_SA/BS_ICT/BS_LS reasons)
- Archive dan history backtest tersimpan di FE
- Grok AI optimization: analisis backtest result via `/api/v1/ai/analyze`

### 6.7 Settings (`/settings`)

- Konfigurasi API key exchange (Bitget/OKX/Binance)
- Exchange switch (EXCHANGE_SWITCH_ENABLED = true)
- Trading mode (dry/live)
- Parameter strategi (read-only sesuai tier)
- Subscription tier & upgrade → redirect ke `/checkout`
- Disconnect exchange
- Pair tier classification display (LIQUID/STABLE/VOLATILE)
- Telegram chat ID setup

### 6.8 Checkout & Subscription (`/checkout`, `/subscription-success`)

- Pilih tier + billing cycle (MONTHLY/YEARLY)
- Input voucher code (validasi real-time)
- Ringkasan harga (IDR) — server-side computed
- Midtrans Snap payment redirect
- Webhook handler (`POST /api/v1/payments/webhook`) untuk update subscription
- `/subscription-success` — konfirmasi setelah pembayaran

### 6.9 Halaman Legal & Onboarding

| Route | Deskripsi |
|-------|-----------|
| `/terms` | Terms of Service |
| `/risk-disclosure` | Risk Disclaimer (wajib untuk akun live) |
| `/pricing` | Pricing page (stub — akan menampilkan tier cards) |
| `/verify-email` | Email verification callback |
| `/forgot-password` | Form reset password |

### 6.10 Admin Dashboard (`/admin/*`)

Akses: JWT + role ADMIN atau SUPER_ADMIN.

| Route | Halaman |
|-------|---------|
| `/admin` | Overview stats + quick actions |
| `/admin/users` | Semua user: filter, suspend, set tier |
| `/admin/users/flagged` | User yang di-flag (alert threshold) |
| `/admin/users/:id` | Detail user + bot + trade + exchange info |
| `/admin/subscriptions` | Status langganan semua user |
| `/admin/api-keys` | Fingerprint API key per user (masked) |
| `/admin/trades` | Semua trade di platform |
| `/admin/bots` | Semua bot di platform |
| `/admin/backtest` | Backtest history platform |
| `/admin/strategy-stats` | Statistik per strategi |
| `/admin/analytics` | Strategy Fit Matrix — **Coming Soon** (`AdminPageSoon`) |
| `/admin/parameters` | Walk-forward parameter tuning — **Coming Soon** (`AdminPageSoon`) |
| `/admin/rag-backtest` | RAG backtest dashboard (staging-oriented) |
| `/admin/revenue` | Revenue dashboard (payments) |
| `/admin/vouchers` | CRUD voucher (buat, edit, nonaktifkan) |
| `/admin/alerts` | Alert threshold & flags |
| `/admin/settings` | Platform settings (maintenance mode) |
| `/admin/management` | Admin management (SUPER_ADMIN only) |

---

## 7. Model Langganan (Tier)

Hierarki: **FOUNDRY < FORGE < MINT < VAULT**

> **SSOT:** `tierConfig.js`. Tabel di bawah = mirror kode (13 Jul 2026). Gen2 engine
> keys shown; entitlement DB/API may still send legacy aliases (`ADAPTIVE_FUSION` →
> `AF_SMC`, `TREND_FOLLOWING` → `TS_TF`, `MEAN_REVERSION` → `MD_MR`,
> `BREAKOUT_RETEST` → `BS_BR`). **`maxPositionsPerSymbol = 1` untuk semua tier**
> (bukan 2/3/4 — itu dokumen lama yang salah).

### Harga & Kapasitas

| Tier | Harga/Bulan (IDR) | Harga/Tahun (IDR) | USD equiv | Modal Target (`capitalRange`) | Package engines | Race components (kumulatif) | Max Posisi (per simbol) | Max Concurrent | Max Active Bots |
|------|------------------|-------------------|-----------|-------------------------------|-----------------|------------------------------|------------------------|---------------|----------------|
| **FOUNDRY** | Rp 149.000 | Rp 1.490.000 | ~$9 | Rp 1–2M | `AF_SMC` | AF pool (3) | **1** | 4 | 10 |
| **FORGE** | Rp 399.000 | Rp 3.990.000 | ~$24 | Rp 2–5M | + `TS_TF` | AF + TS pools (6) | **1** | 8 | 25 |
| **MINT** | Rp 899.000 | Rp 8.990.000 | ~$54 | Rp 10–15M | + `MD_MR` | + MD pool (9 total) | **1** | 12 | 40 |
| **VAULT** | Rp 1.599.000 | Rp 15.990.000 | ~$99 | Rp 30M+ | + `BS_BR` | All pools (12 total) | **1** | 16 | 50 |

> Harga tahunan = harga bulanan × 10 (bayar 10 bulan, dapat 12 bulan).

### Fitur Khusus per Tier

| Fitur | FOUNDRY | FORGE | MINT | VAULT |
|-------|---------|-------|------|-------|
| Auto-selector | ✗ | ✗ | ✓ | ✓ |
| AI Optimizer (Grok) | ✗ | ✗ | ✗ | ✓ (flag) |
| Support SLA | Self-service | 48h | 24h | 2h |
| Billing cycle | Bulanan/Tahunan | Bulanan/Tahunan | Bulanan/Tahunan | Bulanan/Tahunan |

**Entitlement rules:**

- Setiap tier hanya bisa menggunakan strategi yang terdaftar di `tierConfig.js`
- Upgrade path: FOUNDRY → FORGE → MINT → VAULT
- `VAULT_AI_OPTIMIZER_ENABLED` env flag untuk AI optimizer (Fase 3)
- Billing via Midtrans (IDR) — webhook otomatis aktifkan subscription

---

## 8. Strategi Trading

### Arsitektur Umbrella (Gen2)

Setiap tier membuka **pool komponen kumulatif** di bawah umbrella. Key primer Gen2
(`AF_SMC`, `TS_TF`, `MD_MR`, `BS_BR`) adalah runnable engine keys di registry/backtest.
Legacy aliases tetap untuk migrasi DB/bots lama — lihat `ARCHITECTURE.md` §1.

**Race-to-confirm (semua umbrella, Sprint 10–12):** racers aktif evaluasi paralel;
pemenang = confidence tertinggi; atribusi trade = **winning component key** saja.

| Key Primer (Gen2) | Legacy alias | Tier min | Umbrella | Live race pool |
|-------------------|--------------|----------|----------|----------------|
| `AF_SMC` | `ADAPTIVE_FUSION`, `SMC`, `SAC` | FOUNDRY+ | Adaptive Fusion | `AF_SMC`, `AF_WYCKOFF`, `AF_VSA` |
| `TS_TF` | `TREND_FOLLOWING`, `TM`, `TF` | FORGE+ | Trend Surge | `TS_TF`, `TS_MS`, `TS_VP` |
| `MD_MR` | `MEAN_REVERSION`, `MR` | MINT+ | Mean Drift | `MD_MR`, `MD_SD`, `MD_SA` |
| `BS_BR` | `BREAKOUT_RETEST`, `BR` | VAULT | Breakout Storm | `BS_BR`, `BS_ICT`, `BS_LS` |
| `GROK_AI_TRADING` | — | VAULT (bonus) | — | experimental LLM entry (bukan race-pool) |

### Risk overlays (bukan race participants)

| Overlay | Scope | Catatan |
|---------|-------|---------|
| ADX Trend Strength Filter | `MD_MR` racer only | Regime gate — **tidak** muncul di catalog / Advance picker |
| Grok Confirm Gate | Semua engine canonical | Toggle per bot; prefer over `GROK_AI_TRADING` |
| OI / Funding | `BS_LS` optional | Fail-open bila data exchange absent |

---

### 8.1 Adaptive Fusion (AF_SMC pool) — FOUNDRY+

**Umbrella:** `AdaptiveFusionUmbrella` — tier access bag; default **race-to-confirm**
(Sprint 12). Winner = highest confidence; tie-break `AF_SMC` → `AF_WYCKOFF` → `AF_VSA`.

| Racer | Key | Role |
|-------|-----|------|
| Smart Money Concepts | `AF_SMC` | Sweep → CHoCH/MSS → FVG/OB entry |
| Wyckoff | `AF_WYCKOFF` | Spring / upthrust |
| VSA | `AF_VSA` | Volume Spread Analysis |

**Trade types AF:** **Scalping / Swing** only (Intraday removed AF-SCALP-19).

**RR per type (SMC legs):**

| Type | Win Rate Target | RR | SL | TP |
|------|-----------------|----|----|-----|
| Scalping | 35–40% | 1:4.5 aspirational / **2.0 live** | 1.0×ATR aspirational / **2.2× live** | 4.5×ATR aspirational / **4.4× live** |
| Swing | 45–50% | 1:4.0 aspirational / **2.5 live** | 1.2×ATR aspirational / **1.8× live** | 4.0×ATR aspirational / **4.5× live** |

Live/backtest SSOT is `typeOverrides` in FE `backtestStrategies.js` + BE `legacyStrategies.js`
(Sprint 13). PRD multipliers remain aspirational until a re-validation run flips them back.

**Komponen SMC (racer AF_SMC):**
- Liquidity sweep detection (BSL/SSL)
- Break of Structure (BOS) + Change of Character (CHoCH/MSS)
- Order Block (OB) mitigation zone
- Fair Value Gap (FVG) / Imbalance
- Displacement & Premium/Discount zone
- HTF directional bias filter (EMA9/21/50 + ADX)

**Status:** Production-ready (race pool FOUNDRY+)

---

### 8.2 Trend Surge (TS_TF pool) — FORGE+

**Umbrella:** `TrendSurgeUmbrella` — race-to-confirm among:

| Racer | Key | Role |
|-------|-----|------|
| Trend Following | `TS_TF` | Multi-TF pullback (4h → 15m → 5m) |
| Dow Theory | `TS_MS` | HH/HL structure entries |
| Auction Market Theory | `TS_VP` | VWAP reclaim / VA edge |

- ADX filter pada racer TF; RR ~1:1.92, risk ~1.2%, leverage hingga 2×
- Exit: break-even 20% TP, trailing 0.8×ATR (TF path)

**Status:** Production-ready (FORGE+)

---

### 8.3 Mean Drift (MD_MR pool) — MINT+

**Umbrella:** `MeanDriftUmbrella` v4 — race-to-confirm among:

| Racer | Key | Catalog label | Role |
|-------|-----|---------------|------|
| Mean Reversion | `MD_MR` | Mean Reversion | BB + RSI + VWAP reversion; **ADX overlay internal** |
| Supply and Demand | `MD_SD` | Supply and Demand | Zone OB retest entries |
| Statistical Arbitrage | `MD_SA` | Statistical Arbitrage | Z-score / rolling-mean reversion |

- Tie-break: `MD_MR` → `MD_SD` → `MD_SA`
- ADX regime gate lives **inside MD_MR only** — not a selectable racer (Sprint 10 naming lock)
- Rollback: `mdCombinationMode: "pipeline"` → MD_MR-only layered mode
- Ultra-konservatif pada MR path: risk ~0.8–1%, leverage 1×, max ~3 trade/hari

**Status:** Production-ready (Sprint 10 race pool)

---

### 8.4 Breakout Storm (BS_BR pool) — VAULT

**Umbrella:** `BreakoutStormUmbrella` v3 — race-to-confirm among:

| Racer | Key | Catalog label | Role |
|-------|-----|---------------|------|
| Breakout Retest | `BS_BR` | Breakout Retest | BB squeeze → breakout → retest (`BreakoutTradingStrategy` v2.4) |
| ICT-style | `BS_ICT` | ICT-style trading | Kill zones, liquidity raids |
| Liquidation/Squeeze | `BS_LS` | Liquidation/Squeeze Trading | Liquidation wick + squeeze; optional OI/funding |

- Tie-break: `BS_BR` → `BS_ICT` → `BS_LS`
- Rollback: `bsCombinationMode: "single"` → BS_BR-only

**BS_BR detail (when it wins the race):**

**Filosofi:** "Find tight consolidations (high squeeze), wait for a breakout with volume, then enter on the RETEST of the broken level."

**3-Phase Sequence:**
1. **Consolidation Detection** — Bollinger Band Width squeeze (width ≤ 0.9× avg 10-bar)
2. **Breakout Confirmation** — Close breakout dari 20-bar high/low + volume > 1.3× SMA20
3. **Retest Entry** — Entry saat price retest broken level dan rejected

| Aspek | Detail |
|-------|--------|
| Holding | 4 jam – 3 hari (swing) |
| Frekuensi | 0.5–2 trade/minggu (sangat selektif) |
| Win Rate Target | **HOLD** — unverified (realized 5-window ~37% WR / PF 0.72; do not publish 50–65% until re-test gate ≥4/5) |
| RR | 1:1.9 |
| Modal Minimum | Rp 30M+ (tier VAULT `capitalRange`) |
| SL | 1.7×ATR (wide) |

**Status:** ⛔ HALTED Sprint 14 (BS_BR removed from VAULT live race; ICT/LS remain). Re-enable only after 5-window re-test gate.

---

### 8.5 Grok AI Trading (GROK_AI_TRADING) — VAULT (AI Mode)

**Engine:** `GrokAiTradingStrategy v1.0.0` — delegasi keputusan entry/TP/SL ke xAI Grok

- Multi-TF market data dikirim ke Grok API (`1m, 5m, 15m, 30m, 1h, 4h`)
- Minimum confidence: `minConfidenceEntry: 8` (skala 1-10)
- Risk: 1% per trade, leverage 2×, max 20 trade/hari
- Cooldown 30 menit setelah loss
- Interval check: 600 detik (10 menit)

**Grok Confirm Gate (Mode B):** Semua strategi Gen2 (`AF_SMC` / `TS_TF` / `MD_MR` / `BS_BR`) bisa diaktifkan Grok confirmation per bot:
- `grokConfirmEnabled`: toggle di Add Bot panel
- `grokConfirmTpAdjust`: auto-adjust TP berdasarkan Grok target
- `grokConfirmTpBandPct`: bandwidth TP penyesuaian (default 15%)
- `grokConfirmTpRejectAction`: `"skip"` atau `"use_original"` jika Grok reject

**Status:** Available; controlled via env flag + per-bot toggle

> ⚠️ `GROK_AI_TRADING` adalah strategi otonom penuh. `GROK_CONFIRM_GATE` adalah lapisan konfirmasi untuk strategi lain.

---

## 9. Manajemen Risiko

### 9.1 Per-Bot Risk Gates

| Gate | AF_SMC (Scalp) | AF_SMC (Swing) | TS_TF | MD_MR | BS_BR |
|------|----------------|----------------|-------|-------|-------|
| Max risk/trade | 2% | 2% | 2% | 1% | 3% |
| Daily loss limit | 6% | 6% | 6% | 5% | 8% |
| Max trade/hari | Unlimited | ~0.5/hari | 6 | 3 | 2/minggu |
| Cooldown setelah loss | 10 min | 60 min | 10 min | 15 min | 5 min |

### 9.2 Account-Level (AccountCoordinator)

- Max utilization: 80% equity
- Max daily loss akun: 6% (realized + floating)
- Max 1 posisi per simbol per akun (race-to-confirm lintas strategi)
- Signal conflict resolver (SignalConflictResolver) antar strategi
- **Cap account-wide** (per tier): 4/8/12/16 concurrent positions
- Max active bots per tier: 10/25/40/50

### 9.3 Pair Classification (PairClassifier)

Setiap pair diklasifikasikan sebagai `LIQUID`, `STABLE`, atau `VOLATILE` untuk override SL/TP dan sizing:

- `LIQUID`: pair utama (BTC, ETH, SOL) — SL normal
- `STABLE`: pair stabil — SL lebih ketat
- `VOLATILE`: pair minor/micro — SL lebih lebar, sizing lebih kecil

### 9.4 Emergency Procedures

- Emergency stop: tutup posisi paksa (3× retry)
- Naked position (SL gagal): emergency close 3× retry → intervensi manual → Telegram alert
- API key bocor: revoke + disconnect exchange
- Rollback deployment via git + PM2
- PM2 restart budget monitoring (OPS-003): alert Telegram saat restart budget hampir habis

---

## 10. Arsitektur Teknis

```mermaid
flowchart TB
    subgraph Frontend["fe-bot-trading (React + Vite)"]
        LP[Landing Page]
        Auth[Auth Context]
        Dash[Dashboard]
        Bot[Bot Control]
        Admin[Admin Dashboard]
        Checkout[Checkout / Subscription]
        WS_Client[WebSocket Client]
    end

    subgraph Backend["be-bot-trading (Node.js + Express)"]
        API[REST API v1]
        WSS[WebSocket Server]
        AuthSvc[AuthService + Email Verification]
        Entitlement[Entitlement Service]
        BotEngine[BotEngine]
        MultiCoord[MultiStrategyCoordinator]
        AcctCoord[AccountCoordinator]
        Umbrella[4 Umbrella Strategies + Grok AI]
        Exchange[Bitget / Binance Client]
        PaySvc[PaymentService + Midtrans]
        AdminAPI[Admin Routes (RBAC)]
        GrokSvc[GrokTradingService / GrokConfirmService]
    end

    subgraph Infra["Infrastructure"]
        PG[(PostgreSQL + Prisma)]
        PM2[PM2 Process Manager]
        Nginx[Nginx Reverse Proxy]
        TG[Telegram Notifier + Bot Poller]
        Midtrans[Midtrans Payment Gateway]
        xAI[xAI Grok API]
    end

    LP --> Auth
    Auth --> API
    Dash --> API
    Bot --> API
    Admin --> API
    Checkout --> API
    WS_Client --> WSS
    API --> AuthSvc
    API --> Entitlement
    API --> BotEngine
    API --> PaySvc
    API --> AdminAPI
    BotEngine --> Umbrella
    BotEngine --> MultiCoord
    BotEngine --> AcctCoord
    BotEngine --> Exchange
    BotEngine --> PG
    BotEngine --> GrokSvc
    WSS --> BotEngine
    BotEngine --> TG
    GrokSvc --> xAI
    PaySvc --> Midtrans
    PaySvc --> PG
    PM2 --> Backend
    Nginx --> Frontend
    Nginx --> Backend
```

### 10.1 Tech Stack

| Layer | Teknologi |
|-------|-----------|
| Frontend | React 18, Vite 5, React Router 6, Recharts, Iconsax, cmdk |
| Backend | Node.js, Express 4, WebSocket (ws), CCXT |
| Database | PostgreSQL + Prisma ORM v6 |
| Auth | JWT + bcryptjs + express-rate-limit + nodemailer |
| Payment | Midtrans Client (`midtrans-client`) |
| AI | xAI Grok API (via axios) |
| Security | Helmet, CORS, compression, confirm token, bot op lock, RBAC adminGuard |
| Deploy | PM2, Nginx, shell scripts staging/production, ecosystem.config.js |
| Notifikasi | Telegram Bot API (notifier + poller) |

### 10.2 Database Schema (Model Utama)

| Model | Fungsi |
|-------|--------|
| `User` | Account user + role (USER/ADMIN/SUPER_ADMIN) + suspend flag |
| `UserExchange` | Multi-exchange per user (soft-delete, unique per userId+exchange) |
| `UserStrategy` | Konfigurasi strategi aktif + tier per user |
| `Bot` | Bot per user/simbol: config, strategi, tpMode, Grok flags |
| `Trade` | Record setiap trade (entry, exit, PnL, strategi, exit reason) |
| `BotLog` | Log real-time per bot |
| `Session` | Refresh token session (hash only) |
| `PasswordResetToken` | Token untuk forgot password (expires 1 jam) |
| `SubscriptionTier` | Katalog tier dari DB (mirror tierConfig.js) |
| `Subscription` | Record langganan aktif/expired per user |
| `Payment` | Record pembayaran Midtrans (orderId, status, amount IDR) |
| `Voucher` | Voucher diskon (PERCENT/FIXED, per-user limit, valid period) |
| `VoucherUsage` | Tracking pemakaian voucher per user/payment |
| `PaymentAuditLog` | Audit trail payment lifecycle (immutable) |
| `AuditLog` | Audit log aksi admin |

### 10.3 API Endpoints (Ringkas)

| Prefix | Endpoints | Auth |
|--------|-----------|------|
| `/health` | GET | Public |
| `/api/v1/auth` | register, login, logout, refresh, verify-email, forgot-password, reset-password | Mixed |
| `/api/v1/bots` | start, stop, emergency-stop, list, status, strategies/available | JWT |
| `/api/v1/history` | trades, stats, equity | JWT |
| `/api/v1/market` | symbols, tickers, candles, candles/backtest | JWT |
| `/api/v1/backtest` | run, list, get, delete | JWT |
| `/api/v1/ai` | analyze, status, sync-knowledge, export-training | JWT |
| `/api/v1/account` | keys, exchange-balance, disconnect | JWT |
| `/api/v1/subscription` | get, upgrade | JWT |
| `/api/v1/payments` | initiate, status, history, config | JWT |
| `/api/v1/payments/webhook` | POST (Midtrans notification) | Signature |
| `/api/v1/admin/*` | users, trades, bots, revenue, stats, stop-all | JWT + adminGuard |
| `/api/v1/admin/vouchers` | CRUD voucher | JWT + adminGuard |
| WebSocket | log, status, trade, error, ping/pong | JWT (handshake) |

### 10.4 Strategi Registry (Gen2)

```
StrategyRegistry
├── AF_SMC        → AdaptiveFusionUmbrella     → race: AF_SMC / AF_WYCKOFF / AF_VSA
├── AF_WYCKOFF    → WyckoffStrategy (racer)
├── AF_VSA        → VsaStrategy (racer)
├── TS_TF         → TrendSurgeUmbrella         → race: TS_TF / TS_MS / TS_VP
├── TS_MS         → MarketStructureStrategy (racer)
├── TS_VP         → VolumeProfileStrategy (racer)
├── MD_MR         → MeanDriftUmbrella          → race: MD_MR / MD_SD / MD_SA
├── MD_SD         → SupplyDemandStrategy (racer)
├── MD_SA         → StatisticalArbitrageStrategy (racer)
├── BS_BR         → BreakoutStormUmbrella      → race: BS_BR / BS_ICT / BS_LS
├── BS_ICT        → IctStyleStrategy (racer)
├── BS_LS         → LiquidationSqueezeStrategy (racer)
├── GROK_AI_TRADING                          → GrokAiTradingStrategy (experimental)
│
│ Overlays (NOT in registry race pools):
│   ADX regime gate → inside MD_MR only
│   GrokConfirm     → per-bot overlay on any canonical engine
│
│ Legacy aliases (normalize → Gen2):
├── ADAPTIVE_FUSION / SMART_MONEY_CONCEPTS / SAC → AF_SMC
├── TREND_FOLLOWING / TF / TM                    → TS_TF
├── MEAN_REVERSION / MR                          → MD_MR
└── BREAKOUT_RETEST / BR                         → BS_BR
```

### 10.5 Supported Exchanges

| Exchange | Live Trading | Symbols Listing | Key Onboarding | Notes |
|----------|-------------|-----------------|----------------|-------|
| **Bitget** | ✅ Full (`BitgetClient`) | ✅ | Balance-reachability check | Primary exchange |
| **OKX** | ⚠️ Client removed | ✅ (CCXT public) | Trusted as-is | Market data only |
| **Binance** | ⚠️ Market-data only | ✅ | Permission validation (futures-only, reject withdrawal) | CCXT `BinanceClient` |

Exchange switch enabled (`EXCHANGE_SWITCH_ENABLED = true`).

### 10.6 Deployment & environments

| Environment | Git branch | BE PM2 app | Port | Deploy |
|-------------|------------|------------|------|--------|
| Staging | `staging` | `be-quantara-staging` | 3001 | `scripts/deploy-staging-vps.sh` |
| Production | `main` | `be-quantara-prod` | 3000 | `scripts/deploy-production-vps.sh` |

VPS + Nginx + PM2 (`ecosystem.config.js`). Doc updates land on `staging` first; production
tracks `main` after validation.

### 10.7 RAG / ML pipeline

| Component | Status |
|-----------|--------|
| `WinPredictor` | Gradient boosting classifier; model at `data/models/win-predictor.json` |
| Backtest RAG gate | ✅ User toggle; `GET /backtest/rag-gate-status`; fail-open |
| Live shadow | `RAG_MODE=shadow` on `main` |
| Admin Analytics | Coming Soon |
| Admin Parameters | Coming Soon |
| Admin RAG dashboard | `/admin/rag-backtest` |

---

## 11. Design System

Quantara memiliki **dua surface design** yang hidup berdampingan di repo.

| Surface | File sumber | Cakupan | Status |
|---------|-------------|---------|--------|
| **App DS** (Light Purple) | `fe-bot-trading/src/constants/theme.js` | Dashboard, auth, semua tab aplikasi, admin | ✅ Production (React) |
| **Marketing DS** (Dark Forge) | `landing.html` | Landing page marketing statis | ✅ Prototype / alternate |

> **Catatan:** `LandingPage.jsx` memakai App DS (light purple). `landing.html` adalah eksplorasi dark/gold terpisah.

### 11.1 App Design System — Light Purple

**Filosofi visual:** Clean, light, fintech-friendly. Dominan putih/lavender dengan aksen ungu sebagai primary action color.

#### Token Warna

Source of truth: [`fe-bot-trading/src/constants/theme.js`](fe-bot-trading/src/constants/theme.js)

| Token | Hex | Penggunaan |
|-------|-----|------------|
| `bg` | `#f2f2fa` | Background halaman |
| `bg1` | `#ffffff` | Card / panel |
| `bg2` | `#f5f3ff` | Inner card, input field |
| `bg3` | `#ede9ff` | Accent background, selected state |
| `border` | `#e4e1f5` | Border card, divider, table |
| `gold` / `purple` | `#6c5ce7` | Primary accent, CTA, tab active |
| `blue` | `#8b7cf8` | Gradient end, secondary accent |
| `goldDim` | `#a89af9` | Muted accent |
| `text` | `#1a1a2e` | Heading, body utama |
| `textMid` | `#6b6b8a` | Label, secondary text |
| `textDim` | `#9999bb` | Hint, placeholder, axis chart |
| `green` | `#00c896` | Profit, connected, success |
| `red` | `#ff5b79` | Loss, error, disconnected |
| `amber` | `#ffb830` | Warning |

#### Tipografi

| Role | Font | Weight | Size (px) |
|------|------|--------|-----------|
| UI / body | **Outfit** | 400–800 | 13–16 (base 14) |
| Angka / harga / KPI | **DM Mono** | 400, 500 | 10–22 |
| Metric | DM Mono | 700 | 22 |
| CTA | Outfit | 600 | 13 |
| Badge | Outfit | 600 | 11 |

Source of truth: [`fe-bot-trading/src/constants/typography.js`](fe-bot-trading/src/constants/typography.js)

#### Komponen UI

| Komponen | Path | Spesifikasi |
|----------|------|-------------|
| **StatCard** | `components/ui/StatCard.jsx` | bg `bg2`, border, radius 10px, label uppercase, value DM Mono 22px |
| **Badge** | `components/ui/Badge.jsx` | Pill inline, bg `{color}20`, border `{color}40`, radius 4px |
| **Input** | `components/ui/Input.jsx` | Label uppercase 11px, field bg `bg2`, radius 8px |
| **Modal** | `components/ui/Modal.jsx` | Portal, maxWidth 440px, bg `bg1`, radius 14px, Escape to close |
| **ConfirmDialog** | `components/ui/ConfirmDialog.jsx` | Modal variant danger/primary action |
| **Header** | `components/layout/Header.jsx` | Sticky, glassmorphism `rgba(255,255,255,0.85)` + blur 20px |
| **EquityChart** | `components/charts/EquityChart.jsx` | Recharts area, gradient purple |
| **Notification** | `components/layout/NotificationContainer.jsx` | Toast top-right |
| **EmailVerificationBanner** | `components/layout/EmailVerificationBanner.jsx` | Banner di app jika email belum verified |
| **MiniEquitySparkline** | `components/tabs/bot/MiniEquitySparkline.jsx` | Sparkline equity di bot card |
| **TpModeToggle** | `components/tabs/bot/TpModeToggle.jsx` | Toggle Full/Partial TP |

#### Pola Interaksi

| Pola | Implementasi |
|------|--------------|
| Primary button | `linear-gradient(135deg, #6c5ce7, #8b7cf8)`, white text |
| Ghost button | Transparent, border `#e4e1f5`, hover → purple |
| Tab navigation | Iconsax icon + label; active = purple underline + Bulk variant |
| Live indicator | Dot `#00c896` + `pulse 2s infinite` |
| Page enter | `.fade-in` — opacity + translateY 8px, 0.4s ease |
| Mobile | `useIsMobile()`; sticky header + horizontal scroll |
| Icon library | **Iconsax React** — Linear (default), Bulk (active), Bold (emphasis) |
| Lazy loading | BacktestTab, HistoryTab, SettingsTab di-lazy-load (`React.lazy`) |
| Error Boundary | `ErrorBoundary` class component di `App.jsx` |

### 11.2 Marketing Design System — Dark Forge

Source of truth: [`landing.html`](landing.html). Filosofi: Industrial, premium, dark backdrop + gold accent.

> Tetap dipertahankan sebagai eksplorasi visual terpisah. Belum terintegrasi ke React app.

### 11.3 Roadmap Design System

> **Decision (FE-DEBT-02, 11 Jul 2026): KEEP SEPARATE.**
> App DS (Light Purple) remains the production React product language.
> Marketing Dark Forge (`landing.html` / industrial dark+gold) stays a deliberate
> marketing exploration — different audience and tone. Unification is **not**
> required technical debt; it is an optional future brand project if product
> wants one visual system. Do not treat dual DS as an open bug.

| Item | Prioritas | Status |
|------|-----------|--------|
| Unifikasi landing React ↔ `landing.html` (Forge DS) | Medium | **Won't do (keep separate)** — see decision above |
| Extract shared tokens ke `@quantara/tokens` package | Low | Belum (optional) |
| Dark mode untuk app dashboard | Low | Belum |
| Storybook / component catalog | Low | Belum |

---

## 12. User Flows

### 12.1 Onboarding Baru

```
Landing → Register → Verify Email → Login
→ Settings (connect API key) → Backtest (opsional)
→ Bot (dry-run start) → Monitor Dashboard
→ Checkout (upgrade tier) → Live trading
```

### 12.2 Checkout & Subscription

```
Settings / Pricing → Pilih tier + billing cycle
→ Input voucher (opsional) → Server hitung harga IDR
→ Redirect Midtrans Snap → Payment
→ Midtrans webhook → Subscription aktif
→ /subscription-success → Dashboard
```

### 12.3 Start Bot

```
Pilih simbol (⌘K Command Palette) → Pilih strategi (cek entitlement)
→ Set capital → Toggle TP Mode (Full/Partial)
→ Enable Grok Confirm (opsional) → Confirm token (live)
→ POST /bots/:symbol/start → WebSocket stream aktif
→ BotEngine loop tick → PairClassifier override → trade
```

### 12.4 Emergency

```
Deteksi anomaly → Emergency Stop API / PM2 stop
→ Tutup posisi manual di exchange (jika perlu)
→ Investigasi log → Rollback jika bug
→ PM2 budget alert → Telegram notifikasi
```

### 12.5 Admin Action

```
Login (ADMIN/SUPER_ADMIN role) → /admin
→ Review flagged users / suspense / update tier
→ Manage vouchers → Monitor revenue
→ Emergency stop all bots (Stop-All + Telegram broadcast)
```

---

## 13. Persyaratan Non-Fungsional

| Kategori | Requirement |
|----------|-------------|
| **Keamanan** | API key encrypted, no withdraw permission, IP whitelist disarankan, JWT expiry, rate limit auth, RBAC admin |
| **Availability** | PM2 auto-restart (max_restarts + budget alert), health check endpoint |
| **Performance** | WebSocket real-time (< 1s latency log), API response < 500ms |
| **Skalabilitas** | Multi-bot per user (max sesuai tier), multi-user via userId isolation |
| **Data integrity** | Trade attribution, audit log, idempotent DB migration, PaymentAuditLog immutable |
| **Compliance** | Disclaimer risiko di UI, bukan layanan investasi, Midtrans SLA |
| **Observability** | Structured logs, Telegram alert, PM2 monitoring, MEM_DEBUG mode |
| **Email** | Nodemailer untuk verifikasi & reset password |

---

## 14. Risiko & Mitigasi

| Risiko | Impact | Mitigasi |
|--------|--------|----------|
| Backtest sintetis ≠ performa live | Tinggi | Validasi OHLCV nyata via HistoricalKlinesService sebelum go-live |
| SL gagal terpasang (naked position) | Kritis | 3× retry + emergency close + prosedur manual + Telegram alert |
| API key bocor | Kritis | No withdraw, IP whitelist, revoke cepat, apiKeyHash unique constraint |
| Over-trading lintas bot | Tinggi | AccountCoordinator + daily loss gate + maxConcurrentPositions cap |
| Midtrans webhook forged | Tinggi | SHA512 signature verification sebelum proses notifikasi |
| PM2 crash loop | Sedang | Restart budget monitoring (OPS-003) + Telegram alert |
| SMC Intraday 100% overlap | Sedang | Intraday leg dihide dari UI sampai TF berbeda divalidasi |
| Grok AI hallucination | Sedang | Confidence threshold (≥8/10), fallback skip/use_original |
| Exchange downtime | Sedang | Graceful degradation, skip entry, stale cache fallback, alert |

---

## 15. Metrik Keberhasilan (KPI)

### Produk

- **Activation rate**: % user yang start bot pertama dalam 7 hari
- **Dry-to-live conversion**: % user yang switch ke live mode
- **Tier upgrade rate**: FOUNDRY → tier lebih tinggi
- **Paid conversion rate**: % user yang melakukan pembayaran Midtrans
- **Bot uptime**: % waktu bot running tanpa error kritis

### Trading (per user/session)

- Win rate, profit factor, max drawdown
- Daily loss vs limit (harus < 100%)
- Zero naked position incidents
- SMC Scalping target: PF ≥ 1.2 net-of-fee (AF-SCALP-24 result: +64.6, PF 1.29)

### Teknis

- API error rate < 1%
- WebSocket disconnect rate
- Mean time to recovery (MTTR) setelah incident
- Midtrans webhook success rate
- Payment audit completeness

---

## 16. Roadmap

### Fase 1 — ✅ Selesai

- Core bot engine + 4 umbrella engines + 12 race components
- Race-to-confirm architecture (Sprint 12 AF/TS; Sprint 10 MD; Sprint 11 BS)
- SMC Strategy v3.0 (event-driven, Scalping + Swing)
- Dashboard web + auth + email verification + forgot password
- Tier entitlement; **single-position-per-symbol** (all tiers)
- Risk gates + emergency procedures + AccountCoordinator
- Admin Dashboard (RBAC); emergency stop-all implemented
- Staging (`staging`) & production (`main`) deployment (VPS + PM2 + Nginx)
- Midtrans payment integration (IDR, Monthly/Yearly)
- Voucher system; Exchange switch (Bitget/OKX/Binance)
- Pair classification (LIQUID/STABLE/VOLATILE)
- Grok AI confirm gate (per-bot toggle)
- Telegram Bot interactive (poller)
- Backtest worker isolation + shared candle cache (BUG-CRITICAL 502)
- RAG gate on backtest + WinPredictor on `main`

### Fase 2 — 🔄 In Progress

- Validasi SMC Scalping backtest dengan OHLCV Bitget nyata (HistoricalKlinesService)
- SMC Intraday leg revival pada TF berbeda (1h entry — currently failed validation)
- `GROK_AI_TRADING` full rollout (feature flag, testing live)
- Admin Analytics & Parameters pages (Coming Soon placeholders live)
- Rate limiting global API
- Mobile-responsive PWA improvements
- Pricing page (`/pricing`) — saat ini stub

### Fase 3 — 📋 Planned

- VAULT AI Optimizer dinamis (dynamic capital allocation per strategi)
- Multi-exchange per user (UserExchange model sudah ada, trading Binance/OKX planned)
- Advanced analytics & report generator
- Auto strategy selector berbasis regime pasar (autoSelector sudah di tier MINT/VAULT)
- Social/copy trading

---

## 17. Dependensi & Integrasi Eksternal

| Integrasi | Fungsi | Status |
|-----------|--------|--------|
| Bitget API | Futures USDT-M trading + market data | ✅ Live |
| OKX API | Market data + key onboarding (no live trading) | ✅ Partial |
| Binance API (CCXT) | Market data + key onboarding + symbol listing | ✅ Live |
| PostgreSQL | Persistent storage | ✅ Live |
| Midtrans | Subscription billing (IDR, Snap redirect) | ✅ Live |
| Telegram Bot API | Trade notifications + interactive poller | ✅ Optional |
| xAI Grok API | AI trading decisions + AI backtest optimization | ✅ Feature-flagged |
| WinPredictor / pgvector RAG | Backtest RAG gate + live shadow mode | ✅ On `main`; admin analytics deferred |
| Nodemailer | Email verification + password reset | ✅ Live |

---

## 18. Glosarium

| Istilah | Definisi |
|---------|----------|
| **Dry-run** | Simulasi trading tanpa eksekusi real di exchange |
| **Non-custodial** | Dana pengguna tetap di exchange, platform tidak menyimpan aset |
| **Entitlement** | Hak akses fitur/strategi berdasarkan tier langganan |
| **Risk gate** | Pembatas otomatis yang menghentikan entry jika limit tercapai |
| **Multi-strategy per coin** | Beberapa umbrella/engine dievaluasi paralel; **race-to-confirm** — max 1 posisi terbuka per simbol |
| **Race-to-confirm** | Racers dalam umbrella bersaing; pemenang confidence tertinggi yang entry; label trade = winning component |
| **Risk overlay** | Modifier risiko (ADX, Grok Confirm) — bukan strategi/racer yang bisa dipilih di catalog |
| **Confirm token** | Token sekali pakai untuk aksi kritis (start live, emergency stop) |
| **Umbrella strategy** | Wrapper yang membungkus satu atau lebih sub-strategi (UmbrellaStrategy pattern v2.0) |
| **SMC** | Smart Money Concepts — metodologi trading institutional (BOS, CHoCH, OB, FVG) |
| **CHoCH** | Change of Character — perubahan arah struktur pasar |
| **OB** | Order Block — zona harga di mana institusi mengambil/menempatkan order besar |
| **FVG** | Fair Value Gap / Imbalance — celah harga yang belum terisi ulang |
| **Grok Confirm Gate** | Lapisan konfirmasi AI (Grok/xAI) opsional per-bot sebelum entry |
| **PairClassifier** | Sistem klasifikasi pair (LIQUID/STABLE/VOLATILE) untuk override parameter risiko |
| **maxConcurrentPositions** | Cap account-wide posisi terbuka serentak (per tier: 4/8/12/16) |
| **TP Mode Full/Partial** | Full = ride ke TP penuh; Partial = partial close +1R/+2R + SL ke BEP |
| **AdminGuard** | Middleware verifikasi role ADMIN/SUPER_ADMIN (JWT + DB role check) |
| **PaymentAuditLog** | Log immutable setiap event lifecycle pembayaran (Midtrans) |

---

## 19. Lampiran

Dokumentasi teknis terkait di repo:

- [`be-bot-trading/ARCHITECTURE.md`](be-bot-trading/ARCHITECTURE.md) — SSOT naming §1, tier map §2, strategy umbrellas, API gaps §7
- [`QUANTARA_DOCUMENTATION_v2.0.md`](QUANTARA_DOCUMENTATION_v2.0.md) — ringkasan produk Gen2 (menggantikan docx yang hilang)
- [`be-bot-trading/docs/STRATEGIES.md`](be-bot-trading/docs/STRATEGIES.md) — parameter & logika strategi
- [`be-bot-trading/docs/README.md`](be-bot-trading/docs/README.md) — indeks docs operasional
- [`be-bot-trading/src/domain/tierConfig.js`](be-bot-trading/src/domain/tierConfig.js) — source of truth tier & entitlement
- [`be-bot-trading/src/config/strategies.js`](be-bot-trading/src/config/strategies.js) — Gen2 keys + TIER_COMPONENT_MAP
- [`be-bot-trading/src/domain/pricing.js`](be-bot-trading/src/domain/pricing.js) — pricing IDR + voucher math
- [`be-bot-trading/prisma/schema.prisma`](be-bot-trading/prisma/schema.prisma) — database schema lengkap
- [`fe-bot-trading/src/utils/tierStrategyMap.js`](fe-bot-trading/src/utils/tierStrategyMap.js) — FE tier/engine mirror
- [`fe-bot-trading/src/constants/theme.js`](fe-bot-trading/src/constants/theme.js) — color tokens app
- [`fe-bot-trading/src/constants/typography.js`](fe-bot-trading/src/constants/typography.js) — type scale app
- [`fe-bot-trading/BACKTEST_UI_IMPLEMENTATION.md`](fe-bot-trading/BACKTEST_UI_IMPLEMENTATION.md) — backtest UI spec
- [`fe-bot-trading/src/pages/LandingPage.jsx`](fe-bot-trading/src/pages/LandingPage.jsx) — marketing landing

---

*Dokumen ini diperbarui berdasarkan analisis codebase `be-bot-trading` + `fe-bot-trading` per 13 Juli 2026 (DOC-SSOT-03 — Sprint 10/11/12).*
