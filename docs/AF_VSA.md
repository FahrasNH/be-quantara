# VOLUME_SPREAD_ANALYSIS — Entry Triggers (AS-IS)

**Scope**: What triggers a VOLUME_SPREAD_ANALYSIS entry and the signal labels emitted on fill.  
**Strategy key**: `VOLUME_SPREAD_ANALYSIS` (`VsaStrategy`, v1.0)  
**Engine SSOT**: `vsaEntry.js` → `evaluateVSAComponent`  
**Intraday detector SSOT**: `vsaIntradayDetector.js` → `detectIntradayVsaSignal`  
**Config SSOT**: `strategyDefaults.js` → `VOLUME_SPREAD_ANALYSIS` + `VSA_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → `PER_STRATEGY_LIVE_ELIGIBLE_TYPES.VOLUME_SPREAD_ANALYSIS = []`  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Per-leg tuning hidup di `VSA_LEG_TYPE_OVERRIDES`. Risk/SL/TP dari **`AF_COMPONENT_BASE`** (inherits SMC geometry).

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.03 (fraksi equity) — Daily loss halt (realized + floating)
- **`maxTradesPerDay`:** 8 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 60 (menit) — Cooldown after any loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 3 (×) — Default bot leverage

Per-leg geometry: [`VSA_LEG_TYPE_OVERRIDES`](#risk--sltp-per-trade-type). No `calculateRiskConfig` on `VsaStrategy` — executor uses ATR fallback from `AF_COMPONENT_BASE`.

### Entry thresholds (VSA component)

- **`swingRadius`:** 5 (bar) — Jarak maksimum ke swing high/low
- **`swingLeftLook`:** 5 (bar) — Pivot swing kiri
- **`swingScanBars`:** 50 (bar) — Lookback scan swing
- **`wideSpreadMult`:** 1.3 (× ATR) — Klasifikasi spread lebar
- **`narrowSpreadMult`:** 0.7 (× ATR) — Klasifikasi spread sempit
- **`lowRelVol`:** 0.7 (× vol SMA) — Volume relatif rendah
- **`highRelVol`:** 1.5 (× vol SMA) — Volume relatif tinggi (stopping volume)
- **`mismatchSpreadMult`:** 0.5 (× ATR) — Effort/result mismatch threshold
- **`mismatchConfidencePenalty`:** 0.25 (fraksi) — Penalti confidence (bukan gate)
- **`volumeSmaPeriod`:** 20 (bar) — Volume SMA window

### Per trade type overrides (`VSA_LEG_TYPE_OVERRIDES`)

- **Scalping:** `vsaScalpingShelved: true` (hard block), `vsaSessionFilter: false`
- **Intraday:** `vsaHtfAlignGate: true`, `vsaHtfCounterPenalty: 0.5`, `vsaSessionFilter: false`, `vsaIntradayDetectorMode: "confirmation"`, `atrMinMult: 0.4`
- **Swing:** `vsaSessionFilter: false`, `vsaSwingLongOnly: true`, `vsaMinConfidenceSwing: 60`

### AF umbrella (race)

- **`afCombinationMode`:** `"race"` — SMC / Wyckoff / VSA race-to-confirm

---

## Confidence Calculation

**Entry SSOT**: `vsaEntry.js` → `evaluateVSAComponent` / `detectVSAPattern`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreVsa` via `enrichMetaWithGradedScore`  
**Floor SSOT**: `strategyDefaults.js` → `VSA_LEG_TYPE_OVERRIDES.Swing.vsaMinConfidenceSwing`

### How score is built

- **Raw range:** 0–1 on pattern bar (`signal.confidence` from volume/spread math)
- **Pattern base:** Stopping Volume → `min(1, relVol/2)`; No-Demand / No-Supply → `min(1, (lowRelVol−relVol)/lowRelVol + 0.4)`
- **Penalties (soft):** effort/result mismatch subtracts `mismatchConfidencePenalty` (**0.25** default) — never blocks entry
- **Intraday HTF gate:** LONG vs BEARISH halves confidence (`vsaHtfCounterPenalty` **0.5**); hard blocks on SHORT×BULLISH and stopping×counter
- **Graded overlay:** 0–100 from `ComponentScoringEngine` — effort vs result, volume/spread anomaly, pattern type, swing proximity, reversal context (max ~100, clamped)
- **Export field:** `meta.gradedScore` / `componentConfidence`; race uses `gradedConfidenceFromMeta` in `AdaptiveFusionUmbrella.js`

### Per leg thresholds

### Scalping

- **Floor:** none (hard block via `vsaScalpingShelved: true`)
- **Formula / components:** legacy single-bar path only if unshelved; graded score computed when signal fires

### Intraday

- **Floor:** none — graded score used for AF race ranking only
- **Formula / components:** confirmation-bar detector v2 may boost pattern confidence (~×1.05 on confirm); then graded overlay

### Swing

- **Floor:** graded ≥**60** (`vsaMinConfidenceSwing`); **Stopping Volume** reasons bypass floor (`vsa_stopping_volume_*`)
- **Formula / components:** raw pattern → HTF/session/long-only gates → `enrichMetaWithGradedScore` → floor check in `vsaEntry.js`

---

## Risk & SL/TP (per Trade Type)

