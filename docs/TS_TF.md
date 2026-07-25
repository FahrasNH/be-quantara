# TREND_FOLLOWING — Entry Triggers (AS-IS)

**Scope**: What triggers a TREND_FOLLOWING entry and the signal labels emitted on fill.  
**Strategy key**: `TREND_FOLLOWING` (`TrendFollowingStrategy`)  
**Engine SSOT**: `trendFollowingEntry.js` / `TrendFollowingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `TREND_FOLLOWING` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.06 (fraksi equity) — Daily loss halt (realized + floating)
- **`maxTradesPerDay`:** 4 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after any loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 2 (×) — Default bot leverage
- **`tpMode`:** `"fixed"` (enum) — Full TP at target; optional partial via `tpMode: "partial"`

Per-leg SL/TP: [`STANDARD_LEG_TYPE_OVERRIDES`](#risk--sltp-per-trade-type) + `TrendFollowingStrategy.calculateRiskConfig`.

### Entry thresholds (3-layer checklist)

- **`adxMinStrength`:** 25 (ADX) — Floor trend strength (HTF)
- **`donchianPeriod`:** 20 (bar) — Channel breakout window
- **`minVolRatio`:** 1.0 (× vol SMA) — Volume minimum on entry TF
- **`tfHtfLayerEnabled`:** `true` (bool) — HTF trend + ADX layer active
- **`htfRatio` / `mtfRatio`:** 12 / 3 (×) — Multi-TF stack ratios
- **`tsUseStructureGate`:** `false` (bool) — Dow structure overlay (MARKET_STRUCTURE)
- **`tsUseVwapPrecision`:** `false` (bool) — AMT precision overlay
- **`tsCombinationMode`:** `"race"` (enum) — TF / MS / AMT race independently

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `tsSessionFilter: true`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, `adxMinStrength: 20`, 120h hold

---

## Risk & SL/TP (per Trade Type)

`normalizeTfGeometryKeys` maps legacy `atrMultiplier` / `riskReward` → `slAtrMult` / `tpAtrMult` for TF only. Per-leg overrides from `STANDARD_LEG_TYPE_OVERRIDES` (Scalping gets explicit 1.5/3.0). Entry checklist: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5 (`slAtrMult`)
- **TP method:** ATR × 3.0 (`tpAtrMult`)
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; `tsSessionFilter`; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** `adxMinStrength` 20 on leg; `maxHoldHours` **120**

Optional **partial TP** (`tpMode: "partial"`): milestones at 1R/2R with SL+ ladder (`slPlusM1R` / `slPlusM2R` per leg).

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** 4
**SSOT:** `TS_COMPONENT_BASE`

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
**Value:** 6% equity (incl. floating)
**SSOT:** `maxDailyLossPct`

---
**Limit:** ATR range gate
**Value:** Scalping: relative 0.4–4.0; Intraday: abs ≥0.4%; Swing: abs ≥0.8% (max 8% vol cap)
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

Three-layer trend-following checklist — every layer must pass.

### Layer sequence

```
HTF Trend Align → Donchian Breakout → Entry-TF Pullback (EMA9 retest + ADX + volume) → signal
```

1. **HTF trend** — EMA stack + ADX ≥ `adxMinStrength` on higher timeframe
2. **Donchian breakout** — close breaks prior Donchian upper (LONG) or lower (SHORT) in HTF direction
3. **Entry-TF confirmation**:
   - ADX strength on HTF
   - EMA9 retest held
   - Volume ≥ `minVolRatio`
   - RSI not extreme against trend

### Gate funnel

- **HTF trend + ADX:** hard gate
- **Donchian break:** hard gate
- **EMA9 retest + volume + RSI:** hard gate
- **Session filter:** Scalping only (`tsSessionFilter`)
- **ATR gate:** per-leg overrides (Swing ADX floor 20)
- **Live money:** Scalping blocked; Intraday + Swing allowed

All checklist flags set **true** on every fill → label variance minimal.

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

Default live interval: `5m` (bot config); backtest uses `TYPE_TF` entry TF per leg.

---

## Tick open trade

- **`interval`:** `5m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `1h` (HTF)

---

## Entry signal labels

Nearly every fill:

`HTF Aligned, ADX Strength, Donchian Break, EMA9 Retest, Volume Confirmation`

Direction (LONG vs SHORT) not in labels.

---

## AS-IS quirks

- **Trend Surge umbrella**: TF wins stamp `winningComponent: "TREND_FOLLOWING"`.
- **Checklist all-or-nothing** — minimal label variance.
- **ctor drift**: `tpMode`, `riskPerTrade` differ from strategyDefaults unless merged.

---

*Update when gate order or label mapping change.*
