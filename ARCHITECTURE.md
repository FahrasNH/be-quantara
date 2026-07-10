# Quantara Backend — Architecture Notes

> Living doc. Sections are added as subsystems are formalized. This file currently
> documents the **market / exchange** layer (Tasks A & C, Binance integration) and
> the **Adaptive Fusion / Trend Surge strategy config** (Sprint 8–9).

---

## 3. Backtest ↔ Live Parity (FULL PARITY philosophy)

**Philosophy:** Backtest mode **(A) FULL PARITY** is the default for go-live validation.
Raw-signal research (mode B) is available by disabling fees/slippage/`simulateFunding`
and/or setting `afUseThreeComponentVoting: false` — never confuse the two.

| Constraint | Live (`BotEngine`) | Backtest (`RealStrategyBacktestService`) |
|---|---|---|
| Consecutive-loss brake | `_checkRiskGates` (`maxConsecLoss`, default 3) | Same defaults; AF triple no longer raises cap to 5 |
| Daily loss limit | Realized + **floating** (default 3%) | Realized + floating; pair-tier `dailyLossLimit` via FE |
| Cooldown after loss | Candle/wall-clock minutes | Candle-time cooldown (same config minutes) |
| Max trades/day | Yes | Yes (+ pair-tier override) |
| Single-position / per-component | Yes | Yes (account-wide cap still excluded) |
| Fees | Taker 0.06% / maker 0.02% | Same; `enableFees` |
| Slippage | Exchange fills | Fixed 0.05% when `enableSlippage` (FE default ON) |
| Funding | Schema only (not accrued live yet) | `~0.01%/8h` hold-time cost when fees on |
| HTF / daily regime | HTF directional + MR filter | Same + `dailyRegimeGate` (backtest-only protective gate) |
| AF voter threshold | `afMinVotes` capped to active voter count | Same (`AdaptiveFusionUmbrella._aggregate`) |

Intentionally excluded from backtest (live-execution concerns): account coordinator
aggregate gates, signal idempotency cache, exchange min-lot / margin feasibility.

**Pool sizing (live multi-coin):** `PG_POOL_MAX` default 35, `PRISMA_CONNECTION_LIMIT`
default 15. Tick loops use chained `setTimeout` (no overlap). Reconcile is throttled
+ retried on pool connect timeout.

---

## 4. Strategy Config — Adaptive Fusion (AF_SMC)

**Source of truth:** `src/config/strategies.js` + `src/domain/strategy/umbrellas/AdaptiveFusionUmbrella.js`

### 4.1 Component model (Sprint 12 — Race-to-Confirm; AF-SUB-03 rescope)

| Slot | Key | Role | Implementation |
|------|-----|------|----------------|
| A | `AF_SMC` | Smart Money Concepts (independent racer) | `SmartMoneyConceptsStrategy` |
| B | `AF_WYCKOFF` | Wyckoff spring/upthrust (independent racer) | `WyckoffStrategy` → `af/wyckoffComponent.js` |
| C | `AF_VSA` | Volume Spread Analysis (independent racer) | `VsaStrategy` → `af/vsaComponent.js` |

**ARCHITECTURE DECISION (Fahras, 10 Jul 2026):** Race-to-Confirm replaces Sprint 8 2/3 voting.

- Umbrella `AF_SMC` is a **tier access bag** (FOUNDRY unlocks the pool), not a fusion mechanism.
- Active racers (from Advance `selectedComponents`, default all three) evaluate in parallel.
- Same-bar winner = highest confidence; ties break `AF_SMC` → `AF_WYCKOFF` → `AF_VSA`.
- Trade attribution label = **winning component only** (never joined "SMC + Wyckoff + VSA").
- Max 1 position/symbol still enforced by BotEngine / backtest engines.
- Rollback: `afCombinationMode: "vote"` restores Sprint 8 2/3 (altcoin 3/3) voting;
  `afUseThreeComponentVoting: false` → SMC-only passthrough.

