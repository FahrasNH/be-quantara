# LIQUIDATION_SQUEEZE — Entry Triggers (AS-IS)

**Scope**: What triggers a LIQUIDATION_SQUEEZE entry and the signal labels emitted on fill.  
**Strategy key**: `LIQUIDATION_SQUEEZE` (`LiquidationSqueezeStrategy`, v1.0) — Breakout Storm racer #2  
**Engine SSOT**: `liquidationSqueezeEntry.js` → `evaluateLiquidationSqueezeEntry`  
**Config SSOT**: `strategyDefaults.js` → `LIQUIDATION_SQUEEZE` (inherits `BS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | preset; engine ctor 0.015 |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 3.0 | × SL | TP nominal |
| `maxTradesPerDay` | 5 | trade | Cap harian |
| `leverage` | 1 | × | Tanpa leverage |

### Entry thresholds

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bsLsWickLookback` | 20 | bar | Range extreme window |
| `bsLsMinWickBodyRatio` | 1.5 | × body | Wick ≥ 1.5× body |
| `bsLsWickVolMult` | 1.2 | × vol SMA | Volume pada wick bar |
| `bsLsOiLookback` | 20 | bar | OI change lookback |
| `bsLsOiChangeConfirmPct` | 1.0 | % | \|OI change\| minimum |
| `bsLsExtremeFundingLong` | 0.0005 | rate | +0.05% / 8h funding extreme |
| `bsLsExtremeFundingShort` | -0.0005 | rate | -0.05% / 8h funding extreme |
| `bsLsBaseConfidence` | 0.55 | 0–1 | Wick-only confidence |

### OI/Funding behavior

| Behavior | Default |
| --- | --- |
| Fail-open | Wick entries fire when OI/funding unavailable |
| Funding boost | +0.2 confidence when extreme funding aligns |
| OI boost | +0.15 confidence when OI change confirms |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `lsSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## How Entry Works

Combines **liquidation-style wick displacement** with optional **OI / funding** confirmation. OI/funding is **fail-open**.

### Primary path

```
Liquidation Wick → OI/Funding Boost (optional) → signal
```

1. **Liquidation wick** — sweep beyond recent range extreme + rejection close + wick ≥ 1.5× body:
   - Sweep lows → LONG (`liquidation_wick_low_bounce`)
   - Sweep highs → SHORT (`liquidation_wick_high_reject`)
2. **Funding / OI overlay** (when available): confidence boost; reason suffix `+funding_*_squeeze`, `+oi_rising`/`+oi_falling`
3. **Funding-only path** (no wick): extreme funding + rising OI can fire

Final `reason` prefixed with `ls_`.

### Gate funnel

| Stage | Effect |
| --- | --- |
| Wick detection | primary trigger |
| OI/funding | boost or alt path; **fail-open** if missing |
| Session filter | Scalping only (`lsSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

Backtests often lack OI/funding → wick-only path dominates.

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
| `checkInterval` | `900_000` | ms |
| `higherTf` | `4h` | HTF |

---

## Entry signal labels

| Label | Condition |
| --- | --- |
| **Liquidation Wick (Bounce)** | LONG wick setup |
| **Liquidation Wick (Reject)** | SHORT wick setup |
| **Squeeze** | `squeeze` in reason |
| **OI/Funding Proxy** | OI/funding fields or `dataAvailable === false` |

Typical wick-only backtest: `Liquidation Wick (Bounce), OI/Funding Proxy`

---

## AS-IS quirks

- **Fail-open OI/funding** — missing data does not block wick entries.
- **`OI/Funding Proxy` on missing data** — label means proxy/unavailable path, not confirmed OI.

---

*Update when reason format or label mapping change.*
