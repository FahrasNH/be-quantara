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

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.08 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 5 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 5 | menit | Cooldown after loss |
| `maxConsecLoss` | 3 | loss | Consecutive-loss stop |
| `leverage` | 1 | × | Spot-only default |
| `preferredTpMode` | `"full"` | enum | Full TP default; partial ≤33% optional |

Structure-aware SL/TP: `BreakoutTradingStrategy.calculateRiskConfig` — see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

### Entry thresholds (4-phase sequence)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `lookbackBars` | 20 | bar | High/low S&R untuk breakout |
| `volumeMultiplier` | 1.5 | × vol SMA | Volume minimum saat breakout |
| `maxVolumeRatio` | 3.55 | × vol SMA | Tolak exhaustion volume |
| `minBbWidthPct` | 0.0076 | fraksi | BB width floor |
| `minAtrPct` | 0.25 | % harga | ATR% floor |
| `minRetestBars` | 16 | bar @15m | Tunggu retest ≥4 jam |
| `retestWindow` | 96 | bar @15m | Retest ≤24 jam pasca-breakout |
| `minDisplacementAtr` | 0.30 | × ATR | Displacement post-breakout |
| `minRejectionWickRatio` | 0.5 | fraksi | Wick rejection di bar retest |
| `minRetestDepthAtr` / `maxRetestDepthAtr` | 0.17 / 0.72 | × ATR | Band kedalaman pullback |

### Gates & regime blocks

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `requireConsolidation` | `true` | Wajib lolos vol floor sebelum arm breakout |
| `blockedMarketConds` | `COILED_BREAKOUT`, `SQUEEZE_BREAKOUT`, `DRY_SQUEEZE` | Regime diblok |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `brSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## Risk & SL/TP (per Trade Type)

**Hybrid structure + ATR** SL: tighter of ATR stop vs structure stop (retest extreme ± 0.2×ATR or breakout level ± 0.25×ATR), floored at `minSlAtrFloor` 1.5×ATR. TP: structural target when on correct side, else ATR × `tpMultiplier`, **capped** at `maxPlannedRR` 2.5× actual SL distance. Pre-entry RR room checked in phase 12 ablation. Entry phases: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | Structure **or** ATR × 1.7 (min 1.5× floor) | Structural target **or** ATR × 3.2, cap **2.5R** | Planned ≤ **2.5R** | **1%** | Relative ATR gate; `brSessionFilter`; `maxHoldHours` **2** |
| Intraday | 15m / 1h | Same hybrid SL | Same capped TP | Planned ≤ **2.5R** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | Same hybrid SL | Same capped TP | Planned ≤ **2.5R** | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

Parent `riskReward` 3.0 is **nominal** — engine enforces `maxPlannedRR: 2.5`.

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 5 | `BS_COMPONENT_BASE` |
| Cooldown after loss | 5 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 8% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

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

| Stage | Effect |
| --- | --- |
| Consolidation / vol floor | hard gate |
| Blocked regimes (`COILED`/`SQUEEZE`/`DRY_SQUEEZE`) | hard block |
| Breakout volume cap (`maxVolumeRatio`) | hard block |
| Session filter | Scalping only (`brSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

Default live interval: `15m`. Backtest ladder: `runBacktestJob.TYPE_TF`.

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `15m` | TF |
| `checkInterval` | `900_000` | ms (~15 min) |
| `higherTf` | `4h` | HTF trend filter |

Production: confirmed candle signal → ticker `last` entry with stale guard.

---

## Entry signal labels

| Label | Condition |
| --- | --- |
| **BB Squeeze** | `bbSqueeze` / `consolidationConfirmed` |
| **Range Break** | `rangeBreakout` / `breakoutConfirmed` |
| **Volume Spike** | breakout volume ratio > 1 |
| **Retest Confirm** | `retestConfirmation` |

Typical fill: `BB Squeeze, Range Break, Volume Spike, Retest Confirm`

---

## AS-IS quirks

- **Breakout Storm umbrella**: wins stamp `winningComponent: "BREAKOUT_RETEST"`.
- **strategyDefaults vs ctor drift**: `maxTradesPerDay`, SL/TP multipliers differ unless overridden.
- **Direction omitted** from signal labels.

---

*Update when `detectSignal` meta flags or phase prerequisites change.*
