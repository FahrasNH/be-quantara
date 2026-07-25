# BREAKOUT_RETEST — Entry Triggers (AS-IS)

**Scope**: What triggers a BREAKOUT_RETEST entry and the signal labels emitted on fill.  
**Strategy key**: `BREAKOUT_RETEST` (`BreakoutTradingStrategy`) — Breakout Storm racer #0  
**Engine SSOT**: `breakoutTradingEntry.js` / `BreakoutTradingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `BREAKOUT_RETEST` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.08 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 5 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 1 (×) — Spot-only default
- **`preferredTpMode`:** `"full"` (enum) — Full TP default; partial ≤33% optional

Structure-aware SL/TP: `BreakoutTradingStrategy.calculateRiskConfig` — see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

### Entry thresholds (4-phase sequence)

- **`lookbackBars`:** 20 (bar) — High/low S&R untuk breakout
- **`volumeMultiplier`:** 1.5 (× vol SMA) — Volume minimum saat breakout
- **`maxVolumeRatio`:** 3.55 (× vol SMA) — Tolak exhaustion volume
- **`minBbWidthPct`:** 0.0076 (fraksi) — BB width floor
- **`minAtrPct`:** 0.25 (% harga) — ATR% floor
- **`minRetestBars`:** 16 (bar @15m) — Tunggu retest ≥4 jam
- **`retestWindow`:** 96 (bar @15m) — Retest ≤24 jam pasca-breakout
- **`minDisplacementAtr`:** 0.30 (× ATR) — Displacement post-breakout
- **`minRejectionWickRatio`:** 0.5 (fraksi) — Wick rejection di bar retest
- **`minRetestDepthAtr` / `maxRetestDepthAtr`:** 0.17 / 0.72 (× ATR) — Band kedalaman pullback

### Gates & regime blocks

- **`requireConsolidation`:** `true` — Wajib lolos vol floor sebelum arm breakout
- **`blockedMarketConds`:** `COILED_BREAKOUT`, `SQUEEZE_BREAKOUT`, `DRY_SQUEEZE` — Regime diblok

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `brSessionFilter: true`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold

---

## Risk & SL/TP (per Trade Type)

**Hybrid structure + ATR** SL: tighter of ATR stop vs structure stop (retest extreme ± 0.2×ATR or breakout level ± 0.25×ATR), floored at `minSlAtrFloor` 1.5×ATR. TP: structural target when on correct side, else ATR × `tpMultiplier`, **capped** at `maxPlannedRR` 2.5× actual SL distance. Pre-entry RR room checked in phase 12 ablation. Entry phases: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** Structure **or** ATR × 1.7 (min 1.5× floor)
- **TP method:** Structural target **or** ATR × 3.2, cap **2.5R**
- **ATR mult / R:R:** Planned ≤ **2.5R**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; `brSessionFilter`; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** Same hybrid SL
- **TP method:** Same capped TP
- **ATR mult / R:R:** Planned ≤ **2.5R**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** Same hybrid SL
- **TP method:** Same capped TP
- **ATR mult / R:R:** Planned ≤ **2.5R**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%; `maxHoldHours` **120**

Parent `riskReward` 3.0 is **nominal** — engine enforces `maxPlannedRR: 2.5`.

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

Four-phase sequential breakout: consolidation → breakout → displacement wait → true retest entry.

### Phase sequence

```
S&R Levels → BB Squeeze / Vol Floor → Breakout + Volume → Displacement Wait → Retest Confirm → signal
```

1. **Levels** — 20-bar resistance/support
2. **Volatility floor** — BB squeeze / ATR% consolidation
3. **Breakout arm** — close breaks level with volume; state stored
4. **Wait** — ≥ `minRetestBars`, ≤ `retestWindow`, displacement ≥ `minDisplacementAtr`
5. **Retest entry** — pullback to level + rejection wick + depth band
6. Meta flags: `bbSqueeze`, `rangeBreakout`, `retestConfirmation`, etc.

### Gate funnel

- **Consolidation / vol floor:** hard gate
- **Blocked regimes (`COILED`/`SQUEEZE`/`DRY_SQUEEZE`):** hard block
- **Breakout volume cap (`maxVolumeRatio`):** hard block
- **Session filter:** Scalping only (`brSessionFilter`)
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

Default live interval: `15m`. Backtest ladder: `runBacktestJob.TYPE_TF`.

---

## Tick open trade

- **`interval`:** `15m` (TF)
- **`checkInterval`:** `900_000` (ms (~15 min))
- **`higherTf`:** `4h` (HTF trend filter)

Production: confirmed candle signal → ticker `last` entry with stale guard.

---

## Entry signal labels

- **BB Squeeze:** `bbSqueeze` / `consolidationConfirmed`
- **Range Break:** `rangeBreakout` / `breakoutConfirmed`
- **Volume Spike:** breakout volume ratio > 1
- **Retest Confirm:** `retestConfirmation`

Typical fill: `BB Squeeze, Range Break, Volume Spike, Retest Confirm`

---

## AS-IS quirks

- **Breakout Storm umbrella**: wins stamp `winningComponent: "BREAKOUT_RETEST"`.
- **strategyDefaults vs ctor drift**: `maxTradesPerDay`, SL/TP multipliers differ unless overridden.
- **Direction omitted** from signal labels.

---

*Update when `detectSignal` meta flags or phase prerequisites change.*
