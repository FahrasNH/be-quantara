# Quantara Documentation v2.0

**Status:** PRODUCTION-READY (staging + production on VPS/PM2)  
**Updated:** 13 Juli 2026 (DOC-SSOT-03 — Sprint 10/11/12 alignment)  
**Repos:** `be-bot-trading` (be-quantara) · `fe-bot-trading` (fe-quantara)

> **SSOT:** Tier entitlement = [`be-bot-trading/src/domain/tierConfig.js`](be-bot-trading/src/domain/tierConfig.js).  
> Gen2 strategy keys & race pools = [`be-bot-trading/src/config/strategies.js`](be-bot-trading/src/config/strategies.js).  
> FE mirror = [`fe-bot-trading/src/utils/tierStrategyMap.js`](fe-bot-trading/src/utils/tierStrategyMap.js).  
> Historical Gen1→Gen2 map = [`be-bot-trading/ARCHITECTURE.md`](be-bot-trading/ARCHITECTURE.md) §1.  
> If this document disagrees with those files, **code wins**.

---

## 1. Product summary

Quantara is a non-custodial crypto futures trading-bot platform. Users connect their own exchange API keys (Bitget / OKX / Binance), pick strategies unlocked by subscription tier, and run bots in **Dry Run** (paper) or **Live** mode.

- **Four umbrella engines** (`AF_SMC`, `TS_TF`, `MD_MR`, `BS_BR`) with **12 live race components** across tiers
- **Race-to-confirm** inside each umbrella — highest-confidence racer wins; trade attribution = winning component key only
- **Single-position-per-symbol** — `maxPositionsPerSymbol = 1` for every tier (account-wide concurrent cap scales: 4/8/12/16)
- Global trading mode from Settings (Dry Run ↔ Live); per-bot `dryRun` in DB
- Midtrans billing (IDR); Admin dashboard (`/admin/*`)
- Backtest uses server-side `RealStrategyBacktestService` with isolated child-process workers, shared candle cache, optional Grok gate & **RAG gate (ML)** on `main`

---

## 2. Strategy architecture (Gen2 exclusively)

Each subscription tier unlocks **cumulative umbrella access**. Within each umbrella, independent **racers** compete on the same bar; the winner takes the trade slot for that symbol.

| Engine key | Umbrella (display) | Live race pool | Min tier unlock |
|------------|-------------------|----------------|-----------------|
| `AF_SMC` | Adaptive Fusion | `AF_SMC`, `AF_WYCKOFF`, `AF_VSA` | FOUNDRY |
| `TS_TF` | Trend Surge | `TS_TF`, `TS_MS`, `TS_VP` | FORGE |
| `MD_MR` | Mean Drift | `MD_MR`, `MD_SD`, `MD_SA` | MINT |
| `BS_BR` | Breakout Storm | `BS_BR`, `BS_ICT`, `BS_LS` | VAULT |

### Catalog method names (Sprint 10/11 naming lock)

| Key | Catalog label |
|-----|---------------|
| `MD_SD` | Supply and Demand |
| `MD_SA` | Statistical Arbitrage |
| `BS_ICT` | ICT-style trading |
| `BS_LS` | Liquidation/Squeeze Trading |

### Risk overlays (NOT race participants)

- **ADX Trend Strength Filter** — universal risk overlay inside `MD_MR` only (`md/adxRegimeGate.js`); never listed in `STRATEGY_CATALOG` or Advance component pickers
- **Grok Confirm Gate** — optional per-bot overlay on any canonical engine (prefer over `GROK_AI_TRADING` autonomous key)
- **OI / Funding overlays** — optional BS_LS enrichment; fail-open when absent

`GROK_AI_TRADING` = experimental VAULT bonus (LLM entry engine); **not** a tier race-pool member.

### Gen1 → Gen2 (migrate-only aliases)

| Gen1 / old docs | Gen2 engine |
|-----------------|-------------|
| `ADAPTIVE_FUSION` / `SMC` / `SAC` | `AF_SMC` |
| `TREND_FOLLOWING` / `TREND_MOMENTUM` / `TM` / `TF` | `TS_TF` |
| `MEAN_REVERSION` / `MEAN_DRIFT` / `MR` | `MD_MR` |
| `BREAKOUT_RETEST` / `BREAKOUT_STORM` / `BR` | `BS_BR` |

Marketing copy uses **display names** only — never raw Gen1 keys. `A` / `B` / `C` in `legacyStrategies.js` are PDF trade-type presets, not AF racers.

---

## 3. Subscription tiers (mirror of `tierConfig.js`)

Higher tiers **add** umbrellas; they do not replace lower-tier access.

| Tier | Entitlement keys (DB/API) | Package engines | Race components (cumulative) | maxPositions / symbol | maxConcurrentPositions | maxActiveBots |
|------|---------------------------|-----------------|------------------------------|----------------------|------------------------|---------------|
| **FOUNDRY** | `ADAPTIVE_FUSION` | `AF_SMC` | AF pool (3) | **1** | 4 | 10 |
| **FORGE** | + `TREND_FOLLOWING` | + `TS_TF` | AF + TS pools (6) | **1** | 8 | 25 |
| **MINT** | + `MEAN_REVERSION` | + `MD_MR` | AF + TS + MD pools (9) | **1** | 12 | 40 |
| **VAULT** | + `BREAKOUT_RETEST` | + `BS_BR` | All pools (12) | **1** | 16 | 50 |

`capitalRange` (IDR): FOUNDRY 1–2M · FORGE 2–5M · MINT 10–15M · VAULT 30M+.

