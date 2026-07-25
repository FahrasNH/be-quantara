# MEAN_REVERSION — Entry Triggers (AS-IS)

**Scope**: What triggers a MEAN_REVERSION entry and the signal labels emitted on fill.  
**Strategy key**: `MEAN_REVERSION` (`MeanReversionStrategy`, v3.0) — Mean Drift racer A  
**Engine SSOT**: `meanReversionEntry.js` / `MeanReversionStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `MEAN_REVERSION` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | strategyDefaults; engine ctor 0.008 |
| `atrMultiplier` / `atrMult` | 1.5 / 1.4 | × ATR | SL |
| `riskReward` | 2.0 | × SL | TP nominal RR 1:2 |
| `tpMultiplierA` / `B` | 2.5 / 2.0 | × ATR | Per-leg TP (Scalping / Intraday) |
| `maxTradesPerDay` | 3 | trade | strategyDefaults; ctor = 5 |
| `leverage` | 1.0 | × | Tanpa leverage |

### Entry thresholds (Layer A — BB + RSI + VWAP)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bbStdDevA` / `bbStdDevB` | 1.5 / 2.0 | σ | Bollinger (Scalping / Intraday) |
| `rsiOversoldA` / `OverboughtA` | 28 / 72 | RSI | Scalping extremes |
| `rsiOversoldB` / `OverboughtB` | 32 / 68 | RSI | Intraday extremes |
| `minVolRatio` | 0.8 | × vol SMA | Volume floor |
| `bbPeriod` / `rsiPeriod` | 20 / 14 | bar | Indicator windows |

### Gates (Layer B & C)

| Parameter | Default | Efek |
| --- | --- | --- |
| `mdAdxGateEnabled` | `true` | ADX regime gate aktif |
| `mdAdxBalanceMax` | 20 | ADX ≤ 20 = balance regime |
| `mdAdxImbalanceMin` | 25 | ADX ≥ 25 = imbalance (blocked) |
| `mdAdxTransitionConfidenceMult` | 0.75 | Confidence penalty di transition |
| `mdObFvgEnabled` | `true` | OB/FVG refinement aktif |
| `mdConfluenceAtrMult` | 0.5 | × ATR | Hard confluence radius |
| `mdNoConfluenceConfidenceMult` | 0.7 | fraksi | Soft miss penalty |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `mrSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## How Entry Works

Three-layer pipeline: mean-reversion signal → ADX regime gate → optional OB/FVG refinement.

### Layer A — entry signal (`detectSignal`)

| Leg | Entry TF | LONG | SHORT |
| --- | --- | --- | --- |
| Scalping | 5m | RSI < 28, close < BB(1.5σ) lower, below VWAP | RSI > 72, close > BB upper, above VWAP |
| Intraday | 15m | RSI < 32, close < BB(2.0σ) lower, below VWAP | RSI > 68, close > BB upper, above VWAP |

Scalping checked first; Intraday only if Scalping did not fire.

### Gate funnel

```
BB+RSI+VWAP extreme → volume floor → ADX regime gate → OB/FVG refine → signal
```

| Stage | Effect |
| --- | --- |
| Volume < `minVolRatio` | hard block |
| ADX imbalance (≥25) | hard block |
| ADX balance / transition | pass (transition reduces confidence) |
| OB/FVG confluence | confidence/TP boost; soft miss `OB/FVG~` |
| Session filter | Scalping only (`mrSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

**SL/TP**: per-leg TP multipliers; TIME_STOP from `STANDARD_LEG_TYPE_OVERRIDES`.

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

`getLastSignalMeta().component` stamps firing leg (Scalping/Intraday).

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `15m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `15m` | HTF |

---

## Entry signal labels

| Label | Condition |
| --- | --- |
| **RSI Extreme** | RSI past band in `reason` |
| **BB Touch** | BB reference in `reason` |
| **VWAP Dev** | VWAP side in `reason` |
| **ADX Balance** | `adxRegime` balance/transition |
| **OB/FVG Confluence** | `hasObFvgConfluence === true` or `OB/FVG✓` |

Typical: `RSI Extreme, BB Touch, VWAP Dev, ADX Balance` (+ optional OB/FVG).

---

## AS-IS quirks

- **Mean Drift umbrella**: wins stamp `winningComponent: "MEAN_REVERSION"`.
- **Soft OB/FVG miss** (`OB/FVG~`) does not produce confluence label.

---

*Update when `detectSignal` reason format or gates change.*
