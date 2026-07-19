# STATISTICAL_ARBITRAGE — Entry Triggers (AS-IS)

**Scope**: What triggers an STATISTICAL_ARBITRAGE entry and the signal labels emitted on fill.  
**Strategy key**: `STATISTICAL_ARBITRAGE` (`StatisticalArbitrageStrategy`, v1.0) — Mean Drift racer #2  
**Display name**: **Statistical Arbitrage** (single-symbol z-score v1; pairs/cointegration is roadmap)  
**Engine SSOT**: `statisticalArbitrage.js` → `evaluateStatisticalArbitrageEntry`  
**Config SSOT**: `strategyDefaults.js` → `STATISTICAL_ARBITRAGE` (inherits `MEAN_REVERSION`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`STATISTICAL_ARBITRAGE`** preset (= Mean Reversion geometry); z-score knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 3 | trade | Cap harian |
| `leverage` | 1.0 | × | Tanpa leverage |

### Entry thresholds (Statistical Arbitrage v1)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `lookback` / `mdSaLookback` | 40 | bar | Rolling mean/std window |
| `entryZ` / `mdSaEntryZ` | 1.6 | σ | Minimum \|z\| untuk entry |
| `exitZ` | 0.4 | σ | Mean-revert exit band |
| `minBars` | 50 | bar | Minimum data sebelum evaluasi |
| `baseConfidence` | 0.58 | 0–1 | Confidence floor dasar |
| `useVwapBlend` | `true` | bool | Blend VWAP dalam mean calculation |

### Modes

| Mode | Trigger |
| --- | --- |
| `rolling_mean` (default) | Z-score vs own rolling mean |
| `btc_residual` | Z-score vs rolling beta×BTC benchmark (when `benchmarkCloses` supplied) |

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

STATISTICAL_ARBITRAGE v1 fires when price deviates **statistically** from a rolling mean (or optional BTC residual), beyond a z-score band.

```
Rolling Mean + Std → Z-Score Extreme → Mean-Revert Direction → signal
```

**Entry sequence** (`evaluateStatisticalArbitrageEntry`):

1. Compute rolling mean and standard deviation over `lookback` closes (or residual vs benchmark)
2. **Z-score** `z = (price - mean) / std`
3. Entry when `|z| ≥ entryZ` (default 1.6):
   - `z ≤ -entryZ` → LONG (overshoot below mean)
   - `z ≥ +entryZ` → SHORT (overshoot above mean)
4. `reason` like `sa_v1_{mode}_z{-2.15}_long`

`z_inside_band` and `std_too_small` block without opening.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Signal labels are the same across trade types; z-score magnitude varies per fill.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle (`lastIdx = length−2`); **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` or explicit single `strategyKey` → `BotEngine._tick()` only. Signal and entry both at **confirmed candle close** (no ticker entry). **Generic** config-level ATR gate (`atrMinMult` / `atrMaxMult`, no per-leg `atrGateRelative` baseline unless interval maps to a leg).

Backtest (both paths): fill at the signal bar **close** (`RealStrategyBacktestService`).

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

Production ticker guards: `AdaptiveStrategyEngine` §11b–11c.

---

## Entry signal labels

Labels come from `entryMeta.zScore`, `entryMeta.saMode`, `entryMeta.reason`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Z-Score Extreme** | Z-score computed or cited | `zScore` finite, or `/z.?score/i` in `reason` |
| **Mean Dev Band** | Mean deviation context | `meanDevBand` / `meanDeviation` set, or `/mean.?dev/i` in `reason` |
| **Std Threshold** | Std band / mode active | `stdThreshold` set, `/std/i` in `reason`, or `saMode` present |

### When each label actually appears

On normal fills, `zScore` and `saMode` are always set → formatter emits **all three labels**:

`Z-Score Extreme, Mean Dev Band, Std Threshold`

**Variance is very low** — nearly every trade shows the same trio. Direction and exact z-value live in `reason`, not signal labels.

**Formatter fallback**: If labels empty but `winningComponent === "STATISTICAL_ARBITRAGE"`, same three-label string is returned.

### Typical examples

| Scenario | Example labels |
| --- | --- |
| Standard fill (z = -2.3) | `Z-Score Extreme, Mean Dev Band, Std Threshold` |
| BTC residual mode | `Z-Score Extreme, Mean Dev Band, Std Threshold` |
| Inside band (no trade) | *(empty)* |

---

## AS-IS quirks

- **MINT umbrella**: STATISTICAL_ARBITRAGE wins stamp `winningComponent: "STATISTICAL_ARBITRAGE"`.
- **entryZ = 1.6** (not 2.0) — older docs overstated the threshold.
- **Not true pairs arb**: v1 is single-symbol z-score; multi-leg cointegration is roadmap.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Z-score beyond band | Yes (trigger) | Yes — `Z-Score Extreme` |
| Rolling mean deviation | Yes (implicit) | Yes — `Mean Dev Band` |
| Std / mode threshold | Yes (implicit) | Yes — `Std Threshold` |

---

*Update this file when `evaluateStatisticalArbitrageEntry` thresholds or signal label mapping change.*
