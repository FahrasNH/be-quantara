# SMART_MONEY_CONCEPTS — Entry Triggers (AS-IS)

**Scope**: What triggers an SMART_MONEY_CONCEPTS entry and the signal labels emitted on fill.  
**Strategy key**: `SMART_MONEY_CONCEPTS` (`SmartMoneyConceptsStrategy`, v3.0)  
**Engine SSOT**: `SmartMoneyConceptsStrategy.js` → `_detectSMCSequence`  
**Config SSOT**: `strategyDefaults.js` → `SMART_MONEY_CONCEPTS` / `SMART_MONEY_CONCEPTS` (+ engine ctor fallbacks)  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Nilai di bawah dari **`strategyDefaults.js`** (SSOT); gate boolean default **OFF** kecuali disebut.  
Per-leg ATR floors hidup di `typeOverrides` (bukan geometri seragam).

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per leg; combined cap dibagi antar komponen aktif |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 8 | trade | Batas frekuensi harian |
| `leverage` | 3 | × | Leverage default bot |

### Entry thresholds (sequence engine)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `smcUseSequenceEngine` | `true` | bool | `false` = legacy single-bar (signal labels biasanya kosong) |
| `smcMinConfidenceScalping/Intraday/Swing` (alias `A/B/C`) | 60 / 60 / 60 | 0–100 | Top-level floors (live). Backtest merges per-leg `typeOverrides` — Scalping **30**, Intraday **45** |
| `smcSeqWindow` | 60 | bar | Lookback maksimal untuk merakit sweep→CHoCH→FVG |
| `smcSweepVolMult` | 0.9 | × vol SMA | Volume minimum pada liquidity sweep |
| `smcFvgMinGap` | 0.0015 | fraksi harga | Gap FVG minimum (0.15%) |
| `smcDispVolMult` | 1.8 | × vol SMA | Volume minimum bar displacement |
| `smcOBDispMult` | 1.3 | × vol SMA | Displacement minimum order block |
| `vwapLookback` | 14 | bar | Lookback VWAP / CVD |

### Gates (opt-in — default OFF)

| Parameter | Default | Efek jika `true` |
| --- | --- | --- |
| `smcPivotStructure` | `false` | CHoCH dari pivot engine; mengaktifkan label **Fresh OB** |
| `smcPremiumDiscountGate` | `false` | LONG hanya di discount / SHORT di premium |
| `smcRejectionEntry` | `false` | Wajib rejection wick di zona mitigasi |
| `smcHtfHardBlock` | `false` | Blok keras entry melawan HTF 4h |
| `smcScoreAtrNorm` | `false`* | Normalisasi skor confidence vs ATR |

\* Di engine, `smcScoreAtrNorm !== false` = ON; FE Advance baseline memaksa `false` untuk reset bersih.

### AF umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `afCombinationMode` | `"race"` | SMC / Wyckoff / VSA race-to-confirm (bukan vote 2/3) |
| `afMinVotes` | 2 | Hanya relevan jika mode diubah ke `"vote"` |

### Per trade type overrides

