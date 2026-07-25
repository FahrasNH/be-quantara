# STATISTICAL_ARBITRAGE — Entry Triggers (AS-IS)

**Scope**: What triggers a STATISTICAL_ARBITRAGE entry and the signal labels emitted on fill.  
**Strategy key**: `STATISTICAL_ARBITRAGE` (`StatisticalArbitrageStrategy`, v1.0) — Mean Drift racer #2  
**Display name**: **Statistical Arbitrage** (single-symbol z-score v1; pairs/cointegration is roadmap)  
**Engine SSOT**: `statisticalArbitrageEntry.js` → `evaluateStatisticalArbitrageEntry`  
**Config SSOT**: `strategyDefaults.js` → `STATISTICAL_ARBITRAGE` (inherits `MD_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.03 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 3 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 15 | menit | Cooldown after loss |
| `maxConsecLoss` | 2 | loss | Consecutive-loss stop |
| `leverage` | 1.0 | × | Spot-only default |

Per-leg SL/TP + z-score exit: [`STATISTICAL_ARBITRAGE`](#risk--sltp-per-trade-type) + `StatisticalArbitrageStrategy.calculateRiskConfig`.

### Entry thresholds (Statistical Arbitrage v1)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `mdSaLookback` | 40 | bar | Rolling mean/std window |
| `mdSaEntryZ` | **2.0** | σ | Minimum \|z\| untuk entry |
| `mdSaEntryZMax` | **2.5** | σ | Cap \|z\| — above = momentum, not revert |
| `mdSaExitZ` | 0.4 | σ | Mean-revert exit band |
| `mdSaMinBars` | 50 | bar | Minimum data |
| `mdSaBaseConfidence` | 0.58 | 0–1 | Confidence floor |
| `mdSaUseVwapBlend` | `true` | bool | Blend VWAP in mean |
| `mdSaSkipHtfSideways` | `true` | bool | Skip HTF 1w SIDEWAYS |
| `mdSaHtfAlignGate` | `true` | bool | No fade against HTF trend |
| `mdSaUseBenchmarkResidual` | `true` | bool | BTC-residual z when benchmark wired |
| `mdSaRequireTransitionRegime` | **`true`** (Swing) | bool | Swing edge in daily TRANSITION only |

### Modes

| Mode | Trigger |
| --- | --- |
| `rolling_mean` (default) | Z-score vs own rolling mean |
| `btc_residual` | Z-score vs rolling beta×BTC (when `benchmarkCloses` supplied) |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `saSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold, `mdSaRequireTransitionRegime: true` |

---

## Risk & SL/TP (per Trade Type)

**Primary exit** for mean-revert trades: optional early close when `|z| ≤ mdSaExitZ` (0.4σ) with `mdSaExitAtMean: true` — distinct from fixed TP distance. Entry z-band gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | ATR × 1.5 | ATR × 3.0 (typeOverride) **or** 2.0× SL (engine default) | 1.5 / 3.0 → **RR 2.0** | **1%** | Relative ATR gate; `saSessionFilter`; `maxHoldHours` **2** |
| Intraday | 15m / 1h | ATR × 1.5 | ATR × 2.0 (engine) / 3.0 (merged override) | **RR 1.33–2.0** | **2%** | HTF align gate; z-exit at 0.4σ; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.5 | ATR × 2.0–3.0 | **RR ~1.33–2.0** | **2%** | **TRANSITION** regime required; skip HTF SIDEWAYS; z-exit; `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 3 | `MD_COMPONENT_BASE` |
| Cooldown after loss | 15 min | `cooldownAfterLoss` |
| Consecutive loss stop | 2 | `maxConsecLoss` |
| Daily loss limit | 3% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |
| Z-score exit | Close when \|z\| ≤ 0.4 (`mdSaExitAtMean`) | `statisticalArbitrageEntry.js` |

---

## How Entry Works

Fires when price deviates **statistically** from rolling mean (or BTC residual), within z-score band **2.0–2.5σ**.

### Entry sequence

```
Rolling Mean + Std → Z-Score in [entryZ, entryZMax] → HTF/regime gates → signal
```

1. Compute rolling mean/std over `mdSaLookback` (or residual vs benchmark)
2. **Z-score** `z = (price - mean) / std`
3. Entry when `entryZ ≤ |z| ≤ entryZMax`:
   - `z ≤ -entryZ` → LONG
   - `z ≥ +entryZ` → SHORT
4. `reason` like `sa_v1_{mode}_z{-2.15}_long`

### Gate funnel

| Stage | Effect |
| --- | --- |
| \|z\| < 2.0 or > 2.5 | hard block (`z_inside_band`) |
| `std_too_small` | hard block |
| HTF SIDEWAYS (1w) | skip when `mdSaSkipHtfSideways` |
| HTF align gate | block fade vs HTF trend |
| Transition regime (Swing) | required when `mdSaRequireTransitionRegime` |
| Session filter | Scalping only (`saSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

**Exit (z-score)**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type) — optional mean-revert at `|z| ≤ mdSaExitZ`.

Walk-forward: SA Swing validated via dedicated walk-forward script (Gelombang 1+2 fixes).

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `15m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `15m` | HTF (Swing uses 1w in backtest harness) |

---

## Entry signal labels

Nearly every fill: `Z-Score Extreme, Mean Dev Band, Std Threshold`

Direction and exact z-value live in `reason`, not labels.

---

## AS-IS quirks

- **entryZ = 2.0, entryZMax = 2.5** — not single 1.6σ threshold.
- **Not true pairs arb** — v1 is single-symbol z-score.
- **Swing requires TRANSITION regime** in factory defaults.

---

*Update when z-score thresholds or gates change.*