Trade types for AF: **Scalping / Swing** only (Intraday removed AF-SCALP-19). When a
non-SMC racer wins, direction is promoted to type legs (standalone racer entry).

### 4.2 Key audit (AF-CONFIG-AUDIT)

Canonical live keys: `AF_SMC`, `AF_WYCKOFF`, `AF_VSA`, `TS_TF`, `TS_MS`, `TS_VP`, `MD_MR`, `BS_BR`.

Legacy aliases (migrate, do not delete abruptly): `ADAPTIVE_FUSION` / `SMART_MONEY_CONCEPTS` → `AF_SMC`,
`TREND_FOLLOWING` → `TS_TF`, `MEAN_REVERSION` → `MD_MR`, `BREAKOUT_RETEST` → `BS_BR`.

`A` / `B` / `C` in `legacyStrategies.js` are **PDF trade-type presets** (Scalping/Day/Swing),
not Adaptive Fusion components — do not confuse with AF racers.

**`GROK_AI_TRADING`:** experimental VAULT bonus that *does* generate LLM entry signals.
Not a tier umbrella / race-pool member. Prefer `GrokConfirm` overlay on canonical strategies
for production. Gated by entitlement (VAULT / open mode).

### 4.3 Research monitoring (not a live gate)

Pairwise signal correlation &lt; 0.5 among SMC/Wyckoff/VSA remains a **monitoring metric**
(coverage diversification insight), not a requirement to fuse votes. Per-strategy go/no-go
(WR ≥35%, PF ≥1.2, Sharpe ≥0.05, ≥30 trades/coin) is evaluated independently per racer.

---

## 5. Strategy Config — Trend Surge (TS_TF)

**Source of truth:** `src/config/strategies.js` + `src/domain/strategy/umbrellas/TrendSurgeUmbrella.js`

### 5.1 Component model (Sprint 12 — Race-to-Confirm)

| Slot | Key | Role | Implementation |
|------|-----|------|----------------|
| A | `TS_TF` | Trend Following (independent racer) | `TrendFollowingStrategy` |
| B | `TS_MS` | Dow Theory HH/HL pullback entries | `MarketStructureStrategy` → `ts/marketStructureComponent.js` |
| C | `TS_VP` | Auction Market Theory (VWAP reclaim / VA edge) | `VolumeProfileStrategy` → `ts/volumeProfileComponent.js` |

**ARCHITECTURE DECISION (Fahras, 10 Jul 2026):** Race-to-Confirm replaces Sprint 9 gate/layering.

- Umbrella `TS_TF` is a **tier access bag** (FORGE unlocks the pool), not a fusion mechanism.
- Active racers (from Advance `selectedComponents`, default all three) evaluate in parallel.
- Same-bar winner = highest confidence; ties break `TS_TF` → `TS_MS` → `TS_VP`.
- Trade attribution label = **winning component only** (never joined "A + B + C").
- Max 1 position/symbol still enforced by BotEngine / backtest engines.
- Rollback: `tsCombinationMode: "gate"` restores A→B→C layering; `"hybrid"` keeps A required with B/C as confidence boosters only.

### 5.2 Backtest UI visibility

FE Advance multi-select lists all live components under each umbrella
(`TIER_PACKAGE_COMPONENTS`). Selecting any component under an umbrella maps to a
single engine run via `COMPONENT_TO_ENGINE` (no N× capital split). Selected TS
keys become the race pool; per-trade `strategyLabel` comes from the winning racer.

---

## 6. Strategy Config — Mean Drift (MD_MR)

**Source of truth:** `src/config/strategies.js` + `src/domain/strategy/implementations/MeanReversionStrategy.js`
+ `src/domain/strategy/md/{adxRegimeGate,orderBlockFvg}.js`

### 6.1 Layered pipeline (MD-SUB-01 / MD-SUB-02 / MD-SUB-03)