| Leg | Defaults (`SMC_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | `atrMinMult: 0.15`, `smcMinConfidenceScalping/A: 30` |
| Intraday | `atrMinMult: 0.4`, `smcMinConfidenceIntraday/B: 45` |
| Swing | `atrMinMult: 0.8` |

Top-level `atrMinMult` / `smcMinConfidence*` stay at 0.8 / 60 for **live** (live does not spread confidence from `typeOverrides` into `detectSignalMulti`). Backtest merges per-leg overrides onto cfg.

### Yang bisa di-tune di FE Advance

`paramMeta`: `smcMinVotes`, `smcMinConfidenceA/B/C`, `smcSweepVolMult`, `smcOBDispMult`, `smcFvgMinGap`, `smcDispVolMult`, `vwapLookback`, `riskPerTrade`, `capital`.

> **Catatan drift**: beberapa default FE backtest (`smcSweepVolMult` 1.3, `smcFvgMinGap` 0.003) belum diselaraskan dengan BE — **angka di tabel ini = SSOT live/backtest**.

---

## What triggers an entry

Default path uses the **sequence engine** (`smcUseSequenceEngine !== false`). All trade types (Scalping / Intraday / Swing) run the **same causal sequence** on their own timeframe candles; gates and confidence floors decide which legs actually open.

```
Liquidity Sweep → CHoCH → Displacement (FVG) → Mitigation (entry bar) → signal
```

**Sequence checks** (in `_detectSMCSequence`), in causal order:

1. **Mitigation** — current close sits inside an unfilled FVG:
   - LONG: discount half `[bottom .. midpoint]`
   - SHORT: premium half `[midpoint .. top]`
2. **Optional rejection wick** (`smcRejectionEntry === true`, off by default)
3. **Optional premium/discount gate** (`smcPremiumDiscountGate === true`, off by default)
4. **CHoCH** in trade direction must occur on or before the FVG origin bar (`dispIdx`)
5. **Liquidity sweep** in the same direction must occur on or before the CHoCH
6. **Confidence score** (0–100) from leg quality; must clear per-type floor (`smcMinConfidenceA/B/C`, default 60)

Gates (HTF soft align, session filter, OB retest, dead market, etc.) can **block** a signal but do **not** add or change signal labels.

**Legacy path** (`smcUseSequenceEngine === false`): separate single-bar detectors per leg (A/B/C). No `sequenceMeta` is built → **signal labels are usually empty**.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 30m | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Backtest pairing: Scalping **5m/30m**, Intraday **15m/1h**, Swing **4h/1w**.  
Live gate: `liveTradeTypeGate.js` — Scalping excluded from real money until promoted.

**Scalping geometry SSOT** (`typeOverrides.Scalping` in `strategyDefaults.js`):
Planned RR **2.0** (SL 1.5×ATR / TP 3.0×ATR), `maxHoldHours=2` (120m TIME_STOP).
**Intraday / Swing hold SSOT**: `maxHoldHours=6` (6h TIME_STOP) and `maxHoldHours=120` (5d TIME_STOP).
Same geometry via `STANDARD_LEG_TYPE_OVERRIDES` on TS/MD/BS + AF Wyckoff/VSA (SMC uses `SMC_LEG_TYPE_OVERRIDES`).
session filter + OB retest + chop-LONG gates enabled. Do not revert to 4.5R TP
(swing target on 5m → negative expectancy).

Signal labels are **identical across trade types** for a given sequence; only timeframe and which leg fired differ.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle (`lastIdx = length−2`); **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` or explicit single `strategyKey` → `BotEngine._tick()` only. Signal and entry both at **confirmed candle close** (no ticker entry). **Generic** config-level ATR gate (`atrMinMult` / `atrMaxMult`, no per-leg `atrGateRelative` baseline unless interval maps to a leg).

Backtest (both paths): fill at the signal bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `1h` | TF | Signal / indicator candle polled each tick |
| `checkInterval` | `3_600_000` | ms | Minimum spacing between live ticks (~1 h) |
| `higherTf` | `4h` | TF | HTF trend filter (`BotEngine` HTF cache) |

**Legs that may open on live tick** (`liveTradeTypeGate.js`, real money only):

| Leg | Real money | Dry-run / backtest |
| --- | --- | --- |
| Scalping | Blocked | Allowed |
| Intraday | Allowed | Allowed |
| Swing | Allowed | Allowed |

Backtest multi-TF ladder (`runBacktestJob.TYPE_TF`): Scalping **5m/30m**, Intraday **15m/1h**, Swing **4h/1w** (global — same for every strategy). Live tick still runs all `enabledComponents`; the gate only blocks Scalping on real money.

Production ticker guards: `AdaptiveStrategyEngine` §11b–11c.

---

## Entry signal labels

Labels are derived **only** from `sequenceMeta` fields on fill. Confidence scores and gate blocks are separate concerns.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Liquidity Sweep** | A qualifying sweep preceded CHoCH | `sweepIdx >= 0` |
| **CHoCH** | Change of character preceded displacement | `chochIdx >= 0` |
| **Bullish FVG** | LONG bias; FVG type contains `"bull"` | `fvg.type` |
| **Bearish FVG** | SHORT bias; FVG type contains `"bear"` | `fvg.type` |
| **FVG** | FVG present but type unrecognized | fallback when type has no bull/bear |
| **Fresh OB** | Entry price inside a live same-bias order block | `obConfluence` / `freshOb` / `ob` |
| **Displacement** | Displacement bar identified (FVG origin) | `dispIdx != null` or displacement flags |
| **Mitigation** | Formatter sees mitigation flags | `mitigation` / `mitigated` / top-level `mitigationDepth` |

### When each label actually appears

Because sweep, CHoCH, and FVG are **hard prerequisites** of the sequence engine, nearly every filled trade includes at least:

`Liquidity Sweep, CHoCH, {Bullish|Bearish} FVG`

**Displacement** also appears on real sequence trades because `dispIdx` is always set in `sequenceMeta`.

**Variance between trades**:

| Label | Typical factory-default behavior |
| --- | --- |
| **Bullish FVG** vs **Bearish FVG** | Direction of the completed sequence |
| **Fresh OB** | Only when `obConfluence === true` — requires `smcPivotStructure === true` and price inside a pivot-tracked OB (**opt-in**, off by default) |
| **Mitigation** | Formatter checks **top-level** `mitigationDepth`; engine stores depth in `confidenceComponents.mitigationDepth` → label **usually absent** despite mitigation being the entry trigger |
| **FVG** (generic) | Rare; only if `fvg.type` is missing or non-standard |

### Typical examples

| Side | Example labels |
| --- | --- |
| LONG (default config) | `Liquidity Sweep, CHoCH, Bullish FVG, Displacement` |
| SHORT (default config) | `Liquidity Sweep, CHoCH, Bearish FVG, Displacement` |
| LONG + pivot OB confluence | `Liquidity Sweep, CHoCH, Fresh OB, Bullish FVG, Displacement` |
| Legacy engine / missing meta | *(empty)* |

---

## AS-IS quirks

- **Mitigation label gap**: entry trigger is FVG mitigation, but the **Mitigation** label is usually missing because depth lives in `confidenceComponents`, not top-level meta.
- **AF umbrella**: When SMART_MONEY_CONCEPTS wins the FOUNDRY race, Wyckoff/VSA wins use their own label vocabularies.
- **Legacy engine**: `smcUseSequenceEngine === false` produces fills with empty labels.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Liquidity sweep | Yes (prerequisite) | Yes — `Liquidity Sweep` |
| CHoCH | Yes (prerequisite) | Yes — `CHoCH` |
| Displacement / FVG formation | Yes (prerequisite) | Yes — `Bullish/Bearish FVG` + usually `Displacement` |
| FVG mitigation (entry bar) | Yes (entry trigger) | Intended `Mitigation` — **usually missing** (see above) |
| OB confluence | No (quality bonus only) | Yes — `Fresh OB` when `obConfluence` true |

---

*Update this file when `_detectSMCSequence` prerequisites or signal label mapping change.*
