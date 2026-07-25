# STATISTICAL_ARBITRAGE — Entry Triggers (AS-IS)

**Scope**: What triggers a STATISTICAL_ARBITRAGE entry and the signal labels emitted on fill.  
**Strategy key**: `STATISTICAL_ARBITRAGE` (`StatisticalArbitrageStrategy`, v1.0) — Mean Drift racer #2  
**Display name**: **Statistical Arbitrage** (single-symbol z-score v1; pairs/cointegration is roadmap)  
**Engine SSOT**: `statisticalArbitrageEntry.js` → `evaluateStatisticalArbitrageEntry`  
**Config SSOT**: `strategyDefaults.js` → `STATISTICAL_ARBITRAGE` (inherits `MD_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | preset; engine ctor 0.01 |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | TP nominal |
| `maxTradesPerDay` | 3 | trade | Cap harian |
| `leverage` | 1.0 | × | Tanpa leverage |

### Entry thresholds (Statistical Arbitrage v1)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `mdSaLookback` | 40 | bar | Rolling mean/std window |
| `mdSaEntryZ` | **2.0** | σ | Minimum \|z\| untuk entry |
| `mdSaEntryZMax` | **2.5** | σ | Cap \|z\| — above = momentum, not revert |
| `mdSaExitZ` | 0.4 | σ | Mean-revert exit band |
| `mdSaMinBars` | 50 | bar | Minimum data |
| `mdSaBaseConfidence` | 0.58 | 0–1 | Confidence floor |
| `mdSaUseVwapBlend` | `true` | bool | Blend VWAP in mean |
| `mdSaSkipHtfSideways` | `true` | bool | Skip HTF 1w SIDEWAYS |
| `mdSaHtfAlignGate` | `true` | bool | No fade against HTF trend |
| `mdSaUseBenchmarkResidual` | `true` | bool | BTC-residual z when benchmark wired |
| `mdSaRequireTransitionRegime` | **`true`** (Swing) | bool | Swing edge in daily TRANSITION only |

### Modes

| Mode | Trigger |
| --- | --- |
| `rolling_mean` (default) | Z-score vs own rolling mean |
| `btc_residual` | Z-score vs rolling beta×BTC (when `benchmarkCloses` supplied) |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `saSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold, `mdSaRequireTransitionRegime: true` |

---

## How Entry Works

Fires when price deviates **statistically** from rolling mean (or BTC residual), within z-score band **2.0–2.5σ**.

### Entry sequence

```
Rolling Mean + Std → Z-Score in [entryZ, entryZMax] → HTF/regime gates → signal
```

1. Compute rolling mean/std over `mdSaLookback` (or residual vs benchmark)
2. **Z-score** `z = (price - mean) / std`
3. Entry when `entryZ ≤ |z| ≤ entryZMax`:
   - `z ≤ -entryZ` → LONG
   - `z ≥ +entryZ` → SHORT
4. `reason` like `sa_v1_{mode}_z{-2.15}_long`

### Gate funnel

| Stage | Effect |
| --- | --- |
| \|z\| < 2.0 or > 2.5 | hard block (`z_inside_band`) |
| `std_too_small` | hard block |
| HTF SIDEWAYS (1w) | skip when `mdSaSkipHtfSideways` |
| HTF align gate | block fade vs HTF trend |
| Transition regime (Swing) | required when `mdSaRequireTransitionRegime` |
| Session filter | Scalping only (`saSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

**Exit**: optional mean-revert exit when `|z| ≤ mdSaExitZ` (`mdSaExitAtMean`).

Walk-forward: SA Swing validated via dedicated walk-forward script (Gelombang 1+2 fixes).

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `15m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `15m` | HTF (Swing uses 1w in backtest harness) |

---

## Entry signal labels

Nearly every fill: `Z-Score Extreme, Mean Dev Band, Std Threshold`

Direction and exact z-value live in `reason`, not labels.

---

## AS-IS quirks

- **entryZ = 2.0, entryZMax = 2.5** — not single 1.6σ threshold.
- **Not true pairs arb** — v1 is single-symbol z-score.
- **Swing requires TRANSITION regime** in factory defaults.

---

*Update when z-score thresholds or gates change.*
