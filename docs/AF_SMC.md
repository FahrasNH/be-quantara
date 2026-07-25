# SMART_MONEY_CONCEPTS — Entry Triggers (AS-IS)

**Scope**: What triggers a SMART_MONEY_CONCEPTS entry and the signal labels emitted on fill.  
**Strategy key**: `SMART_MONEY_CONCEPTS` (`SmartMoneyConceptsStrategy`, v3.0)  
**Engine SSOT**: `SmartMoneyConceptsStrategy.js` → `_detectSMCSequence`  
**Gates SSOT**: `smcEntry.js` → session / chop / OB-retest / funding helpers  
**Config SSOT**: `strategyDefaults.js` → `SMART_MONEY_CONCEPTS` + `SMC_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → `PER_STRATEGY_LIVE_ELIGIBLE_TYPES.SMART_MONEY_CONCEPTS = []`  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Nilai di bawah dari **`strategyDefaults.js`** (SSOT); gate boolean default **OFF** kecuali disebut.  
Per-leg tuning hidup di `SMC_LEG_TYPE_OVERRIDES` (bukan geometri seragam).

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg (`typeRiskLadder.js`)
- **`maxDailyLossPct`:** 0.03 (fraksi equity) — Daily loss halt (realized + floating)
- **`maxTradesPerDay`:** 8 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 60 (menit) — Cooldown after any loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 3 (×) — Default bot leverage

Per-leg SL/TP geometry: [`SMC_LEG_TYPE_OVERRIDES`](#risk--sltp-per-trade-type) and `SmartMoneyConceptsStrategy.calculateRiskConfig`.

### Entry thresholds (sequence engine)

- **`smcUseSequenceEngine`:** `true` (bool) — `false` = legacy single-bar (signal labels biasanya kosong)
- **`smcMinConfidenceScalping/Intraday/Swing` (alias `A/B/C`)`:** 60 / 60 / 60 (0–100) — Top-level floors (live). Backtest merges per-leg `typeOverrides`
- **`smcSeqWindow`:** 60 (bar) — Lookback maksimal untuk merakit sweep→CHoCH→FVG
- **`smcSweepVolMult`:** 0.9 (× vol SMA) — Volume minimum pada liquidity sweep
- **`smcFvgMinGap`:** 0.0015 (fraksi harga) — Gap FVG minimum (0.15%)
- **`smcDispVolMult`:** 1.8 (× vol SMA) — Volume minimum bar displacement
- **`smcOBDispMult`:** 1.3 (× vol SMA) — Displacement minimum order block
- **`vwapLookback`:** 14 (bar) — Lookback VWAP / CVD

### Gates (opt-in — default OFF at top level)

- **`smcPivotStructure`:** `false` — CHoCH dari pivot engine; mengaktifkan label **Fresh OB**
- **`smcPremiumDiscountGate`:** `false` — LONG hanya di discount / SHORT di premium
- **`smcRejectionEntry`:** `false` — Wajib rejection wick di zona mitigasi
- **`smcHtfHardBlock`:** `false` — Blok keras entry melawan HTF trend
- **`smcScoreAtrNorm`:** `false`* — Normalisasi skor confidence vs ATR

\* Di engine, `smcScoreAtrNorm !== false` = ON.

### AF umbrella (race)

- **`afCombinationMode`:** `"race"` — SMC / Wyckoff / VSA race-to-confirm (bukan vote 2/3)
- **`afMinVotes`:** 2 — Hanya relevan jika mode diubah ke `"vote"`

### Per trade type overrides (`SMC_LEG_TYPE_OVERRIDES`)

- **Scalping:** `atrMinMult: 0.287`, `atrGateRelative: true`, conf≥**40**, `smcSweepVolMult: 1.2`, `slAtrMult/tpAtrMult: 1.5/3.0`, `smcSessionFilter: false`, `smcBlockLongInChop: true`, `smcRequireObRetest: true`
- **Intraday:** conf≥**80**, `smcPivotStructure: true`, `slAtrMult/tpAtrMult: 1.8/3.6`, `smcSessionFilter: false`, `smcBlockAllInChop: true`
- **Swing:** `slAtrMult/tpAtrMult: 1.2/3.6`

