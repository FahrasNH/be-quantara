# MD_SA — Entry Triggers (AS-IS)

**Scope**: What triggers an MD_SA entry and the signal labels emitted on fill.  
**Strategy key**: `MD_SA` (`StatisticalArbitrageStrategy`, v1.0) — Mean Drift racer #2  
**Display name**: **Statistical Arbitrage** (single-symbol z-score v1; pairs/cointegration is roadmap)  
**Engine SSOT**: `statisticalArbitrage.js` → `evaluateStatisticalArbitrageEntry`  
**Config SSOT**: `strategyDefaults.js` → `MD_SA` (inherits `MEAN_REVERSION`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14 baseline. Risk/SL/TP dari **`MD_SA`** preset (= Mean Reversion geometry); z-score knobs dari **component DEFAULTS**.

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
| *(implicit)* | race | MD_MR / MD_SD / MD_SA race independently |

### Per trade type overrides

Tidak ada pada preset `MD_SA`.

---

## What triggers an entry

MD_SA v1 fires when price deviates **statistically** from a rolling mean (or optional BTC residual), beyond a z-score band.

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

**Formatter fallback**: If labels empty but `winningComponent === "MD_SA"`, same three-label string is returned.

### Typical examples

| Scenario | Example labels |
| --- | --- |
| Standard fill (z = -2.3) | `Z-Score Extreme, Mean Dev Band, Std Threshold` |
| BTC residual mode | `Z-Score Extreme, Mean Dev Band, Std Threshold` |
| Inside band (no trade) | *(empty)* |

---

## AS-IS quirks

- **MINT umbrella**: MD_SA wins stamp `winningComponent: "MD_SA"`.
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