VSA has **no** `calculateRiskConfig` — `RealStrategyBacktestService` applies `atrMultiplier` (1.5×) SL and `riskReward` (2.0) TP distance fallback. Scalping inherits `STANDARD_LEG_TYPE_OVERRIDES` geometry when not shelved. Entry pattern gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** —
- **TP method:** —
- **ATR mult / R:R:** —
- **Risk %:** —
- **Notes:** **`vsaScalpingShelved: true`** — hard block, no trades

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.5 (fallback)
- **TP method:** SL dist × 2.0 (`riskReward`)
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** session filter OFF; HTF align gate; confirmation-bar detector v2

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5 (fallback)
- **TP method:** SL dist × 2.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** session filter OFF; **LONG-only**; conf≥60 (Stopping Volume bypasses)

`VsaStrategy.getRiskConfig` documents ctor hints (1.2 / 2.4) but backtest/live sizing path reads merged `strategyDefaults` + fallback chain above.

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
**Limit:** ATR range gate
**Value:** Scalping: relative 0.4–4.0 (when not shelved); Intraday: abs ≥0.4%; Swing: abs ≥0.8%
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

VSA requires price **near swing structure**, then classifies the bar's **volume-spread relationship**. Intraday uses a **confirmation-bar detector v2** by default.

### Pattern detection

```
Swing Proximity → VSA Pattern → (Intraday: confirmation bar) → post-pattern gates → signal
```

**Core patterns** (`detectVSAPattern`):

### Stopping Volume

- **Swing:** low
- **Direction:** LONG

### Stopping Volume

- **Swing:** high
- **Direction:** SHORT

### No-Demand

- **Swing:** high
- **Direction:** SHORT

### No-Supply

- **Swing:** low
- **Direction:** LONG

Effort/result mismatch reduces confidence only — never blocks or adds labels.

### Intraday detector modes (`vsaIntradayDetectorMode`)

- **``confirmation` (default)`:** Pattern bar + next-bar VSA test
- **``htf_proximity``:** Pattern must sit near HTF (1h) swing
- **``sequence``:** Wyckoff climax → test within N bars
- **``hvsa``:** Trend-aligned EMA-body momentum
- **``legacy``:** Single-bar pattern at `lastIdx` (pre-v2)

### Gate funnel (pattern → execution)

### Shelved / hard block

- **Scalping:** **`vsaScalpingShelved`** → no trades
- **Intraday:** —
- **Swing:** —

### Swing proximity

- **Scalping:** required (legacy path)
- **Intraday:** v2 detector handles structure
- **Swing:** required (legacy path)

### Session filter

- **Scalping:** **off** (`vsaSessionFilter: false`)
- **Intraday:** **off** (`vsaSessionFilter: false`)
- **Swing:** **off** (`vsaSessionFilter: false`)

### HTF align gate

- **Scalping:** —
- **Intraday:** SHORT vs BULLISH blocked; stopping+counter blocked; LONG vs BEARISH confidence halved
- **Swing:** —

### Direction filter

- **Scalping:** —
- **Intraday:** —
- **Swing:** **LONG-only**

### Confidence floor

- **Scalping:** graded score
- **Intraday:** graded score
- **Swing:** conf≥60 (Stopping Volume bypasses)

### ATR gate

- **Scalping:** relative 0.4–4.0
- **Intraday:** abs 0.4%
- **Swing:** abs 0.8%

### Live money

- **Scalping:** **blocked**
- **Intraday:** **blocked**
- **Swing:** **blocked**

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

**Walk-forward**: Intraday 3-window gate **BLOCK 0/3** — all VSA legs remain dry-run only.

---

## Trade types

### Scalping

- **Entry TF:** 5m
- **Trend / HTF TF:** 1h
- **Real money:** Blocked (shelved)
- **Dry-run / backtest:** Allowed (returns `vsa_scalping_shelved`)

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

Backtest ladder SSOT: `runBacktestJob.TYPE_TF`.

---

## Tick open trade

**Production path:** `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on confirmed candle; entry at ticker `last` with stale guard.

- **`interval`:** `1h` (TF) — Live tick candle
- **`checkInterval`:** `3_600_000` (ms) — ~1 h between ticks
- **`higherTf`:** `4h` (TF) — HTF trend for align gate

---

## Entry signal labels

Labels from `entryMeta.reason` + `entryMeta.meta.nearSwing`.

- **Stopping Volume:** `vsa_stopping_volume_low` / `_high`
- **No-Demand:** `vsa_no_demand`
- **No-Supply:** `vsa_no_supply`
- **Swing Proximity:** `meta.nearSwing` truthy (legacy path fills)

### Typical examples

- **LONG (stopping volume):** `Stopping Volume, Swing Proximity`
- **SHORT (no demand):** `No-Demand, Swing Proximity`

---

## AS-IS quirks

- **All legs dry-run** — walk-forward failed post HTF-gate fixes; promote via `liveTradeTypeGate.js` after re-validation.
- **Scalping shelved** — `vsaScalpingShelved: true` returns immediately without pattern scan.
- **Intraday session profile:** historically inverted vs Scalping/Swing (London was worst; Asia best) — session blocks currently **OFF** globally.

---

## Quick reference — sequence vs labels

### Near swing structure

- **Drives entry?:** Yes (hard gate)
- **Signal label?:** Yes — `Swing Proximity`

### Stopping volume / no-demand / no-supply

- **Drives entry?:** Yes (trigger)
- **Signal label?:** Yes — pattern label

### HTF align / session / shelved

- **Drives entry?:** Yes (gate)
- **Signal label?:** No

---

*Update this file when `evaluateVSAComponent`, `vsaIntradayDetector.js`, or gate flags change.*
