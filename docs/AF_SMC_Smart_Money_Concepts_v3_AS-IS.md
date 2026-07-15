# AF_SMC — Smart Money Concepts (SAC) v3.0 — CURRENT STATE (AS-IS)

**Condition**: AS-IS from live codebase (Sprint 14 factory reset baseline)  
**Fungsi**: Referensi implementasi + decision point untuk improvement  
**Notion task**: [📘 \[STRATEGY DOC\] AF_SMC — Smart Money Concepts v3.0 (AS-IS)](https://app.notion.com/p/39e3f08d5dae81c68ef9e33f2eb27f09)  
**Doc date**: 2026-07-15

> This document describes **what the code does today**, not aspirational PRD/marketing copy. Where Notion draft numbers diverge from `strategyDefaults` / factory reset, **code wins**.

---

## Overview

| Field | AS-IS value |
| --- | --- |
| **Canonical key** | `AF_SMC` |
| **Umbrella** | Adaptive Fusion (FOUNDRY tier access bag) |
| **Engine class** | `SmartMoneyConceptsStrategy` (`version: "3.0.0"`) |
| **Registry / race** | `AdaptiveFusionUmbrella` — racers `AF_SMC` · `AF_WYCKOFF` · `AF_VSA` (default mode: **race**) |
| **Legacy aliases** | `SMART_MONEY_CONCEPTS`, `SAC`, `ADAPTIVE_FUSION` → `AF_SMC` |
| **Trade types** | Scalping · Intraday · Swing (all three exposed in Advance backtest) |
| **Risk profile** | Medium (config comment: Rendah-Sedang) |
| **Status** | ACTIVE / production (FOUNDRY); recap status **partial** (OI/CVD partial) |
| **Catalog label** | Smart Money Concepts |

### Timeframe stacks (runtime)

From `SmartMoneyConceptsStrategy.TRADE_TYPE_TF_CONFIG` (Sprint 14 factory reset):

| Type | Entry | Confirm | Trend |
| --- | --- | --- | --- |
| **Scalping** | 5m | 15m | 1h |
| **Intraday** | 15m | 1h | 4h |
| **Swing** | 4h | 1d | 1w |

Backtest `TYPE_TF` pairing: Scalping **5m/1h**, Intraday **15m/4h**, Swing **4h/1w**.

### Live vs backtest gating

`liveTradeTypeGate.js` (real money only, `dryRun === false`):

- **Live-eligible by default**: `Intraday`, `Swing`
- **Scalping**: Advance / dry-run / backtest only — **not** live until walk-forward promotes it (5m leg is unproven)

---

## Entry Logic (Current)

### Primary path — event-driven sequence engine (v3.0, default ON)

Flag: `sacUseSequenceEngine` (default `true`). Set `false` to fall back to legacy per-leg single-bar detectors A/B/C.

**Causal flow** (assembled cross-bar inside `_detectSMCSequence`):

```
Liquidity Sweep → CHoCH → Displacement / FVG → Mitigation (entry bar) → optional gates
```

Implementation order of checks (same causal guarantee: `sweepIdx ≤ chochIdx ≤ dispIdx ≤ now`):

1. **Current bar mitigates an unfilled FVG**  
   - LONG: close in discount half of FVG `[bottom .. midpoint]`  
   - SHORT: close in premium half `[midpoint .. top]`
2. **Optional rejection wick** (`sacRejectionEntry === true`) — require bounce wick ≥ body ratio; off by default
3. **Optional premium/discount gate** (`sacPremiumDiscountGate === true`) — off by default
4. **CHoCH** in the same direction must precede the FVG origin (displacement) bar
5. **Liquidity sweep** must precede the CHoCH
6. **Order Block confluence** — bonus / soft quality (not a hard sequence prerequisite). True when close sits inside a live same-bias OB (pivot path) or marked via `obConfluence`
7. **Confidence score** `_scoreSequence` (0–100) from sweep strength, displacement, FVG size, mitigation depth, sweep age, OB bonus; breakout/slice-through bars get −15

The **same** sequence signal is then offered to each enabled trade type (Scalping / Intraday / Swing) on that type’s own candles; per-type gates and confidence floors decide which legs fire.

### Legacy path (`sacUseSequenceEngine === false`)

| Leg | Letter | Detector | Idea |
| --- | --- | --- | --- |
| Scalping | A | `_detectSignalA` | Sweep + CVD sign alignment |
| Intraday | B | `_detectSignalB` | CHoCH + OB + EMA trend |
| Swing | C | `_detectSignalC` | FVG + displacement (+ premium/discount helpers) |

### Post-sequence gates (AS-IS defaults)

| Gate | Default after Sprint 14 factory reset | Notes |
| --- | --- | --- |
| HTF soft align | **ON** (−15 conf if against `htfTrend`) | Hard block only if `sacHtfHardBlock` or `tierOverrides.regimeFilterRequired` |
| Scalping CHoCH validate | **ON** (`scalpingChochValidate !== false`) | Needs swing-high **and** multi-structure (strict); `"light"` mode is opt-in |
| Entry-TF ADX (`typeOverrides.*.minAdx`) | **OFF** (`typeOverrides: {}`) | Fail-open if ADX missing |
| Session filter UTC 21–22 | **OFF** (needs `smcSessionFilter`) | Implemented in `smcScalpGates.js` |
| OB retest (Scalp/Swing) | **OFF** (needs `smcRequireObRetest`) | Rejects breakout / slice-through |
| Chop LONG block | **OFF** (needs `smcBlockLongInChop` / regime gate wiring) | `applySmcSideRegimeGate` helper exists |
| Swing funding guard | **OFF** (needs `smcFundingGuard`) | Live multi-AF can still apply when Swing flags enabled |
| Swing V3 adaptive gate | **OFF** (`sacSwingV3Gate`) | Opt-in no-trade zone + size mult |
| Intraday regimeMappingStrict / structureConfirm | **OFF** | Opt-in via `typeOverrides.Intraday` |
| Dead market | Blocks all legs when `_getMarketCondition` = `DEAD_MARKET` | |

> Notion draft “Gate: ADX ≥25 \| HTF trend alignment required” is **not** the factory-reset default. HTF is a **soft −15** unless hard-block flags fire; ADX is per-type opt-in.

### Voting / multi-leg emit

`detectSignal` (single-position path):

- `sacMinVotes` default **1** (any qualifying leg)
- Conflict LONG+SHORT → skip
- Aggregate confidence gate `sacMinAggregateConfidence` default **0** (disabled)

Umbrella race (FOUNDRY): independent racers; winner = highest confidence; tie-break `AF_SMC` → `AF_WYCKOFF` → `AF_VSA`. Attribution = winning component key only.

---

## Parameters (Live / factory defaults)

Sources: `src/config/strategyDefaults.js` → `SMART_MONEY_CONCEPTS` / `AF_SMC`, mirrored in FE `backtestStrategies.js` (Advance UI). `typeOverrides: {}`.

### Risk & geometry (canonical)

| Knob | Value | Meaning |
| --- | --- | --- |
| `riskPerTrade` | **0.01 (1%)** | Combined AF risk cap (multi-component splits share this) |
| `atrMultiplier` / `atrMult` | **1.5** | Planned SL = 1.5×ATR |
| `riskReward` | **2.0** | Planned TP = 3.0×ATR (RR **1:2**) |
| `maxDailyLossPct` | 0.03 | |
| `maxTradesPerDay` | **8** | |
| `maxConsecLoss` | **3** | |
| `cooldownAfterLoss` | 60 | |
| `leverage` | 3 | |
| `higherTf` | `4h` | HTF regime input when provided by engine |

Backtest normalizes `atrMultiplier`/`riskReward` → `slAtrMult`/`tpAtrMult` and passes them into `calculateRiskConfig`. That path is the **planned RR SSOT** for multi-position backtest/live AF.

### Class fallback SL/TP (`SUB_STRATEGIES`)

Used only when callers omit `slMultiplier`/`tpMultiplier` (legacy single-signal path). **Not** the Sprint 14 factory Planned RR:

| Type | slMultiplier | tpMultiplier | Implied RR |
| --- | --- | --- | --- |
| Scalping | 1.0 | 4.5 | 4.5 |
| Intraday | 1.2 | 2.16 | 1.8 |
| Swing | 1.2 | 4.0 | ≈3.33 |

### Confidence floors

| Knob | Factory default |
| --- | --- |
| `sacMinConfidenceA` (Scalping) | **60** |
| `sacMinConfidenceB` (Intraday) | **60** |
| `sacMinConfidenceC` (Swing) | **60** |

Optional asymmetric Scalping: `sacMinConfidenceALong` / `sacMinConfidenceAShort`. Tier `votingThresholdOverride` can raise Intraday/Swing floors (Scalping intentionally kept at base A to avoid starving the 5m score band).

### Sequence detector knobs (BE `strategyDefaults`)

| Knob | Default |
| --- | --- |
| `sacUseSequenceEngine` | `true` |
| `sacSeqWindow` | 60 |
| `sacSwingLookback` | 5 |
| `sacSweepScanBars` | 50 |
| `sacSweepVolMult` | 0.9 |
| `sacOBLookback` | 15 |
| `sacOBDispMult` | 1.3 |
| `sacChochLookback` | 20 |
| `sacFvgMinGap` | 0.0015 |
| `sacFvgScanBars` | 40 |
| `sacDispScanBars` | 25 |
| `sacDispVolMult` | 1.8 |
| `sacDispRangePct` | 0.008 |
| `vwapLookback` | 14 |
| `sacEnabledComponents` | `["A","B","C"]` |

**FE Advance defaults drift** (intentional UI baseline, not identical to BE constants): e.g. `sacSweepVolMult: 1.3`, `sacFvgMinGap: 0.003`, `sacDispVolMult: 2.0`, `sacScoreAtrNorm: false`. BE sequence scorer treats `sacScoreAtrNorm !== false` as ATR-normalized (ON) unless FE/config overrides.

### EMA / RSI / ATR shared fields

`emaFast/Slow/Trend` 9/21/50 · `rsiPeriod` 14 · `atrPeriod` 14 · `sidewaysThresholdPct` 0.15

---

## Entry Reasons (CSV / export)

Formatter: `formatSmcReasons` in `src/server/services/csv/strategyReasonFormatters.js`.

Labels emitted from `sequenceMeta` when present:

| Label | Condition |
| --- | --- |
| `Liquidity Sweep` | `sweepIdx >= 0` |
| `CHoCH` | `chochIdx >= 0` |
| `Fresh OB` | `obConfluence` / `freshOb` / `ob` |
| `Bullish FVG` / `Bearish FVG` / `FVG` | `fvg.type` |
| `Displacement` | `dispIdx` / displacement flags |
| `Mitigation` | mitigation flags / `mitigationDepth` |

Hard-gate caveat (documented in formatter): sweep + CHoCH + FVG are sequence prerequisites, so most trades share the same base labels; variance mainly comes from FVG direction and OB confluence.

### Sprint 13 ML / forensic CSV columns (optional attach)

From `SMC_ML_CSV_COLUMNS` in `smcScalpGates.js`: Sweep Strength, FVG Size ATR, OB Distance ATR, Displacement %, HTF ADX, Hour UTC, Volume Ratio, BB Width, Funding Rate At Entry, Funding Forecast 24h, Hold Hours, plus confidence component passthroughs.

---

## Umbrella & catalog wiring (AS-IS map)

| Concern | Location |
| --- | --- |
| Keys / migration / tier map | `src/config/strategies.js` |
| Numeric defaults | `src/config/strategyDefaults.js` (`SMART_MONEY_CONCEPTS` → `AF_SMC`) |
| PDF recap + runtime trade types | `src/config/strategyRecapCatalog.js` |
| Supported trade types | `src/shared/constants/strategySupportedTypes.js` → all three |
| Live type gate | `src/config/liveTradeTypeGate.js` |
| Sequence + legs | `src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy.js` |
| Scalp/Swing helpers | `src/core/strategy-engine/smc/smcScalpGates.js` |
| FOUNDRY race | `src/core/strategy-engine/umbrellas/AdaptiveFusionUmbrella.js` |
| Registry | `src/core/strategy-engine/StrategyRegistry.js` |
| FE Advance presets | `fe-bot-trading/src/constants/backtestStrategies.js` |
| FE tier labels | `fe-bot-trading/src/utils/tierStrategyMap.js` |
| Dataset expand scripts | `scripts/smc-scalping-dataset-expand.js`, `scripts/smc-swing-dataset-expand.js` |

Concept string (recap catalog):

> Liquidity sweeps, BOS/CHoCH, displacement, order blocks, fair value gaps, premium/discount.

Indicators string: Market structure, swing H/L, session H/L, volume, OI (partial), CVD (partial).

---

## Known Issues (still relevant AS-IS)

1. **Scalping 5m: no proven edge** — historical WR ~28.6% (below coin-flip) → kept **backtest/dry-run only** via `liveTradeTypeGate`.
2. **Chop / sideways bleed** — soft HTF −15 alone is insufficient; daily regime / chop-LONG helpers exist but are **off** in factory `typeOverrides: {}`.
3. **Breakout / slice-through entries** — mitigation-on-close can fire while price is cutting through the FVG; rejection-wick and OB-retest gates exist but are **opt-in**.
4. **Confidence inversion history** — raw “bigger is better” rewarded chase bars; Sprint 13 `sweetSpotPts` recalibration is in `_scoreSequence`, but high conf still needs ongoing forensics (CSV conf components).
5. **Config drift surfaces** — BE vs FE detector knobs differ; `SUB_STRATEGIES` aspirational RR ≠ factory Planned RR 1:2; some ARCHITECTURE.md sections still describe pre–Sprint-14 typeOverrides / “Intraday removed”.
6. **Partial TP ladder / fee drag** — short Scalping stops amplify fee-R; widening SL was previously used as a fee lever (now reset to uniform 1.5/3.0 geometry).
7. **HTF warm-up / EMA50** — longer HTF stacks need enough history (historical Swing EMA50 / warm-up bugs fixed in earlier sprints; still a data-requirement constraint).

---

## Performance (Last Known — research memory, not re-run here)

| TF / Type | WR (approx) | PF (approx) | Notes |
| --- | --- | --- | --- |
| 15m Scalp-era / short TF | 27–30% | ~0.8 | Edge-clear / weak |
| 5m Scalping (new stack) | ~28.6% historically | &lt;1 | Unproven → live gated |
| Best shorter TF pocket | 35–40% | ~1.0 | Best WR band in older studies |
| 4h Swing | 28–32% | ~1.15 | Longer walk-forward citations |

**Live qualitative**: chop months bleed; strong trend regimes historically +120 to +200 (memory from prior sprint reviews — re-validate before product claims).

---

## Next Steps (If Adjust) — decision backlog, not implemented

- Regime gate: daily + 4h ADX proxy (and/or enable `smcBlockLongInChop` by default after A/B)
- Confidence floor experiments (e.g. 65→70) with walk-forward, not gut feel
- HTF soft (−15) vs hard block trade-off — measure fewer LONGs vs bleed
- Re-enable selective Sprint 13 gates (session, OB retest, funding) **only** after factory-reset baseline is measured
- Promote Scalping to live only after 5-window walk-forward passes

---

## Code SSOT checklist (for reviewers)

- [x] Canonical key `AF_SMC` + aliases mapped in `strategies.js`
- [x] Sequence engine default ON (`sacUseSequenceEngine`)
- [x] Factory Planned RR **1:2** (SL 1.5×ATR / TP 3.0×ATR), `typeOverrides: {}`
- [x] Trade types: all three in backtest; live = Intraday + Swing
- [x] Entry reason labels match `formatSmcReasons`
- [x] Umbrella race default (`afCombinationMode: "race"`)

---

*AS-IS snapshot for Sprint 14 strategy documentation. Update this file when factory defaults, gates, or TF stacks change.*
