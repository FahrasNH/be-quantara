# SUPPLY_AND_DEMAND — Entry Triggers (AS-IS)

**Scope**: What triggers a SUPPLY_AND_DEMAND entry and the signal labels emitted on fill.  
**Strategy key**: `SUPPLY_AND_DEMAND` (`SupplyDemandStrategy`, v1.0) — Mean Drift racer #1  
**Engine SSOT**: `supplyDemandEntry.js` → `evaluateSupplyDemandEntry`  
**Config SSOT**: `strategyDefaults.js` → `SUPPLY_AND_DEMAND` (inherits `MD_COMPONENT_BASE`)  
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

Per-leg SL/TP: `SupplyDemandStrategy.calculateRiskConfig` + zone/FVG `tpOverride`.

### Entry thresholds

- **`mdSdConfluenceAtrMult`:** 0.75 (× ATR) — Radius zone retest
- **`mdSdMinReversalBodyPct` / `minReversalBodyPct`:** 0.35 (fraksi) — Body minimum reversal candle
- **`mdSdVolConfirmMult`:** 0.9 (× vol SMA) — Soft volume confirm
- **`mdSdScanBars`:** 40 (bar) — Zone scan window
- **`mdSdFvgMinGapPct`:** 0.0015 (fraksi) — FVG gap minimum
- **`mdSdObLookback`:** 25 (bar) — Order block lookback
- **`mdSdObDispMult`:** 1.3 (× vol SMA) — OB displacement volume
- **`mdSdBaseConfidence`:** 0.62 (0–1) — Confidence floor

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `sdSessionFilter: false`, RR 2.0
- **Intraday:** `atrMinMult: 0.4`
- **Swing:** `atrMinMult: 0.8`

---

## Confidence Calculation

**Entry SSOT**: `supplyDemandEntry.js` → `evaluateSupplyDemandEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreSupplyDemand` via `MeanDriftUmbrella.js`

### How score is built

- **Range:** 0–1 (`confidence` on fill)
- **Base:** `mdSdBaseConfidence` (**0.62**)
- **Zone retest boost:** +`mdSdZoneBoost` (**0.18**) when price retests demand/supply with reversal body
- **Volume confirm boost:** +`mdSdVolBoost` (**0.10**) when volume ≥ `mdSdVolConfirmMult`× SMA (soft — entry fires without it)
- **Cap:** `min(1, base + boosts)`
- **Note:** `mdSdBaseConfidence` is additive base, not a reject floor
- **Graded overlay (race):** zone freshness, zone strength, retest depth, volume confirm flag, confluence, zone size fit

### Per leg thresholds

### Scalping

- **Floor:** none
- **Formula / components:** same additive stack at zone retest

### Intraday

- **Floor:** none
- **Formula / components:** same

### Swing

- **Floor:** none
- **Formula / components:** same

---

## Risk & SL/TP (per Trade Type)

Zone **retest radius** uses `mdSdConfluenceAtrMult` 0.75×ATR (entry) — not the SL distance. TP prefers nearest opposing FVG/structure via `resolveMdTakeProfit`. Entry zone gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5 (`slAtrMult`)
- **TP method:** FVG/structure override **or** ATR × 2.5
- **ATR mult / R:R:** 1.5 / 2.5 → **RR ~1.67**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.4 (engine default)
- **TP method:** Override **or** ATR × 2.5
- **ATR mult / R:R:** 1.4 / 2.5 → **RR ~1.79**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.4
- **TP method:** Override **or** ATR × 2.5
- **ATR mult / R:R:** **RR ~1.79**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%

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
**Value:** **OFF** (no `maxHoldHours` — positions exit on SL/TP only)
**SSOT:** opt-in via `typeOverrides.*.maxHoldHours`

---

## How Entry Works

Enters on **retest of demand or supply zone** with reversal candle confirmation.

### Entry sequence

```
Scan OB/FVG Zones → Price Retest in Zone → Reversal Candle → signal
```

1. Build **demand** and **supply** zones from recent displacement (OB/FVG-style)
2. Find nearest zone within ATR radius of current price
3. **Reversal candle** required at zone
4. Prefer closer zone when both sides qualify
5. `reason` = `sd_retest_{zoneKind}_{long|short}[_vol_ok|_vol_soft]`

### Gate funnel

- **Zone proximity:** hard gate
- **Reversal candle:** hard gate
- **Volume confirm:** confidence boost only
- **Session filter:** **off** (`sdSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

Volume confirmation does not add a separate signal label.

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
- **`higherTf`:** `15m` (HTF)

---

## Entry signal labels

- **Demand Retest:** LONG at demand zone
- **Supply Retest:** SHORT at supply zone
- **OB/FVG Structure:** zone kind is OB or FVG

Typical LONG: `Demand Retest, OB/FVG Structure`

Reversal candle is a gate — no separate label.

---

## AS-IS quirks

- **Mean Drift umbrella**: wins stamp `winningComponent: "SUPPLY_AND_DEMAND"`.
- **Formatter fallback** can emit all three labels when meta sparse — not typical on real fills.

---

*Update when zone kinds or label mapping change.*
