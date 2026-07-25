# SMART_MONEY_CONCEPTS — Entry Triggers (AS-IS)

**Scope**: What triggers a SMART_MONEY_CONCEPTS entry and the signal labels emitted on fill.  
**Strategy key**: `SMART_MONEY_CONCEPTS` (`SmartMoneyConceptsStrategy`, v3.0)  
**Engine SSOT**: `SmartMoneyConceptsStrategy.js` → `_detectSMCSequence`  
**Gates SSOT**: `smcEntry.js` → session / chop / OB-retest / funding helpers  
**Config SSOT**: `strategyDefaults.js` → `SMART_MONEY_CONCEPTS` + `SMC_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → `PER_STRATEGY_LIVE_ELIGIBLE_TYPES.SMART_MONEY_CONCEPTS = []`  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Nilai di bawah dari **`strategyDefaults.js`** (SSOT); gate boolean default **OFF** kecuali disebut.  
Per-leg tuning hidup di `SMC_LEG_TYPE_OVERRIDES` (bukan geometri seragam).

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined risk cap; engine ctor fallback 0.01 jika tidak di-merge |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 2.0 | × SL | Take-profit nominal (per-leg `slAtrMult`/`tpAtrMult` override) |
| `maxTradesPerDay` | 8 | trade | Batas frekuensi harian |
| `leverage` | 3 | × | Leverage default bot |

### Entry thresholds (sequence engine)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `smcUseSequenceEngine` | `true` | bool | `false` = legacy single-bar (signal labels biasanya kosong) |
| `smcMinConfidenceScalping/Intraday/Swing` (alias `A/B/C`) | 60 / 60 / 60 | 0–100 | Top-level floors (live). Backtest merges per-leg `typeOverrides` |
| `smcSeqWindow` | 60 | bar | Lookback maksimal untuk merakit sweep→CHoCH→FVG |
| `smcSweepVolMult` | 0.9 | × vol SMA | Volume minimum pada liquidity sweep |
| `smcFvgMinGap` | 0.0015 | fraksi harga | Gap FVG minimum (0.15%) |
| `smcDispVolMult` | 1.8 | × vol SMA | Volume minimum bar displacement |
| `smcOBDispMult` | 1.3 | × vol SMA | Displacement minimum order block |
| `vwapLookback` | 14 | bar | Lookback VWAP / CVD |

### Gates (opt-in — default OFF at top level)

| Parameter | Default | Efek jika `true` |
| --- | --- | --- |
| `smcPivotStructure` | `false` | CHoCH dari pivot engine; mengaktifkan label **Fresh OB** |
| `smcPremiumDiscountGate` | `false` | LONG hanya di discount / SHORT di premium |
| `smcRejectionEntry` | `false` | Wajib rejection wick di zona mitigasi |
| `smcHtfHardBlock` | `false` | Blok keras entry melawan HTF trend |
| `smcScoreAtrNorm` | `false`* | Normalisasi skor confidence vs ATR |

\* Di engine, `smcScoreAtrNorm !== false` = ON.

### AF umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `afCombinationMode` | `"race"` | SMC / Wyckoff / VSA race-to-confirm (bukan vote 2/3) |
| `afMinVotes` | 2 | Hanya relevan jika mode diubah ke `"vote"` |

### Per trade type overrides (`SMC_LEG_TYPE_OVERRIDES`)

| Leg | Key overrides |
| --- | --- |
| **Scalping** | `atrMinMult: 0.287`, `atrGateRelative: true`, conf≥**40**, `smcSweepVolMult: 1.2`, `slAtrMult/tpAtrMult: 1.5/3.0`, `maxHoldHours: 2`, `smcSessionFilter: true`, `noTradeSessions: ["Sydney","Tokyo"]`, `smcBlockLongInChop: true`, `smcRequireObRetest: true` |
| **Intraday** | conf≥**80**, `smcPivotStructure: true`, `slAtrMult/tpAtrMult: 1.8/3.6`, `maxHoldHours: 6`, `smcSessionFilter: true`, `noTradeSessions: ["London"]`, `smcBlockAllInChop: true` |
| **Swing** | `slAtrMult/tpAtrMult: 1.2/3.6`, `maxHoldHours: 120` |

Top-level `smcMinConfidence*` stay at 60 for **live** (live does not spread confidence from `typeOverrides` into `detectSignalMulti`). Backtest merges per-leg overrides onto cfg.

---

## How Entry Works

Default path uses the **sequence engine** (`smcUseSequenceEngine !== false`). All trade types run the **same causal sequence** on their own entry-TF candles; per-leg gates and confidence floors decide which legs actually open.

### Pattern (entry bar = confirmed candle `lastIdx = length−2`)

```
Liquidity Sweep → CHoCH → Displacement (FVG) → Mitigation (entry bar) → raw signal
```

**Sequence checks** (`_detectSMCSequence`), in causal order:

1. **Mitigation** — current close inside unfilled FVG (LONG: discount half; SHORT: premium half)
2. **Optional rejection wick** (`smcRejectionEntry === true`, off by default)
3. **Optional premium/discount gate** (`smcPremiumDiscountGate === true`, off by default)
4. **CHoCH** in trade direction on or before FVG origin bar
5. **Liquidity sweep** in same direction on or before CHoCH
6. **Confidence score** (0–100) must clear per-type floor

### Gate funnel (pattern → execution)

| Stage | Scalping (5m) | Intraday (15m) | Swing (4h) |
| --- | --- | --- | --- |
| Sequence + confidence | conf≥40 (backtest merge) | conf≥**80** | conf≥60 |
| Session filter | Asia block (Sydney+Tokyo) | **London** block | off (default) |
| Chop / regime | LONG blocked in CHOP | **all sides** blocked in CHOP | off |
| OB retest | **required** | off (default) | off (default) |
| Pivot OB (`Fresh OB` label) | off | **on** (`smcPivotStructure`) | off |
| HTF align | soft −15 pts (hard if `smcHtfHardBlock` or tier) | soft −15 pts | soft −15 pts; optional funding guard |
| ATR gate | relative 0.4–4.0 + abs 0.287% | abs 0.4% | abs 0.8% |
| Live money | **blocked** | **blocked** | **blocked** |

**SL/TP**: per-leg `slAtrMult`/`tpAtrMult` from `typeOverrides` → Planned RR Scalping/Intraday ~2.0, Swing ~3.0. TIME_STOP: Scalping 2h, Intraday 6h, Swing 120h.

**Legacy path** (`smcUseSequenceEngine === false`): separate single-bar detectors per leg (A/B/C). No `sequenceMeta` → **signal labels usually empty**.

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Blocked | Allowed |
| Swing | 4h | 1w | Blocked | Allowed |

Backtest ladder SSOT: `runBacktestJob.TYPE_TF` (global, all strategies).  
**Walk-forward**: all SMC legs dry-run until Intraday re-validates post conf≥80 threshold sweep. Scalping remains backtest/dry-run only (global Scalping gate + SMC-specific block).

Signal labels are **identical across trade types** for a given sequence; only timeframe and which leg fired differ.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle; **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` → `BotEngine._tick()` — signal and entry both at confirmed candle close.