**Removed legacy doc errors:** FOUNDRY-only AF / MINT=TM-only / per-tier maxPositions 2/3/4 — never enforced; runtime invariant is **1 position per symbol** for all tiers.

---

## 4. Backtest engine parity

| Piece | Role |
|-------|------|
| `RealStrategyBacktestService` | Server-side 1:1 engine (same umbrellas/racers as live) |
| `BacktestJobService` + `workers/backtestJobWorker.js` | Isolated `fork` child processes; max 1 concurrent job (OOM/502 fix) |
| `BacktestCandleCache.js` + DB `candle_cache` | L1 worker-local + L2 cross-job OHLCV reuse (Compare mode / tier packages) |
| `runBacktestJob.js` | Job runner; CSV enrichment via `strategyReasonFormatters.js` |
| RAG gate (`ragGate` opt-in) | Post-hoc `WinPredictor` + pgvector similarity on `main`; fail-open when model/embeddings absent |
| Grok gate | Optional signal filter (separate from RAG) |

**FE Backtest UX:** Advance mode component multi-select (`TIER_PACKAGE_COMPONENTS`); **Compare Multiple Tiers** runs full tier packages side-by-side with union component entitlement; `COMPONENT_TO_ENGINE` collapses racers → one engine run per umbrella (no N× capital split within umbrella).

Philosophy: **FULL PARITY** default (fees, slippage, funding, risk gates). Raw-signal research requires explicitly disabling cost overlays.

---

## 5. RAG / ML pipeline status

| Component | Status |
|-----------|--------|
| `WinPredictor` | Gradient-boosting classifier on `main`; model at `data/models/win-predictor.json` |
| `FeatureEngineer` + `TradeEmbedding` / pgvector | Training + similarity store |
| Backtest RAG gate | ✅ User toggle in Backtest Advanced Options; `GET /api/v1/backtest/rag-gate-status` |
| Live RAG shadow | Env `RAG_MODE` (default `shadow`) on `main` |
| Admin `/admin/analytics` | **Coming Soon** — Strategy Fit Matrix placeholder (`AdminPageSoon`) |
| Admin `/admin/parameters` | **Coming Soon** — walk-forward tuning placeholder |
| Admin RAG backtest dashboard | `/admin/rag-backtest` (staging-oriented analytics routes) |

---

## 6. Deployment & environments

| Environment | Git branch | PM2 app (BE) | Port | Deploy script |
|-------------|------------|--------------|------|---------------|
| **Staging** | `staging` | `be-quantara-staging` | 3001 | `scripts/deploy-staging-vps.sh` |
| **Production** | `main` | `be-quantara-prod` | 3000 | `scripts/deploy-production-vps.sh` |

Both run on VPS behind Nginx + PM2 (`ecosystem.config.js`). FE has matching `deploy-staging.sh` / `deploy-production.sh`.

---

## 7. Trading mode (Dry Run)

- **Not** a process env kill-switch for the whole app.
- FE: global `tradingMode` in Settings (`live` | dry).
- BE: per-bot `dryRun` boolean in DB; paper equity from `GET /api/v1/account/paper-balance` (`DRY_RUN_VIRTUAL_BALANCE` seed only).
- Live balance: `GET /api/v1/account/exchange-balance`.

---

## 8. Sprint deliverables (recent)

| Sprint | Deliverable |
|--------|-------------|
| **Sprint 10** | Mean Drift race pool: `MD_SD` (Supply and Demand), `MD_SA` (Statistical Arbitrage); `MeanDriftUmbrella` v4 race-to-confirm |
| **Sprint 11** | Breakout Storm race pool: `BS_ICT`, `BS_LS`; `BreakoutStormUmbrella` v3 race-to-confirm |
| **Sprint 12** | AF + TS race architecture finalized; shared backtest candle cache; single-position policy hardened (GRASS incident) |
| **BUG-CRITICAL 502** | Backtest worker isolation + heap/bar caps |

Rollback flags: `mdCombinationMode: "pipeline"` (MD_MR-only), `bsCombinationMode: "single"` (BS_BR-only), `afCombinationMode: "vote"` / `tsCombinationMode: "gate"` for legacy AF/TS fusion.

---

## 9. Notable API surface

| Endpoint | Status |
|----------|--------|
| `GET /api/v1/bots/:symbol/strategy-analysis` | ✅ BE; FE client exists; **no UI caller** yet |
| `POST /api/v1/bots/:symbol/strategy` | ✅ BE; UI prefers `PATCH .../config` |
| `GET`/`POST /api/v1/account/strategy` | ✅ Deprecated; unused by FE |
| `GET /api/v1/market/symbols` | ✅ Per-user connected exchange perpetual list |
| `POST /api/v1/backtest/run-real` | ✅ Async job + worker isolation |
| `GET /api/v1/backtest/rag-gate-status` | ✅ ML availability probe |
| `POST /api/v1/admin/bots/stop-all` | ✅ Emergency stop (superAdminGuard) |

Full gap audit: [`be-bot-trading/ARCHITECTURE.md`](be-bot-trading/ARCHITECTURE.md) §8.

---

## 10. Changelog

| Date | Change |
|------|--------|
| 2026-06-16 | Docx patch: production-ready, Dry Run, market/symbols |
| 2026-07-11 | DOC-SSOT-01/02: Markdown recreation; Gen2 tier tables |
| 2026-07-13 | **DOC-SSOT-03:** Sprint 10/11 MD/BS racers; race architecture all umbrellas; maxPositionsPerSymbol=1 all tiers; backtest worker/RAG/candle cache; deployment branches; admin Analytics/Parameters Coming Soon |

---

*Code is authoritative. Update this file whenever `tierConfig.js`, `strategies.js`, or sprint naming changes.*
