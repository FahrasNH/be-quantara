# LIQUIDATION_SQUEEZE — Entry Triggers (AS-IS)

**Scope**: What triggers a LIQUIDATION_SQUEEZE entry and the signal labels emitted on fill.  
**Strategy key**: `LIQUIDATION_SQUEEZE` (`LiquidationSqueezeStrategy`, v1.0) — Breakout Storm racer #2  
**Engine SSOT**: `liquidationSqueezeEntry.js` → `evaluateLiquidationSqueezeEntry`  
**Config SSOT**: `strategyDefaults.js` → `LIQUIDATION_SQUEEZE` (inherits `BS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.08 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 5 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 1 (×) — Spot-only default

Per-leg SL/TP: `LiquidationSqueezeStrategy.calculateRiskConfig` (engine 1.6 / 2.8).

### Entry thresholds

- **`bsLsWickLookback`:** 20 (bar) — Range extreme window
- **`bsLsMinWickBodyRatio`:** 1.5 (× body) — Wick ≥ 1.5× body
- **`bsLsWickVolMult`:** 1.2 (× vol SMA) — Volume pada wick bar
- **`bsLsOiLookback`:** 20 (bar) — OI change lookback
- **`bsLsOiChangeConfirmPct`:** 1.0 (%) — \
- **`bsLsExtremeFundingLong`:** 0.0005 (rate) — +0.05% / 8h funding extreme
- **`bsLsExtremeFundingShort`:** -0.0005 (rate) — -0.05% / 8h funding extreme
- **`bsLsBaseConfidence`:** 0.55 (0–1) — Wick-only confidence

### OI/Funding behavior

- **Fail-open:** Wick entries fire when OI/funding unavailable
- **Funding boost:** +0.2 confidence when extreme funding aligns
- **OI boost:** +0.15 confidence when OI change confirms

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `lsSessionFilter: false`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold

---

## Confidence Calculation

**Entry SSOT**: `liquidationSqueezeEntry.js` → `evaluateLiquidationSqueezeEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreLiquidationSqueeze` via `BreakoutStormUmbrella.js`

### How score is built

- **Range:** 0–1, capped at `bsLsMaxConfidence` (**0.92**)
- **Wick path (primary):** base `bsLsBaseConfidence` (**0.55**) when OI/funding available; **`bsLsDisplacementOnlyConfidence` 0.5** when data unavailable (fail-open)
- **Wick soft volume:** ×**0.9**
- **Funding alignment:** +`bsLsFundingBoost` (**0.2**) when extreme funding supports squeeze direction
- **OI confirm:** +`bsLsOiBoost` (**0.15**) when |OI change| ≥ `bsLsOiChangeConfirmPct`
- **Funding-only path (no wick):** `baseConf × 0.85` when extreme funding + OI rising
- **Graded overlay (race):** OI percentile, liq cluster proximity, wick reclaim depth, BB width percentile, OI forecast, squeeze confirmation

### Per leg thresholds

### Scalping

- **Floor:** none
- **Formula / components:** wick-first; OI/funding boosts confidence only (never hard-required)

### Intraday

- **Floor:** none
- **Formula / components:** same

### Swing

- **Floor:** none
- **Formula / components:** same

---

## Risk & SL/TP (per Trade Type)

Pure **ATR-based** SL/TP (no structure override). Wick detection sets entry; OI/funding affects confidence only. Entry path: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.6 (engine) / 1.5 (merged override)
- **TP method:** ATR × 2.8 / 3.0
- **ATR mult / R:R:** **RR ~1.75–2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.6
- **TP method:** ATR × 2.8
- **ATR mult / R:R:** **RR ~1.75**
- **Risk %:** **2%**
- **Notes:** OI/funding fail-open; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.6
- **TP method:** ATR × 2.8
- **ATR mult / R:R:** **RR ~1.75**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%; `maxHoldHours` **120**

Parent `riskReward` 3.0 is preset nominal; runtime uses engine ctor 1.6 / 2.8 unless Scalping typeOverride supplies 1.5 / 3.0.

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** 5
**SSOT:** `BS_COMPONENT_BASE`

---
**Limit:** Cooldown after loss
**Value:** 5 min
**SSOT:** `cooldownAfterLoss`

---
**Limit:** Consecutive loss stop
**Value:** 3
**SSOT:** `maxConsecLoss`

---
**Limit:** Daily loss limit
**Value:** 8% equity (incl. floating)
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

Combines **liquidation-style wick displacement** with optional **OI / funding** confirmation. OI/funding is **fail-open**.

### Primary path

```
Liquidation Wick → OI/Funding Boost (optional) → signal
```

1. **Liquidation wick** — sweep beyond recent range extreme + rejection close + wick ≥ 1.5× body:
   - Sweep lows → LONG (`liquidation_wick_low_bounce`)
   - Sweep highs → SHORT (`liquidation_wick_high_reject`)
2. **Funding / OI overlay** (when available): confidence boost; reason suffix `+funding_*_squeeze`, `+oi_rising`/`+oi_falling`
3. **Funding-only path** (no wick): extreme funding + rising OI can fire

Final `reason` prefixed with `ls_`.

### Gate funnel

- **Wick detection:** primary trigger
- **OI/funding:** boost or alt path; **fail-open** if missing
- **Session filter:** **off** (`lsSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

Backtests often lack OI/funding → wick-only path dominates.

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
- **`checkInterval`:** `900_000` (ms)
- **`higherTf`:** `4h` (HTF)

---

## Entry signal labels

- **Liquidation Wick (Bounce):** LONG wick setup
- **Liquidation Wick (Reject):** SHORT wick setup
- **Squeeze:** `squeeze` in reason
- **OI/Funding Proxy:** OI/funding fields or `dataAvailable === false`

Typical wick-only backtest: `Liquidation Wick (Bounce), OI/Funding Proxy`

---

## AS-IS quirks

- **Fail-open OI/funding** — missing data does not block wick entries.
- **`OI/Funding Proxy` on missing data** — label means proxy/unavailable path, not confirmed OI.

---

*Update when reason format or label mapping change.*