Backtest: fill at signal bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `1h` | TF | Live tick candle (per bot config) |
| `checkInterval` | `3_600_000` | ms | Minimum spacing between live ticks (~1 h) |
| `higherTf` | `4h` | TF | HTF trend cache (`BotEngine`) |

---

## Entry signal labels

Labels derived **only** from `sequenceMeta` fields on fill.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Liquidity Sweep** | Qualifying sweep preceded CHoCH | `sweepIdx >= 0` |
| **CHoCH** | Change of character preceded displacement | `chochIdx >= 0` |
| **Bullish FVG** | LONG bias; FVG type contains `"bull"` | `fvg.type` |
| **Bearish FVG** | SHORT bias; FVG type contains `"bear"` | `fvg.type` |
| **FVG** | FVG present but type unrecognized | fallback |
| **Fresh OB** | Entry inside live same-bias order block | `obConfluence` (needs `smcPivotStructure`) |
| **Displacement** | Displacement bar identified | `dispIdx != null` |
| **Mitigation** | Formatter sees mitigation flags | usually **absent** (depth in `confidenceComponents`) |

### Typical examples

| Side | Example labels |
| --- | --- |
| LONG (default config) | `Liquidity Sweep, CHoCH, Bullish FVG, Displacement` |
| LONG + Intraday pivot OB | `Liquidity Sweep, CHoCH, Fresh OB, Bullish FVG, Displacement` |
| Legacy engine | *(empty)* |

---

## AS-IS quirks

- **All legs dry-run for real money** until walk-forward clears and `liveTradeTypeGate.js` is updated.
- **Mitigation label gap**: entry trigger is FVG mitigation, but **Mitigation** label usually missing (depth in `confidenceComponents`).
- **AF umbrella**: When SMC wins the race, Wyckoff/VSA wins use their own label vocabularies.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Liquidity sweep | Yes (prerequisite) | Yes — `Liquidity Sweep` |
| CHoCH | Yes (prerequisite) | Yes — `CHoCH` |
| Displacement / FVG | Yes (prerequisite) | Yes — `Bullish/Bearish FVG` + `Displacement` |
| FVG mitigation | Yes (entry trigger) | Intended `Mitigation` — usually missing |
| OB confluence | No (quality bonus) | Yes — `Fresh OB` when `obConfluence` true |

---

*Update this file when `_detectSMCSequence` prerequisites, per-leg gates, or signal label mapping change.*
