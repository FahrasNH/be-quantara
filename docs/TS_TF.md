# TREND_FOLLOWING — Entry Triggers (AS-IS)

**Scope**: What triggers a TREND_FOLLOWING entry and the signal labels emitted on fill.  
**Strategy key**: `TREND_FOLLOWING` (`TrendFollowingStrategy`)  
**Engine SSOT**: `trendFollowingEntry.js` / `TrendFollowingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `TREND_FOLLOWING` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | strategyDefaults; engine ctor 0.015 |
| `atrMultiplier` / `slMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` / `tpMultiplier` | 2.0 / 3.0 | × SL / × ATR | TP nominal RR 1:2 |
| `tpMode` | `"fixed"` | enum | Factory full TP; ctor `"partial"` if not overridden |
| `maxTradesPerDay` | 4 | trade | strategyDefaults; ctor = 3 |
| `leverage` | 2 | × | Leverage default |

### Entry thresholds (3-layer checklist)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `adxMinStrength` | 25 | ADX | Floor trend strength (HTF) |
| `donchianPeriod` | 20 | bar | Channel breakout window |
| `minVolRatio` | 1.0 | × vol SMA | Volume minimum on entry TF |
| `tfHtfLayerEnabled` | `true` | bool | HTF trend + ADX layer active |
| `htfRatio` / `mtfRatio` | 12 / 3 | × | Multi-TF stack ratios |
| `tsUseStructureGate` | `false` | bool | Dow structure overlay (MARKET_STRUCTURE) |
| `tsUseVwapPrecision` | `false` | bool | AMT precision overlay |
| `tsCombinationMode` | `"race"` | enum | TF / MS / AMT race independently |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `tsSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, `adxMinStrength: 20`, 120h hold |

---

## How Entry Works

Three-layer trend-following checklist — every layer must pass.

### Layer sequence

```
HTF Trend Align → Donchian Breakout → Entry-TF Pullback (EMA9 retest + ADX + volume) → signal
```

1. **HTF trend** — EMA stack + ADX ≥ `adxMinStrength` on higher timeframe
2. **Donchian breakout** — close breaks prior Donchian upper (LONG) or lower (SHORT) in HTF direction
3. **Entry-TF confirmation**:
   - ADX strength on HTF
   - EMA9 retest held
   - Volume ≥ `minVolRatio`
   - RSI not extreme against trend

### Gate funnel

| Stage | Effect |
| --- | --- |
| HTF trend + ADX | hard gate |
| Donchian break | hard gate |
| EMA9 retest + volume + RSI | hard gate |
| Session filter | Scalping only (`tsSessionFilter`) |
| ATR gate | per-leg overrides (Swing ADX floor 20) |
| Live money | Scalping blocked; Intraday + Swing allowed |

All checklist flags set **true** on every fill → label variance minimal.

**SL/TP**: parent geometry; per-leg TIME_STOP from `STANDARD_LEG_TYPE_OVERRIDES`.

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

Default live interval: `5m` (bot config); backtest uses `TYPE_TF` entry TF per leg.

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `5m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `1h` | HTF |

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
