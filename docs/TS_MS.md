# MARKET_STRUCTURE — Entry Triggers (AS-IS)

**Scope**: What triggers a MARKET_STRUCTURE entry and the signal labels emitted on fill.  
**Strategy key**: `MARKET_STRUCTURE` (`MarketStructureStrategy`, v2.0) — label: **Dow Theory**  
**Engine SSOT**: `marketStructureEntry.js` → `evaluateMarketStructureEntry`  
**Config SSOT**: `strategyDefaults.js` → `MARKET_STRUCTURE` (inherits `TS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.06 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 4 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 2 (×) — Default leverage

Per-leg SL/TP: `MarketStructureStrategy.calculateRiskConfig` (default 1.5 / 3.0).

### Entry thresholds (Dow structure)

- **`leftLook` / `rightLook`:** 2 / 2 (bar) — Fractal swing confirmation
- **`scanBars`:** 80 (bar) — Swing scan window
- **`minSwingPairs`:** 2 (pair) — Minimum HH/HL or LH/LL pairs
- **`entryPullbackPct`:** 0.35 (fraksi) — Pullback vs last swing span
- **`entryAtrMult`:** 0.75 (× ATR) — Pullback tolerance (ATR preferred)

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `msSessionFilter: false`, RR 2.0 / 2h
- **Intraday:** `atrMinMult: 0.4`, 6h hold
- **Swing:** `atrMinMult: 0.8`, 120h hold

---

## Confidence Calculation

**Structure SSOT**: `marketStructureEntry.js` → `classifyMarketStructure`  
**Entry SSOT**: `marketStructureEntry.js` → `evaluateMarketStructureEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreMarketStructure` via `TrendSurgeUmbrella.js`

### How score is built

- **Structure clarity (0–1):** vote share from HH/HL vs LH/LL counts — `upVotes/total` or `downVotes/total`
- **Entry confidence (0–1):** `min(1, 0.55 + structureConfidence × 0.4)` on edge-triggered pullback bounce/reject
- **Typical fill range:** ~**0.55–0.95** depending on structure vote strength
- **Graded overlay (race):** structure clarity, pullback depth fit, swing strength, pullback confirm, HTF alignment

### Per leg thresholds

### Scalping

- **Floor:** none
- **Formula / components:** HTF structure classify → pullback within `entryAtrMult`×ATR → same-bar bounce/reject

### Intraday

- **Floor:** none
- **Formula / components:** same Dow HH/HL / LH/LL path

### Swing

- **Floor:** none
- **Formula / components:** same; wider session/week context only affects gates

---

## Risk & SL/TP (per Trade Type)

Pullback **entry zone** tolerance uses `entryAtrMult` 0.75×ATR (entry module) — distinct from **stop-loss** distance in `calculateRiskConfig`. Entry structure gates: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; `maxHoldHours` **2**

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
- **Notes:** Abs ATR floor 0.8%; `maxHoldHours` **120**

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
**Value:** Scalping: relative 0.4–4.0; Intraday/Swing: absolute floors 0.4% / 0.8%
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

Trades **pullbacks to established swing structure** on the HTF series.

### Entry sequence

```
Classify Structure (uptrend/downtrend) → Pullback to HL/LH zone → Bounce/Reject confirm → signal
```

1. **Swing structure** — HH/HL (uptrend) or LH/LL (downtrend) from pivot swings
2. **Pullback tolerance** — price within `entryPullbackPct` / ATR of last swing low (LONG) or high (SHORT)
3. **Entry confirm** on current bar:
   - LONG: `dow_hl_pullback_bounce`
   - SHORT: `dow_lh_rally_reject`

Awaiting states do not open trades.

### Gate funnel

- **Structure classification:** hard gate
- **Pullback to swing:** hard gate (no separate label)
- **Bounce/reject bar:** entry trigger
- **Session filter:** **off** (`msSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

Race mode uses HTF arrays (`highsHTF`, `lowsHTF`, `closesHTF`).

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

- **`interval`:** `5m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `1h` (HTF)

---

## Entry signal labels

- **LONG:** `Swing Structure, HH/HL Pattern, Pullback Bounce, Same-Bar Confirm`
- **SHORT:** `Swing Structure, HH/HL Pattern, Pullback Reject, Same-Bar Confirm`

Pullback step has no separate label.

---

## AS-IS quirks

- **Trend Surge umbrella**: MS wins stamp `winningComponent: "MARKET_STRUCTURE"`.
- **HH/HL Pattern label** same text for uptrend and downtrend structure.

---

*Update when reason codes or label mapping change.*