Top-level `smcMinConfidence*` stay at 60 for **live** (live does not spread confidence from `typeOverrides` into `detectSignalMulti`). Backtest merges per-leg overrides onto cfg.

---

## Confidence Calculation

**Sequence SSOT**: `SmartMoneyConceptsStrategy.js` → `_scoreSequence`  
**Legacy SSOT**: `SmartMoneyConceptsStrategy.js` → `_componentConfidence` (when `smcUseSequenceEngine === false`)  
**Graded rubric SSOT**: `ComponentScoringEngine.js` → `scoreSmc` / `SMC_RUBRIC_*`  
**Floor SSOT**: `strategyDefaults.js` → `SMC_LEG_TYPE_OVERRIDES` + top-level `smcMinConfidence*`

### How score is built

- **Range:** 0–100 (`sequenceMeta.score` / per-leg `confA|B|C`)
- **Default path (sequence engine):** base **40** + sweep quality (sweet-spot vol ratio, up to ~14) + displacement (ATR-normalized by default via `smcScoreAtrNorm !== false`) + FVG size + mitigation depth (up to 18) + sweep freshness (+8 / +3 / −8) + OB confluence (+12) − weak displacement volume (−12) − breakout/slice-through (−15)
- **HTF align (post-score):** soft **−15** when counter-HTF (Scalping); hard block when `smcHtfHardBlock` or pair `regimeFilterRequired`
- **Legacy path:** weighted `_componentConfidence` per leg (sweep/CVD/OB for A; CHoCH/OB/CVD for B — **no EMA trendAlign**; FVG/displacement/OB for C) — capped at 100
- **Race / CSV graded overlay:** `enrichMetaWithGradedScore` recomputes 0–100 from ML features (`sweepStrength`, `fvgSizeAtr`, `obDistanceAtr`, …) using Scalping vs Intraday/Swing rubric caps
- **Aggregate:** `smcMinAggregateConfidence` default **0** (no aggregate gate)

### Per leg thresholds

### Scalping