Unlike AF/TS race-to-confirm pools, Mean Drift currently has **one live key** (`MD_MR`)
with an internal A→B→C pipeline:

| Layer | Role | Implementation |
|-------|------|----------------|
| A | BB+RSI+VWAP mean-reversion signal (Scalping / Intraday) | `MeanReversionStrategy.detectSignal` |
| B | ADX Trend Strength Filter (ADX(14) regime gate) | `md/adxRegimeGate.js` |
| C | Order Block + FVG entry confluence & TP target | `md/orderBlockFvg.js` |

**ADX gate (Component B):**
- `balance` (ADX &lt; 20) → MR allowed at full confidence
- `transition` (20–25) → MR allowed at reduced confidence (`mdAdxTransitionConfidenceMult`, default 0.75)
- `imbalance` (ADX ≥ 25) → MR blocked
- Missing ADX → fail-open (warmup)

**OB/FVG precision (Component C):**
- Entry keeps the A signal even without confluence, but confidence drops (`mdNoConfluenceConfidenceMult`, default 0.7)
- Confluence within `0.5×ATR` of an OB or unfilled FVG boosts confidence
- TP prefers nearest unfilled FVG midpoint in trade direction; else BB middle; else RR-based TP

**Also retained:** HTF EMA regime filter (`htfRegimeFilter.meanReversionRegimeFilter`) in BotEngine / backtest — complementary to entry-TF ADX.

Config knobs: `mdAdxGateEnabled`, `mdObFvgEnabled`, `mdAdxBalanceMax`, `mdAdxImbalanceMin`,
`mdConfluenceAtrMult`, `mdFvgScanBars`, `mdObLookback`.

Go/No-Go validation (WR ≥55%, PF ≥1.3, 12m multi-coin) remains a research gate after code lands.

---

## 3. API Surface

### 3.4 Market Endpoints

All routes are mounted under `/api/v1/market` behind `authMiddleware` (Bearer JWT
→ `req.userId`). Source: `src/server/routes/market.js`.

| Method | Path | Auth | User-scoped? | Data source | Notes |
|--------|------|------|--------------|-------------|-------|
| GET | `/market/symbols` | ✅ | ✅ by `req.userId` | Per-exchange public CCXT `loadMarkets` | **New (Task A).** Returns the user's connected exchange's USDT-M linear perpetual pairs. 5-min cache + stale fallback. Rate-limited 10/min/user. |
| GET | `/market/tickers` | ✅ | ➖ public data | `sharedClient` (env keys) | Public last-price/24h. No user data. |
| GET | `/market/candles` | ✅ | partial (`getBot` for interval) | `sharedClient` + cache | Public OHLCV. |
| GET | `/market/candles/backtest` | ✅ | ➖ public data | `sharedClient` + cache | Public OHLCV (paginated). |

#### `GET /api/v1/market/symbols`

Returns live perpetual pairs from the **exchange the requesting user has connected**.

- **Auth:** required (Bearer).
- **Rate limit:** 10 req/min/user (`SYMBOLS_RATE_LIMITED` 429 on excess).
- **Resolution:** `ExchangeService.getConnectedExchange(userId)` reads the user's
  own active `UserExchange` record (or legacy `User.exchangeType`).
- **Listing:** keyless public CCXT instance for that exchange → `loadMarkets` →
  filter to `swap && linear && quote === "USDT" && active` → normalize.

**Response 200:**
```json
{
  "ok": true,
  "exchange": "binance",
  "cached": false,
  "stale": false,
  "symbols": [
    { "symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "minQty": 0.001 }
  ]
}
```

**Caching (AC-4/AC-5):** in-memory, keyed **per exchange** (the list is public and
identical for all users on that exchange — no user data flows through the cache).
TTL 5 min. On exchange API failure with a warm cache → returns last list with
`"stale": true`. With a cold cache → `503 EXCHANGE_UNAVAILABLE` (never empty, never 500).

