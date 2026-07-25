# WYCKOFF — Entry Triggers (AS-IS)

**Scope**: What triggers a WYCKOFF entry and the signal labels emitted on fill.  
**Strategy key**: `WYCKOFF` (`WyckoffStrategy`, v2.0)  
**Engine SSOT**: `wyckoffEntry.js` → `evaluateWyckoffComponent`  
**Config SSOT**: `strategyDefaults.js` → `WYCKOFF` (inherits `AF_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]` (Scalping blocked globally)  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Wyckoff-specific knobs on `STRATEGIES.WYCKOFF`; leg geometry from `STANDARD_LEG_TYPE_OVERRIDES`.

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.03 (fraksi equity) — Daily loss halt (realized + floating)
- **`maxTradesPerDay`:** 8 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 60 (menit) — Cooldown after any loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 3 (×) — Default bot leverage
- **`minRr`:** 2.0 (R) — Minimum planned RR in entry checklist (moderate/conservative)

Signal meta carries **structure-based** SL/TP; see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

### Entry thresholds (Wyckoff component)

- **`entryModel`:** `"aggressive"` (enum) — `moderate` / `conservative` = checklist lebih ketat
- **`lookback`:** 100 (bar) — Indikator & volume SMA window
- **`rangeLookback`:** 20 (bar) — Horizontal range S/R
- **`minBarsInRange`:** 20 (bar) — Range harus mature
- **`minRangeWidthPct` / `maxRangeWidthPct`:** 0.005 / 0.05 (fraksi harga) — Lebar range valid
- **`bbWidthPercentileMax`:** 40 (percentile) — Kompresi BB width untuk trading range
- **`penetrationAtrMult`:** 0.8 (× ATR) — Kedalaman spring/upthrust minimum
- **`recoveryWindow`:** 5 (bar) — Window reclaim setelah manipulasi
- **`volumeConfirmMult`:** 1.0 (× vol SMA) — Konfirmasi volume pada event
- **`cooldownBars`:** 5 (bar) — Jeda antar sinyal

### Gates (entry model layers)

- **``aggressive` (default)`:** `tradingRange`, `manipulation`, `reclaimOrReject`, `volumeConfirm`
- **``moderate``:** + `priorTrend`, `rejection`, `choch`, `proximityOk`, `rrOk`
- **``conservative``:** + `climaxOrWeakening`, `sosOrSow`, `lpsOrLpsy`

Backtest default: `runBacktestJob.js` forces `entryModel: "aggressive"` when unset.

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `wyckoffSessionFilter: false`, RR 2.0 / 2h hold
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold

---

## Confidence Calculation

**Checklist SSOT**: `wyckoffEntry.js` → `evaluateEntryChecklist`  
**Pattern SSOT**: `wyckoffEntry.js` → `detectSpring` / `detectUpthrust`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreWyckoff` via `AdaptiveFusionUmbrella.js`

### How score is built

- **Range:** 0–1 (`result.confidence` on fill)
- **Spring / upthrust path:** pattern confidence = `min(1, volRatio / 1.5)` on manipulation bar
- **Checklist blend:** `min(1, patternConf × (0.5 + 0.5 × fill))` where `fill` = fraction of checklist keys passed (`evaluateEntryChecklist`)
- **Continuation path (LPS / LPSY):** fixed **0.72** when SOS→LPS or SOW→LPSY schematic fires (`evaluateSchematicContinuation`)
- **Graded overlay (race):** 0–100 from phase type, spring/UT depth, SOS/SOW volume, LPS quality, accumulation duration, effort vs result — attached post-signal for CSV / AF winner tie-break
- **No per-leg confidence floor** — checklist failure returns NEUTRAL before score matters

### Per leg thresholds

### Scalping

- **Floor:** none
- **Formula / components:** same checklist; session block (Asia) is hard gate, not confidence

### Intraday

- **Floor:** none
- **Formula / components:** moderate/conservative models add required checklist layers (`priorTrend`, `choch`, `rrOk`, …)

### Swing

- **Floor:** none
- **Formula / components:** identical scoring; longer hold / wider ATR gate only affects execution limits

---

## Risk & SL/TP (per Trade Type)

Wyckoff embeds **structure SL/TP in signal meta** (`wyckoffEntry.js`): LONG spring → SL at invalidation (below spring) / TP at `rangeHigh`; SHORT upthrust → SL at invalidation / TP at `rangeLow`. LPS/LPSY continuation uses range boundary invalidation with opposite range target. `WyckoffStrategy` has **no** `calculateRiskConfig` — backtest executor falls back to ATR × 1.5 SL and `riskReward` 2.0 TP unless meta levels are wired by the umbrella winner path. Entry checklist gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** **Structure**: spring/upthrust invalidation level
- **TP method:** **Structure**: opposite range boundary
- **ATR mult / R:R:** Meta RR ≥ `minRr` 2.0; fallback 1.5× / 3.0× ATR
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; Asia session block; `maxHoldHours` **2**

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** Structure invalidation (meta)
- **TP method:** Opposite range edge (meta)
- **ATR mult / R:R:** Planned RR from meta; fallback **RR 2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%; `maxHoldHours` **6**

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** Structure invalidation (meta)
- **TP method:** Opposite range edge (meta)
- **ATR mult / R:R:** Planned RR from meta; fallback **RR 2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%; `maxHoldHours` **120**

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** 8
**SSOT:** `AF_COMPONENT_BASE`

---
**Limit:** Cooldown after loss
**Value:** 60 min
**SSOT:** `cooldownAfterLoss`

---
**Limit:** Consecutive loss stop
**Value:** 3
**SSOT:** `maxConsecLoss`

---
**Limit:** Daily loss limit
**Value:** 3% equity (incl. floating)
**SSOT:** `maxDailyLossPct`

---
**Limit:** Signal cooldown
**Value:** 5 bars between Wyckoff signals
**SSOT:** `cooldownBars`

---
**Limit:** ATR range gate
**Value:** Scalping: relative 0.4–4.0; Intraday: abs ≥0.4%; Swing: abs ≥0.8%
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

Wyckoff scans for a **valid trading range**, then a schematic manipulation event and entry checklist pass.

### Detection sequence

```
Trading Range → Spring (LONG) or Upthrust (SHORT) → Entry Checklist → signal
```

1. **Trading range** — BB-width compression + mature horizontal range (`detectTradingRange`)
2. **Manipulation event**:
   - LONG: **Spring** — fake break below range low + reclaim
   - SHORT: **Upthrust** — fake break above range high + rejection
3. **Entry checklist** (`evaluateEntryChecklist`) — layers vary by `entryModel`
4. On pass: `reason` = `wyckoff_spring` (LONG) or `wyckoff_upthrust` (SHORT)

### Gate funnel (pattern → execution)

- **Trading range valid:** hard gate
- **Spring / Upthrust:** entry trigger
- **Checklist (model-dependent):** hard gate
- **Session filter:** **off** (`wyckoffSessionFilter: false`)
- **ATR gate:** per-leg `atrMinMult` / relative band
- **Cooldown:** `cooldownBars` between signals
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

---

## Tick open trade

**Production path:** `AdaptiveStrategyEngine._tick()` — confirmed candle signal, ticker entry with stale guard.

- **`interval`:** `1h` (TF) — Live tick candle
- **`checkInterval`:** `3_600_000` (ms) — ~1 h between ticks
- **`higherTf`:** `4h` (TF) — HTF trend filter

---

## Entry signal labels

- **Spring:** `reason === "wyckoff_spring"`
- **Upthrust:** `reason === "wyckoff_upthrust"`
- **LPS** / **LPSY** / **LPS/LPSY:** checklist flags (moderate/conservative)
- **SOS** / **SOW:** `checklist.sosOrSow` + side
- **Volume Climax:** volume confirm / climax flags

**Aggressive model** — most fills: `Spring` or `Upthrust` only.

---

## AS-IS quirks

- **AF umbrella**: Wyckoff wins stamp `winningComponent: "WYCKOFF"`.
- **Backtest forces aggressive** — aligns with factory reset.
- **Low label variance on aggressive** — direction (Spring vs Upthrust) is main difference.

---

## Quick reference — sequence vs labels

### Valid trading range

- **Drives entry?:** Yes (gate)
- **Signal label?:** No

### Spring / Upthrust

- **Drives entry?:** Yes (trigger)
- **Signal label?:** Yes

### SOS / SOW / LPS

- **Drives entry?:** Model-dependent
- **Signal label?:** Yes when flagged

### Volume confirm

- **Drives entry?:** Yes (checklist)
- **Signal label?:** Yes — `Volume Climax` when flagged

---

*Update this file when `evaluateEntryChecklist` prerequisites or signal label mapping change.*