- **Floor:** ≥**40** backtest (`SMC_LEG_TYPE_OVERRIDES.Scalping.smcMinConfidenceA`); live top-level **60** (typeOverrides not merged into live `detectSignalMulti`)
- **Formula / components:** same sequence `_scoreSequence`; optional side-specific overrides `smcMinConfidenceALong` / `AShort` (default = floor)
- **Post-gates:** CHoCH validation, chop (LONG block), OB retest, ATR gate — see [How Entry Works](#how-entry-works) (session filter OFF)

### Intraday

- **Floor:** ≥**80** (`SMC_LEG_TYPE_OVERRIDES.Intraday.smcMinConfidenceB`; top-level alias **60** for live only)
- **Formula / components:** sequence score + pivot OB confluence; tier `votingThresholdOverride` can raise B/C floor (not Scalping A)

### Swing

- **Floor:** ≥**60** (top-level `smcMinConfidenceC` / `smcMinConfidenceSwing`; no override in `SMC_LEG_TYPE_OVERRIDES.Swing`)
- **Formula / components:** sequence score; optional **V3** size tier (`smcSwingV3Gate`): block below **60**, half size **60–70**, full above **70**
- **Graded rubric:** Intraday/Swing rubric (`SMC_RUBRIC_DEFAULT`) — HTF/liquidity weighted vs Scalping rubric

---

## Risk & SL/TP (per Trade Type)

Backtest ladder SSOT: `runBacktestJob.TYPE_TF`. SL/TP resolved in `calculateRiskConfig` using per-leg `typeOverrides.slAtrMult` / `tpAtrMult` (merged from `SMC_LEG_TYPE_OVERRIDES`). Entry funnel gates (session, chop, confidence) live in [How Entry Works](#how-entry-works) — not repeated here.

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × `slAtrMult` (1.5)
- **TP method:** ATR × `tpAtrMult` (3.0)
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate 0.4–4.0 + abs floor 0.287%; OB retest required

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.8
- **TP method:** ATR × 3.6
- **ATR mult / R:R:** 1.8 / 3.6 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** conf≥80; chop blocks all sides; pivot OB

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.2
- **TP method:** ATR × 3.6
- **ATR mult / R:R:** 1.2 / 3.6 → **RR 3.0**
- **Risk %:** **2%**
- **Notes:** Optional STRONG_TREND TP boost (`strongTrendTPMult`)

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** 8
**SSOT:** `AF_COMPONENT_BASE` / `checkEntryRiskGates`

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
**Limit:** ATR range gate
**Value:** Scalping: **relative** 0.4–4.0 vs 100-bar SMA + abs 0.287%; Intraday: **absolute** ≥0.4%; Swing: **absolute** ≥0.8%
**SSOT:** `entryRiskGates.evaluateAtrEntryGate`

---
**Limit:** Position sizing
**Value:** `size = (equity × legRiskPct) / slDistance` — legRiskPct from `riskShareForType` (1% / 2% / 2%)
**SSOT:** `RealStrategyBacktestService`, `typeRiskLadder.js`

---
**Limit:** TIME_STOP
**Value:** **OFF** (no `maxHoldHours` — positions exit on SL/TP only)
**SSOT:** opt-in via `typeOverrides.*.maxHoldHours`

---

## How Entry Works

Default path uses the **sequence engine** (`smcUseSequenceEngine !== false`). All trade types run the **same causal sequence** on their own entry-TF candles; per-leg gates and confidence floors decide which legs actually open.

### Pattern (entry bar = confirmed candle `lastIdx = length−2`)

```
Liquidity Sweep → CHoCH → Displacement (FVG) → Mitigation (entry bar) → raw signal
```

**Sequence checks** (`_detectSMCSequence`), in causal order:

1. **Mitigation** — current close inside unfilled FVG (LONG: discount half; SHORT: premium half)
2. **Optional rejection wick** (`smcRejectionEntry === true`, off by default)
3. **Optional premium/discount gate** (`smcPremiumDiscountGate === true`, off by default)
4. **CHoCH** in trade direction on or before FVG origin bar
5. **Liquidity sweep** in same direction on or before CHoCH
6. **Confidence score** (0–100) must clear per-type floor

### Gate funnel (pattern → execution)

### Sequence + confidence

- **Scalping (5m):** conf≥40 (backtest merge)
- **Intraday (15m):** conf≥**80**
- **Swing (4h):** conf≥60

### Session filter

- **Scalping (5m):** **off** (`smcSessionFilter: false` — Asia block removed)
- **Intraday (15m):** **off** (`smcSessionFilter: false` — London block removed)
- **Swing (4h):** off (default)

### Chop / regime

- **Scalping (5m):** LONG blocked in CHOP
- **Intraday (15m):** **all sides** blocked in CHOP
- **Swing (4h):** off

### OB retest

- **Scalping (5m):** **required**
- **Intraday (15m):** off (default)
- **Swing (4h):** off (default)

### Pivot OB (`Fresh OB` label)

- **Scalping (5m):** off
- **Intraday (15m):** **on** (`smcPivotStructure`)
- **Swing (4h):** off

### HTF align

- **Scalping (5m):** soft −15 pts (hard if `smcHtfHardBlock` or tier)
- **Intraday (15m):** soft −15 pts
- **Swing (4h):** soft −15 pts; optional funding guard

### ATR gate

- **Scalping (5m):** relative 0.4–4.0 + abs 0.287%
- **Intraday (15m):** abs 0.4%
- **Swing (4h):** abs 0.8%

### Live money

- **Scalping (5m):** **blocked**
- **Intraday (15m):** **blocked**
- **Swing (4h):** **blocked**

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

**Legacy path** (`smcUseSequenceEngine === false`): separate single-bar detectors per leg (A/B/C). No `sequenceMeta` → **signal labels usually empty**.

- **A (Scalping):** liquidity sweep + CVD align
- **B (Intraday):** **CHoCH structure only** — direction from `_detectCHoCH`; EMA fast/slow is **not** a hard gate (Sprint 23: lagging EMA delayed early-reversal entries). Legacy conf B weights: choch 40 / obStrength 35 / cvdAlign 25
- **C (Swing):** FVG + displacement + discount/premium zone

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
- **Real money:** Blocked
- **Dry-run / backtest:** Allowed

### Swing

- **Entry TF:** 4h
- **Trend / HTF TF:** 1w
- **Real money:** Blocked
- **Dry-run / backtest:** Allowed

Backtest ladder SSOT: `runBacktestJob.TYPE_TF` (global, all strategies).  
**Walk-forward**: all SMC legs dry-run until Intraday re-validates post conf≥80 threshold sweep. Scalping remains backtest/dry-run only (global Scalping gate + SMC-specific block).

Signal labels are **identical across trade types** for a given sequence; only timeframe and which leg fired differ.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle; **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` → `BotEngine._tick()` — signal and entry both at confirmed candle close.

Backtest: fill at signal bar **close** (`RealStrategyBacktestService`).

- **`interval`:** `1h` (TF) — Live tick candle (per bot config)
- **`checkInterval`:** `3_600_000` (ms) — Minimum spacing between live ticks (~1 h)
- **`higherTf`:** `4h` (TF) — HTF trend cache (`BotEngine`)

---

## Entry signal labels

Labels derived **only** from `sequenceMeta` fields on fill.

### Label vocabulary

- **Liquidity Sweep:** Qualifying sweep preceded CHoCH — `sweepIdx >= 0`
- **CHoCH:** Change of character preceded displacement — `chochIdx >= 0`
- **Bullish FVG:** LONG bias; FVG type contains `"bull"` — `fvg.type`
- **Bearish FVG:** SHORT bias; FVG type contains `"bear"` — `fvg.type`
- **FVG:** FVG present but type unrecognized — fallback
- **Fresh OB:** Entry inside live same-bias order block — `obConfluence` (needs `smcPivotStructure`)
- **Displacement:** Displacement bar identified — `dispIdx != null`
- **Mitigation:** Formatter sees mitigation flags — usually **absent** (depth in `confidenceComponents`)

### Typical examples

- **LONG (default config):** `Liquidity Sweep, CHoCH, Bullish FVG, Displacement`
- **LONG + Intraday pivot OB:** `Liquidity Sweep, CHoCH, Fresh OB, Bullish FVG, Displacement`
- **Legacy engine:** *(empty)*

---

## AS-IS quirks

- **All legs dry-run for real money** until walk-forward clears and `liveTradeTypeGate.js` is updated.
- **Mitigation label gap**: entry trigger is FVG mitigation, but **Mitigation** label usually missing (depth in `confidenceComponents`).
- **AF umbrella**: When SMC wins the race, Wyckoff/VSA wins use their own label vocabularies.

---

## Quick reference — sequence vs labels

### Liquidity sweep

- **Drives entry?:** Yes (prerequisite)
- **Signal label?:** Yes — `Liquidity Sweep`

### CHoCH

- **Drives entry?:** Yes (prerequisite)
- **Signal label?:** Yes — `CHoCH`

### Displacement / FVG

- **Drives entry?:** Yes (prerequisite)
- **Signal label?:** Yes — `Bullish/Bearish FVG` + `Displacement`

### FVG mitigation

- **Drives entry?:** Yes (entry trigger)
- **Signal label?:** Intended `Mitigation` — usually missing

### OB confluence

- **Drives entry?:** No (quality bonus)
- **Signal label?:** Yes — `Fresh OB` when `obConfluence` true

---

*Update this file when `_detectSMCSequence` prerequisites, per-leg gates, or signal label mapping change.*