**Error states:**
| HTTP | code | when |
|------|------|------|
| 400 | `NO_EXCHANGE_CONNECTED` | user has no connected exchange |
| 400 | `EXCHANGE_NOT_SUPPORTED` | connected exchange not in {bitget, okx, binance} |
| 429 | `SYMBOLS_RATE_LIMITED` | >10 req/min |
| 503 | `EXCHANGE_UNAVAILABLE` | exchange down + no cache |

### 3.5 Supported Exchanges

| Exchange | Trading | Symbols listing | Key onboarding validation |
|----------|---------|-----------------|---------------------------|
| Bitget | ✅ full (`BitgetClient`) | ✅ | balance-reachability check |
| OKX | (client removed) | ✅ (public CCXT) | trusted as-is |
| Binance | market-data + onboarding only (`BinanceClient`) | ✅ | **permission validation** (futures-only, reject withdrawal) |

> `exchangeType` is a free-form `String` in Prisma (`schema.prisma`), **not** a DB
> enum. Adding Binance therefore needs **no migration** — `"binance"` is already a
> structurally valid value. Gating is enforced at the application layer via
> `cfg.allowedExchanges` and `POST /account/keys`.

### 3.6 Admin Endpoints — `routes/admin.js`

The Admin Dashboard backend (Tasks ADMIN-BE-01..08, incl. the Admin v2 pages
ADMIN-FE-05..13). All routes are mounted under `/api/v1/admin`. Source:
`src/server/routes/admin.js`.

#### Auth model

Two layers run in front of every dashboard route:

1. `authMiddleware` — verifies the Bearer JWT → `req.userId`.
2. `adminGuard` (`src/middleware/adminGuard.js`) — loads the caller's **role from
   the DB** (not the token, so a demotion takes effect immediately), allows
   `ADMIN`/`SUPER_ADMIN`, and caches the row on `req.adminUser`. `superAdminGuard`
   is the same guard narrowed to `SUPER_ADMIN` only, for destructive
   admin-management actions.

Composed as `requireAdmin = [authMiddleware, adminGuard]` and
`requireSuperAdmin = [authMiddleware, superAdminGuard]`. Responses use the standard
envelope: success `{ ok: true, ... }`, error `{ ok: false, statusCode, message }`
(401 unauthorized, 403 forbidden).

> **Legacy billing stub.** `PUT /admin/users/:userId/tier` and
> `GET /admin/users/:userId/tier` predate the role system and still use a separate
> secret-header scheme (`requireAdminSecret` → `x-admin-secret` matched against
> `process.env.ADMIN_SECRET`). They are server-to-server tier assignments with no
> JWT and are **not** covered by `adminGuard`.

#### Schema additions (`prisma/schema.prisma`)

| Addition | Detail |
|----------|--------|
| `enum UserRole { USER ADMIN SUPER_ADMIN }` | RBAC roles (ADMIN-BE-01). |
| `User.role UserRole @default(USER)` | Gate for `/admin/*` via `adminGuard`. |
| `User.suspendedAt DateTime?` | Non-null = suspended; login is blocked. |

Migrations: `20260620120000_add_user_role`, `20260620130000_add_user_suspended`.

> `prisma migrate dev` is **broken in this repo** (shadow-DB issue — see
> `prisma-shadow-db-broken-migration`). Migrations are applied via
> `prisma db execute` + `prisma migrate resolve` instead.

**Seed:** `scripts/seed-super-admin.js` (`npm run seed:admin`) — idempotent;
reads `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` from env.

#### Endpoint surface

