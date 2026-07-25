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

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.03 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 3 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 15 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 2 (loss) — Consecutive-loss stop
- **`leverage`:** 1.0 (×) — Spot-only default

Per-leg SL/TP + z-score exit: [`STATISTICAL_ARBITRAGE`](#risk--sltp-per-trade-type) + `StatisticalArbitrageStrategy.calculateRiskConfig`.

### Entry thresholds (Statistical Arbitrage v1)

- **`mdSaLookback`:** 40 (bar) — Rolling mean/std window
- **`mdSaEntryZ`:** **2.0** (σ) — Minimum \
- **`mdSaEntryZMax`:** **2.5** (σ) — Cap \
- **`mdSaExitZ`:** 0.4 (σ) — Mean-revert exit band
- **`mdSaMinBars`:** 50 (bar) — Minimum data
- **`mdSaBaseConfidence`:** 0.58 (0–1) — Confidence floor
- **`mdSaUseVwapBlend`:** `true` (bool) — Blend VWAP in mean
- **`mdSaSkipHtfSideways`:** `true` (bool) — Skip HTF 1w SIDEWAYS
- **`mdSaHtfAlignGate`:** `true` (bool) — No fade against HTF trend
- **`mdSaUseBenchmarkResidual`:** `true` (bool) — BTC-residual z when benchmark wired
- **`mdSaRequireTransitionRegime`:** **`true`** (Swing) (bool) — Swing edge in daily TRANSITION only

### Modes

- **``rolling_mean` (default)`:** Z-score vs own rolling mean
- **``btc_residual``:** Z-score vs rolling beta×BTC (when `benchmarkCloses` supplied)

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `saSessionFilter: false`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold, `mdSaRequireTransitionRegime: true`

---

## Confidence Calculation

**Entry SSOT**: `statisticalArbitrageEntry.js` → `evaluateStatisticalArbitrageEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreStatArb` via `MeanDriftUmbrella.js`

### How score is built

- **Range:** 0–1 (`confidence` on fill)
- **Formula:** `min(mdSaMaxConfidence, mdSaBaseConfidence + excess × mdSaZBoostPerUnit)` where `excess = |z| − mdSaEntryZ`
- **Defaults:** base **0.58**, max **0.95**, `mdSaZBoostPerUnit` **0** (flat — z-boost disabled after swing analysis)
- **Note:** `mdSaBaseConfidence` is the **starting score**, not a post-hoc floor gate
- **Graded overlay (race):** z extremity, band touch, revert speed, regime stationarity, std-dev stability

### Per leg thresholds

### Scalping

- **Floor:** none — must pass z-band **2.0–2.5σ** entry gate first
- **Formula / components:** same flat base + excess (currently zero boost)

### Intraday

- **Floor:** none
- **Formula / components:** same; HTF align gate blocks counter-trend fades

### Swing

- **Floor:** none
- **Formula / components:** same; `mdSaRequireTransitionRegime: true` is a **regime hard gate**, not confidence

---

## Risk & SL/TP (per Trade Type)

**Primary exit** for mean-revert trades: optional early close when `|z| ≤ mdSaExitZ` (0.4σ) with `mdSaExitAtMean: true` — distinct from fixed TP distance. Entry z-band gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0 (typeOverride) **or** 2.0× SL (engine default)
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 2.0 (engine) / 3.0 (merged override)
- **ATR mult / R:R:** **RR 1.33–2.0**
- **Risk %:** **2%**
- **Notes:** HTF align gate; z-exit at 0.4σ; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5
- **TP method:** ATR × 2.0–3.0
- **ATR mult / R:R:** **RR ~1.33–2.0**
- **Risk %:** **2%**
- **Notes:** **TRANSITION** regime required; skip HTF SIDEWAYS; z-exit; `maxHoldHours` **120**

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** 3
**SSOT:** `MD_COMPONENT_BASE`

---
**Limit:** Cooldown after loss
**Value:** 15 min
**SSOT:** `cooldownAfterLoss`

---
**Limit:** Consecutive loss stop
**Value:** 2
**SSOT:** `maxConsecLoss`

---
**Limit:** Daily loss limit
**Value:** 3% equity (incl. floating)
**SSOT:** `maxDailyLossPct`

---
**Limit:** ATR range gate
**Value:** Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8%
**SSOT:** `entryRiskGates.js`

---
**Limit:** Position sizing
**Value:** `size = (equity × legRiskPct) / slDistance`
**SSOT:** `typeRiskLadder.js`

---
**Limit:** TIME_STOP
**Value:** Scalping 2h · Intraday 6h · Swing 120h
**SSOT:** `STANDARD_LEG_TYPE_OVERRIDES`

---
**Limit:** Z-score exit
**Value:** Close when \
**SSOT:** z\

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

- **\:** z\
- **`std_too_small`:** hard block
- **HTF SIDEWAYS (1w):** skip when `mdSaSkipHtfSideways`
- **HTF align gate:** block fade vs HTF trend
- **Transition regime (Swing):** required when `mdSaRequireTransitionRegime`
- **Session filter:** **off** (`saSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

**Exit (z-score)**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type) — optional mean-revert at `|z| ≤ mdSaExitZ`.

Walk-forward: SA Swing validated via dedicated walk-forward script (Gelombang 1+2 fixes).

---

## Trade types

### Scalping

- **Entry TF:** 5m
- **Trend / HTF TF:** 1h
- **Real money:** Blocked
- **Dry-run / backtest:** Allowed

### Intraday

- **Entry TF:** 15m
- **Trend / HTF TF:** 1h
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

### Swing

- **Entry TF:** 4h
- **Trend / HTF TF:** 1w
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

---

## Tick open trade

- **`interval`:** `15m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `15m` (HTF (Swing uses 1w in backtest harness))

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
