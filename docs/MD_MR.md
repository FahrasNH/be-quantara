# MEAN_REVERSION — Entry Triggers (AS-IS)

**Scope**: What triggers a MEAN_REVERSION entry and the signal labels emitted on fill.  
**Strategy key**: `MEAN_REVERSION` (`MeanReversionStrategy`, v3.0) — Mean Drift racer A  
**Engine SSOT**: `meanReversionEntry.js` / `MeanReversionStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `MEAN_REVERSION` + `STANDARD_LEG_TYPE_OVERRIDES`  
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

Per-leg SL/TP: `MeanReversionStrategy.calculateRiskConfig` + optional `tpOverride` from OB/FVG/BB mid.

### Entry thresholds (Layer A — BB + RSI + VWAP)

- **`bbStdDevA` / `bbStdDevB`:** 1.5 / 2.0 (σ) — Bollinger (Scalping / Intraday)
- **`rsiOversoldA` / `OverboughtA`:** 28 / 72 (RSI) — Scalping extremes
- **`rsiOversoldB` / `OverboughtB`:** 32 / 68 (RSI) — Intraday extremes
- **`minVolRatio`:** 0.8 (× vol SMA) — Volume floor
- **`bbPeriod` / `rsiPeriod`:** 20 / 14 (bar) — Indicator windows

### Gates (Layer B & C)

- **`mdAdxGateEnabled`:** `true` — ADX regime gate aktif
- **`mdAdxBalanceMax`:** 20 — ADX ≤ 20 = balance regime
- **`mdAdxImbalanceMin`:** 25 — ADX ≥ 25 = imbalance (blocked)
- **`mdAdxTransitionConfidenceMult`:** 0.75 — Confidence penalty di transition
- **`mdObFvgEnabled`:** `true` — OB/FVG refinement aktif
- **`mdConfluenceAtrMult`:** 0.5 — × ATR
- **`mdNoConfluenceConfidenceMult`:** 0.7 — fraksi

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `mrSessionFilter: false`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold

---

## Confidence Calculation

**Entry SSOT**: `meanReversionEntry.js` → `evaluateMeanReversionEntry`  
**ADX SSOT**: `adxRegimeGate.js` → `evaluateAdxRegimeGate`  
**Confluence SSOT**: `orderBlockFvg.js` → `refineMdEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreMeanReversion` via `MeanDriftUmbrella.js`

### How score is built

- **Range:** 0–100 (`componentConfidence` on meta)
- **Layer A base (fixed):** Scalping **65**, Intraday **60** when BB+RSI+VWAP trigger fires
- **ADX regime mult:** balance **×1.0**, transition **×0.75** (`mdAdxTransitionConfidenceMult`), imbalance **blocks** entry (mult 0)
- **OB/FVG mult:** confluence within `mdConfluenceAtrMult`×ATR → **×1.1** (`mdWithConfluenceConfidenceBoost`); miss → **×0.7** (`mdNoConfluenceConfidenceMult`) — fail-open
- **Final:** `round(min(100, base × adxMult × obFvgMult))`
- **Graded overlay (race):** deviation extremity, VWAP deviation, RSI extremity, regime suitability, room-to-mean

### Per leg thresholds

### Scalping

- **Floor:** none — only Layer A/B/C multipliers
- **Formula / components:** BB **1.5σ** + RSI **28/72** + VWAP side

### Intraday

- **Floor:** none
- **Formula / components:** BB **2.0σ** + RSI **32/68** + VWAP side

### Swing

- **Floor:** none (MR entry module implements Scalping + Intraday components only; Swing leg uses umbrella routing if enabled)
- **Formula / components:** same graded rubric when signal meta exported

---

## Risk & SL/TP (per Trade Type)

SL uses `atrMult` (1.4 ctor / 1.5 from Scalping `slAtrMult` override). TP prefers **structure target** (`tpOverride` from nearest FVG or BB middle via `resolveMdTakeProfit`) when distance ≥ 0.5× SL; else leg-specific RR multipliers. Entry BB/RSI gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5 (`slAtrMult`)
- **TP method:** FVG/BB mid override **or** 2.5× SL (`tpMultiplierA`) **or** 3.0× ATR
- **ATR mult / R:R:** 1.5 / up to 3.0 → **RR ≤ 2.0** planned
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; trailing stop 0.3×ATR; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.4
- **TP method:** FVG/BB override **or** 2.0× SL (`tpMultiplierB`)
- **ATR mult / R:R:** ~1.4 / 2.8 → **RR ~2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5 (parent)
- **TP method:** Override **or** 2.0× SL dist
- **ATR mult / R:R:** **RR 2.0** nominal
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%; `maxHoldHours` **120**

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

## How Entry Works

Three-layer pipeline: mean-reversion signal → ADX regime gate → optional OB/FVG refinement.

### Layer A — entry signal (`detectSignal`)

### Scalping

- **Entry TF:** 5m
- **LONG:** RSI < 28, close < BB(1.5σ) lower, below VWAP
- **SHORT:** RSI > 72, close > BB upper, above VWAP

### Intraday

- **Entry TF:** 15m
- **LONG:** RSI < 32, close < BB(2.0σ) lower, below VWAP
- **SHORT:** RSI > 68, close > BB upper, above VWAP

Scalping checked first; Intraday only if Scalping did not fire.

### Gate funnel

```
BB+RSI+VWAP extreme → volume floor → ADX regime gate → OB/FVG refine → signal
```

- **Volume < `minVolRatio`:** hard block
- **ADX imbalance (≥25):** hard block
- **ADX balance / transition:** pass (transition reduces confidence)
- **OB/FVG confluence:** confidence/TP boost; soft miss `OB/FVG~`
- **Session filter:** **off** (`mrSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

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

`getLastSignalMeta().component` stamps firing leg (Scalping/Intraday).

---

## Tick open trade

- **`interval`:** `15m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `15m` (HTF)

---

## Entry signal labels

- **RSI Extreme:** RSI past band in `reason`
- **BB Touch:** BB reference in `reason`
- **VWAP Dev:** VWAP side in `reason`
- **ADX Balance:** `adxRegime` balance/transition
- **OB/FVG Confluence:** `hasObFvgConfluence === true` or `OB/FVG✓`

Typical: `RSI Extreme, BB Touch, VWAP Dev, ADX Balance` (+ optional OB/FVG).

---

## AS-IS quirks

- **Mean Drift umbrella**: wins stamp `winningComponent: "MEAN_REVERSION"`.
- **Soft OB/FVG miss** (`OB/FVG~`) does not produce confluence label.

---

*Update when `detectSignal` reason format or gates change.*
