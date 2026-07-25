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

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.03 | fraksi equity | Daily loss halt (realized + floating) |
| `maxTradesPerDay` | 8 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 60 | menit | Cooldown after any loss |
| `maxConsecLoss` | 3 | loss | Consecutive-loss stop |
| `leverage` | 3 | × | Default bot leverage |
| `minRr` | 2.0 | R | Minimum planned RR in entry checklist (moderate/conservative) |

Signal meta carries **structure-based** SL/TP; see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

### Entry thresholds (Wyckoff component)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `entryModel` | `"aggressive"` | enum | `moderate` / `conservative` = checklist lebih ketat |
| `lookback` | 100 | bar | Indikator & volume SMA window |
| `rangeLookback` | 20 | bar | Horizontal range S/R |
| `minBarsInRange` | 20 | bar | Range harus mature |
| `minRangeWidthPct` / `maxRangeWidthPct` | 0.005 / 0.05 | fraksi harga | Lebar range valid |
| `bbWidthPercentileMax` | 40 | percentile | Kompresi BB width untuk trading range |
| `penetrationAtrMult` | 0.8 | × ATR | Kedalaman spring/upthrust minimum |
| `recoveryWindow` | 5 | bar | Window reclaim setelah manipulasi |
| `volumeConfirmMult` | 1.0 | × vol SMA | Konfirmasi volume pada event |
| `cooldownBars` | 5 | bar | Jeda antar sinyal |

### Gates (entry model layers)

| Model | Extra checklist layers |
| --- | --- |
| `aggressive` (default) | `tradingRange`, `manipulation`, `reclaimOrReject`, `volumeConfirm` |
| `moderate` | + `priorTrend`, `rejection`, `choch`, `proximityOk`, `rrOk` |
| `conservative` | + `climaxOrWeakening`, `sosOrSow`, `lpsOrLpsy` |

Backtest default: `runBacktestJob.js` forces `entryModel: "aggressive"` when unset.

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `wyckoffSessionFilter: true`, Asia block, RR 2.0 / 2h hold |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## Risk & SL/TP (per Trade Type)

Wyckoff embeds **structure SL/TP in signal meta** (`wyckoffEntry.js`): LONG spring → SL at invalidation (below spring) / TP at `rangeHigh`; SHORT upthrust → SL at invalidation / TP at `rangeLow`. LPS/LPSY continuation uses range boundary invalidation with opposite range target. `WyckoffStrategy` has **no** `calculateRiskConfig` — backtest executor falls back to ATR × 1.5 SL and `riskReward` 2.0 TP unless meta levels are wired by the umbrella winner path. Entry checklist gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | **Structure**: spring/upthrust invalidation level | **Structure**: opposite range boundary | Meta RR ≥ `minRr` 2.0; fallback 1.5× / 3.0× ATR | **1%** | Relative ATR gate; Asia session block; `maxHoldHours` **2** |
| Intraday | 15m / 1h | Structure invalidation (meta) | Opposite range edge (meta) | Planned RR from meta; fallback **RR 2.0** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | Structure invalidation (meta) | Opposite range edge (meta) | Planned RR from meta; fallback **RR 2.0** | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 8 | `AF_COMPONENT_BASE` |
| Cooldown after loss | 60 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 3% equity (incl. floating) | `maxDailyLossPct` |
| Signal cooldown | 5 bars between Wyckoff signals | `cooldownBars` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday: abs ≥0.4%; Swing: abs ≥0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

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

| Stage | All legs |
| --- | --- |
| Trading range valid | hard gate |
| Spring / Upthrust | entry trigger |
| Checklist (model-dependent) | hard gate |
| Session filter | Scalping only (`wyckoffSessionFilter`) |
| ATR gate | per-leg `atrMinMult` / relative band |
| Cooldown | `cooldownBars` between signals |
| Live money | Scalping blocked; Intraday + Swing allowed |

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

---

## Tick open trade

**Production path:** `AdaptiveStrategyEngine._tick()` — confirmed candle signal, ticker entry with stale guard.

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `1h` | TF | Live tick candle |
| `checkInterval` | `3_600_000` | ms | ~1 h between ticks |
| `higherTf` | `4h` | TF | HTF trend filter |

---

## Entry signal labels

| Label | Emitted when |
| --- | --- |
| **Spring** | `reason === "wyckoff_spring"` |
| **Upthrust** | `reason === "wyckoff_upthrust"` |
| **LPS** / **LPSY** / **LPS/LPSY** | checklist flags (moderate/conservative) |
| **SOS** / **SOW** | `checklist.sosOrSow` + side |
| **Volume Climax** | volume confirm / climax flags |

**Aggressive model** — most fills: `Spring` or `Upthrust` only.

---

## AS-IS quirks

- **AF umbrella**: Wyckoff wins stamp `winningComponent: "WYCKOFF"`.
- **Backtest forces aggressive** — aligns with factory reset.
- **Low label variance on aggressive** — direction (Spring vs Upthrust) is main difference.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Valid trading range | Yes (gate) | No |
| Spring / Upthrust | Yes (trigger) | Yes |
| SOS / SOW / LPS | Model-dependent | Yes when flagged |
| Volume confirm | Yes (checklist) | Yes — `Volume Climax` when flagged |

---

*Update this file when `evaluateEntryChecklist` prerequisites or signal label mapping change.*
