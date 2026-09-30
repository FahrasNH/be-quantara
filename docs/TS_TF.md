# TREND_FOLLOWING — Entry Triggers (AS-IS)

**Scope**: What triggers a TREND_FOLLOWING entry and the signal labels emitted on fill.  
**Strategy key**: `TREND_FOLLOWING` (`TrendFollowingStrategy`)  
**Engine SSOT**: `trendFollowingEntry.js` / `TrendFollowingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `TREND_FOLLOWING` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-09-26

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

- **`adxMinStrength`:** 25 (parent fallback) — low-TF legs override this to 30/35
- **`donchianPeriod`:** 20 (bar) — Channel breakout window
- **`minVolRatio`:** 1.0 (× vol SMA) — Volume minimum on entry TF
- **`tfRequireFreshBreakout`:** `true` — one fresh Donchian crossing per trend leg
- **`tfMtfLayerEnabled`:** `true` — causal middle layer is populated by the live/backtest adapters
- **`tfMinBreakoutBodyAtr`:** `0` — optional research filter; `0` keeps the base rule
- **`tfHtfLayerEnabled`:** `true` (bool) — HTF trend + ADX layer active
- **`htfRatio` / `mtfRatio`:** 12 / 3 (×) — Multi-TF stack ratios
- **`tsUseStructureGate`:** `false` (bool) — Dow structure overlay (MARKET_STRUCTURE)
- **`tsUseVwapPrecision`:** `false` (bool) — AMT precision overlay
- **`tsCombinationMode`:** `"race"` (enum) — TF / MS / AMT race independently

### Per trade type overrides

- **Scalping:** `5m → 1h MTF → 4h HTF`, ADX ≥ 30, `tfRequireStrongTrend: true`, 1-ATR retest, SL/TP 2/4 ATR, maker entry
- **Intraday:** `15m → 1h MTF → 4h HTF`, ADX ≥ 35, `tfRequireStrongTrend: true`, 0.5-ATR retest, SL/TP 1.5/3 ATR, maker entry
- **Swing:** `atrMinMult: 0.8`, `adxMinStrength: 20`

---

## Confidence Calculation

**Entry SSOT**: `TrendFollowingStrategy.js` → `getLastSignalMeta` (post-checklist)  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreTrendFollowing` via `TrendSurgeUmbrella.js`

### How score is built

- **Range:** 40–95 (`componentConfidence`; stored as 0–1 on meta)
- **Base:** **50** + tiered bonuses when 3-layer checklist passes:
  - HTF ADX vs `adxMinStrength` (+8 / +12 / +18)
  - Donchian broken (+8)
  - HTF trend confirmed (+6)
  - Entry-TF volume ratio (+5 / +10)
  - Bars in trend maturity (+6 sweet spot 8–40, +2 extended)
- **Clamp:** `max(40, min(95, round(score)))`
- **Graded overlay (race):** ADX strength, HTF confirm, trend maturity, EMA structure, volume, Donchian breakout — may differ slightly from inline checklist score

### Per leg thresholds

### Scalping

- **Floor:** none — checklist gates must pass before score is computed
- **Formula / components:** same bonus stack

### Intraday

- **Floor:** none
- **Formula / components:** same; `minVolRatio` 1.0 on entry TF

### Swing

- **Floor:** none
- **Formula / components:** same; `adxMinStrength` override **20** (lower ADX bar vs 25 default)

---

## Risk & SL/TP (per Trade Type)

`normalizeTfGeometryKeys` maps legacy `atrMultiplier` / `riskReward` → `slAtrMult` / `tpAtrMult` for TF only. Per-leg overrides from `STANDARD_LEG_TYPE_OVERRIDES` (Scalping gets explicit 1.5/3.0). Entry checklist: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / MTF / HTF:** 5m / 1h / 4h
- **SL method:** ATR × 2.0 (`slAtrMult`)
- **TP method:** ATR × 4.0 (`tpAtrMult`)
- **ATR mult / R:R:** 2.0 / 4.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; wait up to 12 bars for a 1-ATR pullback

### Intraday

- **Entry TF / MTF / HTF:** 15m / 1h / 4h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** Abs ATR floor 0.4%; ADX ≥ 35; wait up to 12 bars for a 0.5-ATR pullback

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** `adxMinStrength` 20 on leg

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
**Value:** **OFF** (no `maxHoldHours` — positions exit on SL/TP only)
**SSOT:** opt-in via `typeOverrides.*.maxHoldHours`

---

## How Entry Works

Three-layer trend-following checklist — every layer must pass.

### Layer sequence

```
HTF Trend Align → causal MTF Donchian Breakout → Entry-TF volume confirmation → retest fill
```

1. **HTF trend** — EMA stack + ADX ≥ `adxMinStrength` on higher timeframe
2. **Causal MTF breakout** — close breaks the prior completed MTF Donchian upper (LONG) or lower (SHORT) in HTF direction. The same completed MTF breakout is emitted once only; `tfRequireFreshBreakout` prevents re-entry while the preceding close is already outside its channel.
3. **Entry-TF confirmation**:
   - ADX strength on HTF
   - Volume ≥ `minVolRatio`
4. **Retest execution** — low-TF legs place a bounded pullback order after the
   breakout. If price does not touch within `retestTtlBars`, the setup expires;
   the engine does not chase the move.

The current entry evaluator does not require an EMA9 retest or RSI band. `tfMinBreakoutBodyAtr` can optionally require a directional breakout candle body, but remains disabled by default until walk-forward validation supports a non-zero value.

### Gate funnel

- **HTF trend + ADX:** hard gate
- **Donchian break:** hard gate
- **Retest + volume + ADX:** hard gate
- **Session filter:** **off** (`tsSessionFilter: false`)
- **ATR gate:** per-leg overrides (Swing ADX floor 20)
- **Live money:** Scalping blocked; Intraday + Swing allowed

All checklist flags set **true** on every fill → label variance minimal.

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

---

## Trade types

### Scalping

- **Entry TF:** 5m
- **Middle / Trend TF:** 1h / 4h
- **Real money:** Blocked
- **Dry-run / backtest:** Allowed

### Intraday

- **Entry TF:** 15m
- **Middle / Trend TF:** 1h / 4h
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

### Swing

- **Entry TF:** 4h
- **Trend / HTF TF:** 1w
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

Default live interval: `5m` (bot config); backtest uses the strategy-owned
Trend Following ladder (`5m/4h`, `15m/4h`, `4h/1w`) per leg.

---

## Tick open trade

- **`interval`:** `5m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `4h` (HTF)

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
