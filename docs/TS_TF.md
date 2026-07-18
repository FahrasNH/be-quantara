# TREND_FOLLOWING — Entry Triggers (AS-IS)

**Scope**: What triggers a TREND_FOLLOWING entry and the signal labels emitted on fill.  
**Strategy key**: `TREND_FOLLOWING` (`TrendFollowingStrategy`)  
**Engine SSOT**: `TrendFollowingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `TREND_FOLLOWING` / `TREND_FOLLOWING` (+ ctor `TrendFollowingStrategy.js`)  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` (see below).  
Nilai di bawah dari **`strategyDefaults.js`**; beberapa knob runtime dari **engine ctor** (merge saat instantiate).

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade (strategyDefaults) |
| `atrMultiplier` / `slMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` / `tpMultiplier` | 2.0 / 3.0 | × SL / × ATR | TP = 3.0×ATR (RR 1:2) |
| `tpMode` | `"fixed"` | enum | Factory = full TP; ctor default `"partial"` jika tidak di-override |
| `maxTradesPerDay` | 4 | trade | Cap harian (strategyDefaults); ctor = 3 |
| `leverage` | 2 | × | Leverage default |

### Entry thresholds (3-layer checklist)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `adxMinStrength` | 25 | ADX | Floor trend strength (HTF) |
| `adxPeriod` | 14 | bar | ADX lookback |
| `donchianPeriod` | 20 | bar | Channel breakout window |
| `emaTrendFast` / `Mid` / `Slow` | 9 / 21 / 50 | bar | EMA stack |
| `minVolRatio` | 1.0 | × vol SMA | Volume minimum pada entry TF |
| `rsiPeriod` | 14 | bar | Momentum filter (anti-extreme) |
| `htfInterval` / `mtfInterval` / `entryInterval` | 1h / 15m / 5m | TF | Multi-TF stack |

### Gates (opt-in — default OFF)

| Parameter | Default | Efek jika `true` |
| --- | --- | --- |
| `tfHtfLayerEnabled` | `true` | HTF trend + ADX layer aktif (core TREND_FOLLOWING) |
| `tsUseStructureGate` | `false` | Dow structure gate (MARKET_STRUCTURE overlay) |
| `tsUseVwapPrecision` | `false` | VWAP/VA precision gate (AUCTION_MARKET_THEORY overlay) |
| `tsCombinationMode` | `"race"` | TREND_FOLLOWING / MARKET_STRUCTURE / AUCTION_MARKET_THEORY race independently |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrMinMult: 0.15` |
| Intraday | `atrMinMult: 0.4` |
| Swing | `atrMinMult: 0.8`, `adxMinStrength: 20` |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` / `adxMinStrength` remain live fallbacks.


### Yang bisa di-tune di FE Advance

`paramMeta`: `adxMinStrength`, `donchianPeriod`, `riskPerTrade`, `atrMultiplier`, `riskReward`, `capital`.

> **Catatan drift**: ctor `tpMode: "partial"` dan `riskPerTrade: 0.015` berbeda dari strategyDefaults factory reset — **angka tabel = SSOT factory reset**.

---

## What triggers an entry

TREND_FOLLOWING is a **three-layer trend-following checklist**. Every layer must pass before `detectSignal` returns LONG or SHORT.

```
HTF Trend Align → Donchian Breakout → Entry-TF Pullback (EMA9 retest + ADX + volume) → signal
```

**Layer sequence** (`detectSignal`):

1. **HTF trend** — EMA stack + ADX ≥ `adxMinStrength` (default 25) on higher timeframe (`detectHTFTrend`)
2. **Donchian breakout** — close breaks prior bar's Donchian upper (LONG) or lower (SHORT) in HTF direction
3. **Entry-TF confirmation** (`checkLongEntry` / `checkShortEntry`):
   - ADX strength on HTF
   - EMA9 retest held (price pulled back to fast EMA, then resumed)
   - Volume ≥ `minVolRatio` vs SMA
   - RSI not extreme against trend

All checklist flags are set **true** on every fill (`_lastEntryChecklist`). Gates that block (dead market, weak ADX) prevent the trade entirely — they do not appear as signal labels.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

`getLastSignalMeta()` stamps `component: "TREND_FOLLOWING"`; trade type comes from the multi-TF harness.

Signal labels are **nearly identical across all fills and trade types**.

---

## Tick open trade

Live path: `BotEngine._tick()` evaluates the **`interval`** candle each **`checkInterval`**, then opens at the exchange **ticker** `last` (not bar close). Backtest fills at the entry bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `5m` | TF | Signal / indicator candle polled each tick |
| `checkInterval` | `60_000` | ms | Minimum spacing between live ticks (~60 s) |
| `higherTf` | `1h` | TF | HTF trend filter (`BotEngine` HTF cache) |

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

Labels come from `entryMeta.entryChecklist` on fill.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **HTF Aligned** | HTF trend confirmed | `entryChecklist.htfTrendAligned` or `htfTrendConfirmed` |
| **ADX Strength** | ADX passes floor | `entryChecklist.adxPassed` or `adxStrength >= adxMinStrength` |
| **Donchian Break** | Channel breakout | `entryChecklist.donchianBroken` |
| **EMA9 Retest** | Pullback to fast EMA held | `entryChecklist.ema9Retest` or `emaRetestHeld` |
| **Volume Confirmation** | Volume above threshold | `entryChecklist.volumeConfirmed` |

### When each label actually appears

Because **all five gates are hard prerequisites**, nearly every TREND_FOLLOWING fill shows the full set:

`HTF Aligned, ADX Strength, Donchian Break, EMA9 Retest, Volume Confirmation`

**Variance is very low.** Direction (LONG vs SHORT) is not reflected in signal labels.

**Sparse edge case**: If `entryChecklist` is missing but `winningComponent === "TREND_FOLLOWING"`, formatter falls back to partial labels from top-level flags only.

### Typical examples

| Scenario | Example labels |
| --- | --- |
| Standard fill | `HTF Aligned, ADX Strength, Donchian Break, EMA9 Retest, Volume Confirmation` |
| Missing checklist fallback | `HTF Aligned, ADX Strength, Donchian Break` |
| No signal / missing meta | *(empty)* |

---

## AS-IS quirks

- **FORGE umbrella**: TREND_FOLLOWING race wins stamp `winningComponent: "TREND_FOLLOWING"`. MARKET_STRUCTURE / AUCTION_MARKET_THEORY wins use their own label vocabularies.
- **Checklist = all-or-nothing**: every layer is a hard gate, so label variance is minimal.
- **Direction omitted**: LONG vs SHORT not shown in signal labels.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| HTF trend + ADX | Yes | Yes — `HTF Aligned`, `ADX Strength` |
| Donchian breakout | Yes | Yes — `Donchian Break` |
| EMA9 retest | Yes | Yes — `EMA9 Retest` |
| Volume confirm | Yes | Yes — `Volume Confirmation` |

---

*Update this file when `detectSignal` gate order or signal label mapping change.*