| Method | Path | Guard | Purpose | FE consumer |
|--------|------|-------|---------|-------------|
| GET | `/admin/stats` | adminGuard | Headline KPI cards (ADMIN-BE-03 AC-02). | `useAdminStats` → stat cards |
| GET | `/admin/users` | adminGuard | User list + derived trading stats; `?status=Flagged` filters store-flagged users. | `useAdminUsers` → Users / Flagged |
| GET | `/admin/users/:id` | adminGuard | One user + aggregated trade stats. | `useAdminUserDetail` → UserDetail |
| PATCH | `/admin/users/:id/status` | adminGuard | Suspend / activate a user. | UserDetail / FlaggedUsers |
| PATCH | `/admin/users/:id/role` | superAdminGuard | Change a user's role. | UserDetail |
| POST | `/admin/users/:id/flag` | adminGuard | Flag a user for review (ADMIN-FE-05). | FlaggedUsers |
| DELETE | `/admin/users/:id/flag` | adminGuard | Clear a user's review flag. | FlaggedUsers |
| GET | `/admin/bots` | adminGuard | Running bots across all users. | `useAdminBots` → BotsPage |
| POST | `/admin/bots/stop-all` | superAdminGuard | **Emergency** stop every running bot + AuditLog + Telegram (ADMIN-BE-05). | BotsPage danger zone |
| GET | `/admin/health` | adminGuard | Platform health snapshot. | `useAdminHealth` |
| GET | `/admin/trades` | adminGuard | Recent trades across users + KPI summary. | `useAdminTrades` → Trades |
| GET | `/admin/activity` | adminGuard | Latest 12 audit events (dashboard feed). | `useAdminActivity` |
| GET | `/admin/audit` | adminGuard | Paginated + filterable AuditLog viewer (ADMIN-FE-12). | `useAdminAudit` → AuditLogPage |
| GET | `/admin/subscriptions` | adminGuard | Tier breakdown + MRR estimate. | `useAdminSubscriptions` → Subscriptions / Revenue |
| GET | `/admin/strategy-stats` | adminGuard | Aggregate performance per strategy (`?days=`) (ADMIN-FE-08). | `useAdminStrategyStats` → StrategyStats |
| GET | `/admin/alerts` | adminGuard | Operational alert feed from real signals (ADMIN-FE-10). | `useAdminAlerts` → AlertsPage |
| GET | `/admin/settings` | superAdminGuard | Env flags (read-only) + maintenance/feature flags (ADMIN-FE-11). | `useAdminSettings` → SettingsPage |
| PATCH | `/admin/settings` | superAdminGuard | Toggle maintenance / feature flags (audited). | SettingsPage |
| GET | `/admin/apikeys` | superAdminGuard | Masked exchange-connection audit — never secrets (ADMIN-FE-07). | `useAdminApiKeys` → APIKeysPage |
| GET | `/admin/trades/export` | adminGuard | Streaming CSV of all trades (ADMIN-BE-04). | ExportButton |
| GET | `/admin/backtest/export` | adminGuard | 501 — backtests not persisted yet. | ExportButton |
| GET | `/admin/admins` | superAdminGuard | List ADMIN + SUPER_ADMIN accounts (ADMIN-BE-07). | `useAdmins` → AdminManagement |
| POST | `/admin/admins` | superAdminGuard | Create a new admin. | AdminManagement |
| PATCH | `/admin/admins/:id` | superAdminGuard | Edit username / email. | AdminManagement |
| PATCH | `/admin/admins/:id/role` | superAdminGuard | Change an admin's role. | AdminManagement |
| POST | `/admin/admins/:id/reset-password` | superAdminGuard | Set a new password. | AdminManagement |
| DELETE | `/admin/admins/:id` | superAdminGuard | Remove an admin. | AdminManagement |

#### Platform state store (`src/infrastructure/store/platformStore.js`)

The Admin v2 endpoints need two pieces of platform state that don't warrant a
Prisma model + migration (the schema has no `Settings` table and `migrate dev`
is broken here): **maintenance mode / feature flags** and the **flagged-users
set**. Both live in a file-backed JSON store (`data/platform-store.json`, which
is git-ignored). `GET/PATCH /admin/settings` and the `/admin/users/:id/flag`
routes read/write it; `GET /admin/users` annotates each user with `flagged`.
`ALLOWED_TIERS` / `ALLOWED_EXCHANGES` remain **env-derived and read-only** in the
Settings page — they are set at deploy, not via the API.

