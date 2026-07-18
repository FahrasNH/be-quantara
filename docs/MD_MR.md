# MEAN_REVERSION — Entry Triggers (AS-IS)

**Scope**: What triggers an MEAN_REVERSION entry and the signal labels emitted on fill.  
**Strategy key**: `MEAN_REVERSION` (`MeanReversionStrategy`, v3.0) — Mean Drift racer A  
**Engine SSOT**: `MeanReversionStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `MEAN_REVERSION` / `MEAN_REVERSION` (+ ctor `MeanReversionStrategy.js`)  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — MEAN_REVERSION uses `DEFAULT_LEG_TYPE_OVERRIDES` for `atrMinMult`. Risk/SL/TP dari **`strategyDefaults.js`**; layer thresholds dari **engine ctor** (merge saat runtime).

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk (strategyDefaults); ctor = 0.008 |
| `atrMultiplier` / `atrMult` | 1.5 / 1.4 | × ATR | SL — ctor 1.4× jika tidak di-override |
| `riskReward` | 2.0 | × SL | TP = 3.0×ATR nominal (RR 1:2) |
| `tpMultiplierA` / `B` | 2.5 / 2.0 | × ATR | Per-leg TP (Scalping / Intraday) |
| `maxTradesPerDay` | 3 / 5 | trade | strategyDefaults = 3; ctor = 5 |
| `leverage` | 1.0 | × | Tanpa leverage |

### Entry thresholds (Layer A — BB + RSI + VWAP)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bbStdDevA` / `bbStdDevB` | 1.5 / 2.0 | σ | Bollinger band (Scalping 5m / Intraday 15m) |
| `rsiOversoldA` / `OverboughtA` | 28 / 72 | RSI | Scalping extreme bands |
| `rsiOversoldB` / `OverboughtB` | 32 / 68 | RSI | Intraday extreme bands |
| `minVolRatio` | 0.7 / 0.8 | × vol SMA | ctor / strategyDefaults |
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

### MINT umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| *(implicit)* | race | MEAN_REVERSION / SUPPLY_AND_DEMAND / STATISTICAL_ARBITRAGE race independently |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

MEAN_REVERSION is a **three-layer pipeline**: mean-reversion signal → ADX regime gate → optional OB/FVG refinement.

```
BB + RSI + VWAP extreme → ADX Regime Gate → OB/FVG Confluence (optional) → signal
```

**Layer A — entry signal** (`detectSignal`):

| Leg | Timeframe | LONG | SHORT |
| --- | --- | --- | --- |
| Scalping | 5m | RSI < 28, close < BB(1.5σ) lower, below VWAP | RSI > 72, close > BB(1.5σ) upper, above VWAP |
| Intraday | 15m | RSI < 32, close < BB(2.0σ) lower, below VWAP | RSI > 68, close > BB(2.0σ) upper, above VWAP |

Scalping leg checked first; Intraday only if Scalping did not fire.

**Layer B — ADX gate** (`evaluateAdxRegimeGate`): blocks `imbalance` regime; `balance` / `transition` pass (transition reduces confidence).

**Layer C — OB/FVG** (`refineMdEntry`): sets `hasObFvgConfluence` and appends `OB/FVG✓` or `OB/FVG~` to `reason` string.

Volume below `minVolRatio` blocks before any layer runs.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

`getLastSignalMeta().component` is `"Scalping"` or `"Intraday"` for the firing leg — this affects TP/hold, not the label set.

---

## Tick open trade

Live path: `BotEngine._tick()` evaluates the **`interval`** candle each **`checkInterval`**, then opens at the exchange **ticker** `last` (not bar close). Backtest fills at the entry bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `15m` | TF | Signal / indicator candle polled each tick |
| `checkInterval` | `60_000` | ms | Minimum spacing between live ticks (~60 s) |
| `higherTf` | `15m` | TF | HTF trend filter (`BotEngine` HTF cache) |

**Legs that may open on live tick** (`liveTradeTypeGate.js`, real money only):

| Leg | Real money | Dry-run / backtest |
| --- | --- | --- |
| Scalping | Blocked | Allowed |
| Intraday | Allowed | Allowed |
| Swing | Allowed | Allowed |

Backtest multi-TF ladder (`runBacktestJob.TYPE_TF`): Scalping **5m/1h**, Intraday **15m/4h**, Swing **4h/1w** (global). Live tick still runs all `enabledComponents`; the gate only blocks Scalping on real money.

Live entry guards: ticker fail-closed if `getTicker` unavailable; skip when \|ticker − signal close\| > 1×ATR (`AdaptiveStrategyEngine` §11b–11c).

---

## Entry signal labels

Labels come from pipe-delimited `entryMeta.reason` + `adxRegime` + `hasObFvgConfluence`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **RSI Extreme** | RSI past oversold/overbought | `/RSI\s+[\d.]+\s*[<>]/i`, `/oversold/i`, or `/overbought/i` in `reason` |
| **BB Touch** | Bollinger band touch | `/\bBB\b/i` or `/bollinger/i` in `reason` |
| **VWAP Dev** | Price vs VWAP side | `/VWAP/i` in `reason` |
| **ADX Balance** | Regime balance/transition/imbalance | `adxRegime` is `balance`, `transition`, or `imbalance` (imbalance blocked pre-fill) |
| **OB/FVG Confluence** | Hard OB/FVG align | `hasObFvgConfluence === true` or `OB/FVG✓` in reason |
| *(no label)* | Soft OB/FVG miss | `OB/FVG~` in reason — confluence label **omitted** |

### When each label actually appears

**Most fills** include at least `RSI Extreme`, `BB Touch`, `VWAP Dev`, `ADX Balance` — all are baked into the `reason` string on signal.

**Variance between trades**:

| Factor | Effect on labels |
| --- | --- |
| ADX regime | Always `ADX Balance` label for balance/transition |
| OB/FVG | `OB/FVG Confluence` only when `hasObFvgConfluence === true` |
| Scalping vs Intraday | Same labels; raw `reason` text differs (RSI thresholds, σ band) |

### Typical examples

| Scenario | Example labels |
| --- | --- |
| Scalping + balance + OB/FVG hit | `RSI Extreme, BB Touch, VWAP Dev, ADX Balance, OB/FVG Confluence` |
| Intraday + transition + soft OB/FVG | `RSI Extreme, BB Touch, VWAP Dev, ADX Balance` |
| ADX gate block | *(no trade — empty)* |

---

## AS-IS quirks

- **MINT umbrella**: MEAN_REVERSION wins stamp `winningComponent: "MEAN_REVERSION"`. SUPPLY_AND_DEMAND / STATISTICAL_ARBITRAGE use their own label vocabularies.
- **Soft OB/FVG miss**: `OB/FVG~` in reason does not produce the confluence label.
- **strategyDefaults vs ctor drift**: `riskPerTrade`, `minVolRatio`, `maxTradesPerDay` differ between preset and engine ctor.

---

## Quick reference — pipeline vs labels

| Layer | Drives entry? | Signal label? |
| --- | --- | --- |
| RSI + BB + VWAP | Yes (trigger) | Yes — `RSI Extreme`, `BB Touch`, `VWAP Dev` |
| ADX regime gate | Yes (gate) | Yes — `ADX Balance` |
| OB/FVG confluence | No (confidence/TP) | Yes — `OB/FVG Confluence` when hard hit |

---

*Update this file when `detectSignal` reason format or signal label mapping change.*
