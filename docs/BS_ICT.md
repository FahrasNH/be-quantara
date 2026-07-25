# ICT_STYLE_TRADING — Entry Triggers (AS-IS)

**Scope**: What triggers an ICT_STYLE_TRADING entry and the signal labels emitted on fill.  
**Strategy key**: `ICT_STYLE_TRADING` (`IctStyleStrategy`, v1.0) — Breakout Storm racer #1  
**Engine SSOT**: `ictKillZoneRaidEntry.js` → `evaluateIctStyleEntry`  
**Config SSOT**: `strategyDefaults.js` → `ICT_STYLE_TRADING` (inherits `BS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

> Current implementation is a **subset**: kill-zone timing + liquidity raid only. MSS and OTE are **not** computed at entry time.

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.08 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 5 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 1 (×) — Spot-only default

Raid-aware SL/TP: `IctStyleStrategy.calculateRiskConfig` — see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

### Entry thresholds (Kill Zone + Liquidity Raid)

- **`bsIctRequireKillZone`:** `false` (bool) — `true` = hard gate; default soft preference
- **`bsIctSessionLookback`:** 20 (bar) — Session high/low window
- **`bsIctVolumeMult`:** 1.25 (× vol SMA) — Volume minimum pada raid
- **`bsIctMinWickBeyondPct`:** 0.0005 (fraksi) — Sweep minimum beyond level
- **`bsIctBaseConfidence`:** 0.7 (0–1) — Confidence in kill zone
- **`bsIctOutsideKzConfidence`:** 0.45 (0–1) — Confidence outside kill zone

### Kill zone windows (UTC)

- **``london_open``:** 07:00–09:00
- **``ny_open``:** 12:00–14:00
- **``london_close``:** 15:00–16:00

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `ictSessionFilter: false`, RR 2.0
- **Intraday:** `atrMinMult: 0.4`
- **Swing:** `atrMinMult: 0.8`

---

## Confidence Calculation

**Entry SSOT**: `ictKillZoneRaidEntry.js` → `evaluateIctStyleEntry`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreIct` via `BreakoutStormUmbrella.js`

### How score is built

- **Range:** 0–1 (`confidence` on fill)
- **Kill zone active:** start at `bsIctBaseConfidence` (**0.7**)
- **Outside kill zone:** start at `bsIctOutsideKzConfidence` (**0.45**) unless `bsIctRequireKillZone` hard-blocks
- **Adjustments:** soft volume miss → ×**0.85**; inside kill zone → +**0.1** (cap 1.0)
- **Graded overlay (race):** 0–100 from kill-zone timing, raid depth, MSS proxy, volume confirm, reversal quality, displacement — via `gradedConfidenceFromMeta`

### Per leg thresholds

### Scalping

- **Floor:** none — confidence ranks BS racers (BR / ICT / LS)
- **Formula / components:** same kill-zone + raid stack; `ictSessionFilter: false` (session filter OFF)

### Intraday

- **Floor:** none
- **Formula / components:** same; London/NY kill windows on entry TF timestamps

### Swing

- **Floor:** none
- **Formula / components:** same scoring path

---

## Risk & SL/TP (per Trade Type)

SL prefers **beyond raid wick** when `raid.level` is available (± 0.2×ATR buffer); otherwise ATR × 1.5. TP fixed ATR multiple. Kill-zone entry logic: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** Raid wick **or** ATR × 1.5
- **TP method:** ATR × 3.0 (typeOverride) / 2.5 (engine)
- **ATR mult / R:R:** **RR ~1.67–2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** Raid wick **or** ATR × 1.5
- **TP method:** ATR × 2.5 (engine) / 3.0 (merged)
- **ATR mult / R:R:** **RR ~1.67–2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** Raid wick **or** ATR × 1.5
- **TP method:** ATR × 2.5–3.0
- **ATR mult / R:R:** **RR ~1.67–2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.8%

Parent `riskReward` 3.0 is preset nominal; engine ctor defaults 1.5 / 2.5 unless typeOverride scalping geometry applies.

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
**Value:** **OFF** (no `maxHoldHours` — positions exit on SL/TP only)
**SSOT:** opt-in via `typeOverrides.*.maxHoldHours`

---

## How Entry Works

Combines **session kill-zone timing** with **liquidity raid** (sweep + rejection close).

### Entry sequence

```
Kill Zone Check (optional hard) → Liquidity Raid → confidence adjust → signal
```

1. **Kill zone** — bar timestamp in London / NY / London-close windows when `bsIctRequireKillZone === true`
2. **Liquidity raid**:
   - Sweep session high + close back → SHORT (`raid_high_reversal`)
   - Sweep session low + close back → LONG (`raid_low_reversal`)
3. Soft-volume variants reduce confidence but can still fill
4. `reason` e.g. `ict_raid_low_reversal_london`

### Gate funnel

- **Kill zone:** hard only if `bsIctRequireKillZone`; else confidence boost/penalty
- **Raid detection:** entry trigger
- **Session filter:** **off** (`ictSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

**Not implemented**: MSS, OTE — formatter vocabulary only.

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

Default interval: `15m`.

---

## Tick open trade

- **`interval`:** `15m` (TF)
- **`checkInterval`:** `900_000` (ms)
- **`higherTf`:** `4h` (HTF)

---

## Entry signal labels

- **Kill Zone:** `killZone.active` or session in reason
- **Liquidity Raid (Lo→Long):** raid of session low
- **Liquidity Raid (Hi→Short):** raid of session high
- **MSS** / **OTE:** **not set by engine**

Typical: `Kill Zone, Liquidity Raid (Lo→Long)` or `(Hi→Short)`.

---

## AS-IS quirks

- **`requireKillZone` default false** — soft preference unless enabled.
- **MSS / OTE not implemented** on real fills.

---

*Update when `evaluateIctStyleEntry` adds MSS/OTE or label mapping changes.*