> **Security.** `/admin/apikeys` returns only a masked fingerprint
> (`maskKey`, last 4 chars) + metadata — it never selects or transmits
> `apiKey`/`apiSecret`. Covered by `test/admin-v2.test.js`.

#### `GET /api/v1/admin/stats` — adminGuard

Headline KPI cards. MRR estimate = Σ (tier price × subscribers on that tier).

```json
{
  "ok": true,
  "stats": {
    "totalUsers":     { "value": 0, "deltaLabel": "+0 this week", "up": true },
    "activeBots":     { "value": 0, "deltaLabel": "Live trading",  "up": true },
    "totalTrades":    { "value": 0, "deltaLabel": "+0 today",      "up": true },
    "monthlyRevenue": { "value": 0, "deltaLabel": "from active tiers", "up": true, "currency": "$" }
  }
}
```

Each stat is `{ value, deltaLabel, up }`; `monthlyRevenue` also carries `currency`.

#### `GET /api/v1/admin/users?limit&search&tier&status` — adminGuard

User list with derived per-user trade counts + realized PnL (`limit` ≤ 500;
optional `search` / `tier` / `status` filters, also applied client-side by the FE).

```json
{
  "ok": true,
  "users": [
    { "id": "...", "name": "...", "email": "...", "joined": "2026-06-20",
      "tier": "FOUNDRY", "exchange": "Binance", "bots": 0, "trades": 0,
      "netPnl": 0, "status": "Active" }
  ],
  "total": 0
}
```

#### `GET /api/v1/admin/users/:id` — adminGuard

One user's profile + per-bot summary + aggregated stats.

```json
{
  "ok": true,
  "user": {
    "id": "...", "name": "...", "email": "...", "role": "USER",
    "status": "Active", "tier": "FOUNDRY", "exchange": "Binance",
    "bots": [ { "symbol": "BTCUSDT", "mode": "Live", "strategy": "AF", "status": "Running" } ],
    "stats": { "trades": 0, "netPnl": 0, "wins": 0, "winRate": 0, "openPositions": 0 }
  }
}
```

#### `PATCH /api/v1/admin/users/:id/status` — adminGuard

Body `{ "action": "suspend" | "activate" }`. SUPER_ADMIN targets are protected
(403). Suspending sets `suspendedAt` **and deletes the user's sessions** so the
suspension takes effect immediately.

#### `PATCH /api/v1/admin/users/:id/role` — superAdminGuard

Body `{ "role": "USER" | "ADMIN" | "SUPER_ADMIN" }`. Guards against demoting the
**last** SUPER_ADMIN (400).

#### `GET /api/v1/admin/bots` — adminGuard

Currently-running bots across all users.

```json
{
  "ok": true,
  "bots": [
    { "user": "...", "symbol": "BTCUSDT", "mode": "Live", "strategy": "AF",
      "capital": "$500", "openPos": "None", "roi": 0, "since": "20/06 09:30",
      "status": "Running" }
  ]
}
```

#### `GET /api/v1/admin/health` — adminGuard

Reports only what the API can actually verify — DB ping (`SELECT 1`),
running-bot count, and process uptime. **No fabricated exchange ping.**

```json
{
  "ok": true,
  "services": [ { "label": "Database", "state": "ok", "note": "Healthy" } ],
  "uptime": "3h 12m"
}
```

#### `GET /api/v1/admin/trades/export` — adminGuard

Streaming, **cursor-paginated** CSV of all trades across all users
(ADMIN-BE-04). Batched (500/page) so memory stays flat on large tables;
`Content-Disposition: attachment`.

#### `GET /api/v1/admin/backtest/export` — adminGuard

Returns **501** — backtests are computed on demand and not persisted (no
`Backtest`/`BacktestRun` model in the schema yet). The dashboard's Backtest tab
uses client-side sample data in the meantime.

