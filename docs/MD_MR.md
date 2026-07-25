# MEAN_REVERSION — Entry Triggers (AS-IS)

**Scope**: What triggers a MEAN_REVERSION entry and the signal labels emitted on fill.  
**Strategy key**: `MEAN_REVERSION` (`MeanReversionStrategy`, v3.0) — Mean Drift racer A  
**Engine SSOT**: `meanReversionEntry.js` / `MeanReversionStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `MEAN_REVERSION` + `STANDARD_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.03 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 3 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 15 | menit | Cooldown after loss |
| `maxConsecLoss` | 2 | loss | Consecutive-loss stop |
| `leverage` | 1.0 | × | Spot-only default |

Per-leg SL/TP: `MeanReversionStrategy.calculateRiskConfig` + optional `tpOverride` from OB/FVG/BB mid.

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

## Risk & SL/TP (per Trade Type)

SL uses `atrMult` (1.4 ctor / 1.5 from Scalping `slAtrMult` override). TP prefers **structure target** (`tpOverride` from nearest FVG or BB middle via `resolveMdTakeProfit`) when distance ≥ 0.5× SL; else leg-specific RR multipliers. Entry BB/RSI gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | ATR × 1.5 (`slAtrMult`) | FVG/BB mid override **or** 2.5× SL (`tpMultiplierA`) **or** 3.0× ATR | 1.5 / up to 3.0 → **RR ≤ 2.0** planned | **1%** | Relative ATR gate; `mrSessionFilter`; trailing stop 0.3×ATR; `maxHoldHours` **2** |
| Intraday | 15m / 1h | ATR × 1.4 | FVG/BB override **or** 2.0× SL (`tpMultiplierB`) | ~1.4 / 2.8 → **RR ~2.0** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.5 (parent) | Override **or** 2.0× SL dist | **RR 2.0** nominal | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 3 | `MD_COMPONENT_BASE` |
| Cooldown after loss | 15 min | `cooldownAfterLoss` |
| Consecutive loss stop | 2 | `maxConsecLoss` |
| Daily loss limit | 3% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

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

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

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
