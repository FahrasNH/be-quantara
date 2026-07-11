# Quantara Documentation v2.0

**Status:** PRODUCTION-READY (staging + production deploy paths)  
**Updated:** 11 Juli 2026 (DOC-SSOT-01 / DOC-SSOT-02)  
**Repos:** `be-bot-trading` (be-quantara) · `fe-bot-trading` (fe-quantara)

> **SSOT:** Tier entitlement = [`be-bot-trading/src/domain/tierConfig.js`](be-bot-trading/src/domain/tierConfig.js).  
> Gen2 strategy keys = [`be-bot-trading/src/config/strategies.js`](be-bot-trading/src/config/strategies.js).  
> Historical Gen1→Gen2 map = [`be-bot-trading/ARCHITECTURE.md`](be-bot-trading/ARCHITECTURE.md) §1.  
> If this document disagrees with those files, **code wins**.
>
> *Note:* The previous `QUANTARA_DOCUMENTATION_v2.0.docx` is no longer in the workspace;
> this Markdown file is the maintained replacement (same role as the old §2/§3 product summary).

---

## 1. Product summary

Quantara is a non-custodial crypto futures trading-bot platform. Users connect their own exchange API keys (Bitget / OKX / Binance), pick strategies unlocked by subscription tier, and run bots in **Dry Run** (paper) or **Live** mode.

- Multi-bot per account (caps from `tierConfig.js`)
- Global trading mode from Settings (Dry Run ↔ Live); per-bot `dryRun` persisted in DB
- Midtrans billing (IDR)
- Admin dashboard (`/admin/*`)

---

## 2. Four trading strategies (Gen2 exclusively)

| Gen2 key | Umbrella (display) | Live components | Min tier |
|----------|--------------------|-----------------|----------|
| `AF_SMC` | Adaptive Fusion | `AF_SMC`, `AF_WYCKOFF`, `AF_VSA` (race-to-confirm) | FOUNDRY |
| `TS_TF` | Trend Surge | `TS_TF`, `TS_MS`, `TS_VP` (race-to-confirm) | FORGE |
| `MD_MR` | Mean Drift | `MD_MR` (internal A→B→C pipeline) | MINT |
| `BS_BR` | Breakout Storm | `BS_BR` | VAULT |

`GROK_AI_TRADING` = experimental VAULT bonus (not a tier race-pool member).

### Gen1 → Gen2 (see ARCHITECTURE.md §1 for full table)

| Gen1 / old docs | Gen2 |
|-----------------|------|
| `ADAPTIVE_FUSION` | `AF_SMC` |
| `TREND_MOMENTUM` / `TREND_FOLLOWING` / `TREND_SURGE` | `TS_TF` |
| `MEAN_REVERSION` / `MEAN_DRIFT` | `MD_MR` |
| `BREAKOUT_RETEST` / `BREAKOUT_STORM` | `BS_BR` |

Marketing copy uses **display names** only (Adaptive Fusion, Trend Surge, Mean Reversion / Mean Drift, Breakout Retest / Breakout Storm) — never raw Gen1 keys.

---

## 3. Subscription tiers (mirror of `tierConfig.js`)

| Tier | Entitlement keys in code | Gen2 engines | maxPositions / symbol | maxConcurrentPositions | maxActiveBots | autoSelector | aiOptimizer |
|------|--------------------------|--------------|----------------------|------------------------|---------------|--------------|-------------|
| FOUNDRY | `ADAPTIVE_FUSION` | `AF_SMC` | 1 | 4 | 10 | false | false |
| FORGE | + `TREND_FOLLOWING` | `AF_SMC`, `TS_TF` | 2 | 8 | 25 | false | false |
| MINT | + `MEAN_REVERSION` | `AF_SMC`, `TS_TF`, `MD_MR` | 3 | 12 | 40 | true | false |
| VAULT | + `BREAKOUT_RETEST` | `AF_SMC`, `TS_TF`, `MD_MR`, `BS_BR` | 4 | 16 | 50 | true | env flag |

`capitalRange` (IDR): FOUNDRY 1–2M · FORGE 2–5M · MINT 10–15M · VAULT 30M+.

**Incorrect legacy doc mapping (removed):** FOUNDRY-only AF / MINT=TM / VAULT=MR / LEGACY A/B/C as tiers — that was never what `tierConfig.js` enforced.

---

## 4. Trading mode (Dry Run)

- **Not** a process env kill-switch for the whole app.
- FE: global `tradingMode` in Settings (`live` | dry).
- BE: per-bot `dryRun` boolean in DB; paper equity from `GET /api/v1/account/paper-balance` (`DRY_RUN_VIRTUAL_BALANCE` seed only).
- Live balance: `GET /api/v1/account/exchange-balance`.

---

## 5. Notable API surface (bots / account strategy)

| Endpoint | Status |
|----------|--------|
| `GET /api/v1/bots/:symbol/strategy-analysis` | ✅ Implemented (`bots-afs.js`). FE client `getStrategyAnalysisV1` exists; **no UI caller** yet. |
| `POST /api/v1/bots/:symbol/strategy` | ✅ Implemented. FE `setStrategyV1` exists; UI prefers `PATCH .../config`. |
| `GET`/`POST /api/v1/account/strategy` | ✅ Implemented. **Unused by FE** — legacy account-level preset. |
| `GET /api/v1/market/symbols` | ✅ Per-user connected exchange perpetual list. |

Full gap audit: `ARCHITECTURE.md` §7.

---

## 6. Changelog

| Date | Change |
|------|--------|
| 2026-06-16 | Earlier docx patch: production-ready status, 4-symbol wording, global Dry Run, market/symbols. |
| 2026-07-11 | **DOC-SSOT:** Recreated as Markdown; tier table aligned to `tierConfig.js`; Gen2 naming exclusive; Gen1 map deferred to ARCHITECTURE §1. |

---

*Code is authoritative. Update this file whenever `tierConfig.js` or Gen2 keys change.*