#### Admin management — superAdminGuard (ADMIN-BE-07)

`GET /admin/admins` (list), `POST /admin/admins` (create — bcrypt-hashes the
password, seeds a default `ADAPTIVE_FUSION` strategy), `PATCH /admin/admins/:id`
(edit username/email), `PATCH /admin/admins/:id/role` (change role),
`POST /admin/admins/:id/reset-password` (set new password + kill sessions), and
`DELETE /admin/admins/:id`. Delete guards against removing **yourself** and the
**last** SUPER_ADMIN; create/edit return 409 on email/username clash.

#### Audit logging

Every admin **mutation** writes an `AuditLog` row (best-effort — logging never
breaks the action). Actor = `req.adminUser.id`; actions include
`ADMIN_USER_STATUS`, `ADMIN_CHANGE_ROLE`, `ADMIN_CREATE_ADMIN`,
`ADMIN_EDIT_ADMIN`, `ADMIN_RESET_PASSWORD`, and `ADMIN_DELETE_ADMIN`.

#### Pending (engine integration not yet wired)

| Endpoint | Status |
|----------|--------|
| `POST /admin/bots/:id/stop` (force-stop one user's bot) | **Not implemented** — needs the bot engine/coordinator wired into the admin router. |
| Emergency stop-all (ADMIN-BE-05) | **Not implemented** — same dependency on the engine/coordinator. |

---

## Appendix A — IDOR Audit: Market & Symbol Endpoints (Task C)

Audited 2026-06-16. Scope: the 5 endpoints in §3.4. Goal: confirm every endpoint
that returns user-specific data scopes its query to `req.userId` (from the verified
JWT), never to a spoofable param/body.

| Endpoint | Returns user-specific data? | userId source | Verdict |
|----------|----------------------------|---------------|---------|
| `GET /market/symbols` | No (public list; exchange *type* derived from user's own record) | `req.userId` (JWT) | ✅ **IDOR-safe** (AC-5) |
| `GET /market/tickers` | No — public prices | n/a | ✅ no user data |
| `GET /market/candles` | No — public OHLCV (`getBot(req.userId,…)` only for interval default) | `req.userId` (JWT) | ✅ no leak |
| `GET /market/candles/backtest` | No — public OHLCV | n/a | ✅ no user data |

**Conclusion (AC-6):** No cross-user IDOR found. `req.userId` always comes from the
verified JWT payload (`authMiddleware`), never from request params/body. The new
`/market/symbols` endpoint cannot return another user's data — it only ever reads
the caller's own `UserExchange` record to pick which *public* list to serve.

### Finding SEC-MKT-1 — ✅ RESOLVED (2026-06-16)

`GET /market/positions` (and the adjacent `GET /market/balance`) called
`sharedClient.getPositions/getBalance`, where `sharedClient` is built from
**operator ENV keys** — so any authenticated user received the *operator* account's
positions/balance. Not cross-user IDOR (no per-user data leaked between users), but
an information-disclosure smell.

- **Severity:** P3.
- **Resolution:** **both endpoints removed.** They were dead (no FE caller — the
  only consumer, the FE `usePositions` hook, was unused dead code; live positions
  come from per-bot WebSocket state, and balance from `/account/exchange-balance`
  with the user's own creds). Removing them closes the exposure entirely rather than
  maintaining unused routes. FE `usePositions.js` + `botApi.positions()` also deleted.
- **Per-user data:** still served by `/account/exchange-balance` (own creds) and
  per-bot WS `openPositions`.

### Encryption verification (AC-8)

Binance keys reuse the existing `crypto.js` AES-256-GCM path (`encrypt`/`decrypt`,
12-byte IV, auth tag, `iv:authTag:ciphertext` format) via `userExchange.upsertExchange`
— identical to Bitget/OKX. No Binance-specific storage path exists, so there is no
divergent encryption surface to verify beyond the shared mechanism.
