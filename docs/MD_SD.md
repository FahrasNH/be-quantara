# SUPPLY_AND_DEMAND — Entry Triggers (AS-IS)

**Scope**: What triggers an SUPPLY_AND_DEMAND entry and the signal labels emitted on fill.  
**Strategy key**: `SUPPLY_AND_DEMAND` (`SupplyDemandStrategy`, v1.0) — Mean Drift racer #1  
**Engine SSOT**: `supplyDemandEntry.js` → `evaluateSupplyDemandEntry`  
**Config SSOT**: `strategyDefaults.js` → `SUPPLY_AND_DEMAND` (inherits `MEAN_REVERSION`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`SUPPLY_AND_DEMAND`** preset (= Mean Reversion geometry); S&D-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 3 | trade | Cap harian |
| `leverage` | 1.0 | × | Tanpa leverage |

### Entry thresholds (Supply & Demand component)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `confluenceAtrMult` | 0.75 | × ATR | Radius zone retest |
| `minReversalBodyPct` | 0.35 | fraksi range | Body minimum reversal candle |
| `volConfirmMult` | 0.9 | × vol SMA | Soft volume confirm (fail-soft) |
| `scanBars` | 40 | bar | Zone scan window |
| `fvgMinGapPct` | 0.0015 | fraksi harga | FVG gap minimum |
| `obLookback` | 25 | bar | Order block lookback |
| `obDispMult` | 1.3 | × vol SMA | OB displacement volume |
| `baseConfidence` | 0.62 | 0–1 | Confidence floor dasar |

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

SUPPLY_AND_DEMAND enters on **retest of a demand or supply zone** with a reversal candle confirmation.

```
Scan OB/FVG-style Zones → Price Retest in Zone → Reversal Candle → signal
```

**Entry sequence** (`evaluateSupplyDemandEntry`):

1. Build **demand** and **supply** zones from recent displacement (OB/FVG-style zone kinds)
2. Find nearest zone within ATR radius of current price
3. **Reversal candle** required at zone (`_isReversalCandle`)
4. Prefer closer zone when both sides qualify (rare)
5. `reason` set to `sd_retest_{zoneKind}_{long|short}[_vol_ok|_vol_soft]`

Volume confirmation boosts confidence but does not add a separate signal label.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Default strategy interval is 5m; multi-TF harness stamps trade type. Signal labels are unchanged across types.

---

## Entry signal labels

Labels come from `entryMeta.zoneType` + `entryMeta.reason`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Demand Retest** | LONG at demand zone | `/demand/i` in `zoneType` or `reason` |
| **Supply Retest** | SHORT at supply zone | `/supply/i` in `zoneType` or `reason` |
| **OB/FVG Structure** | Zone is OB or FVG kind | `/fvg/i`, `/ob/i`, or `/order.?block/i` in `zoneType` or `reason` |

### When each label actually appears

**LONG demand retest** at an OB/FVG zone typically shows:

`Demand Retest, OB/FVG Structure`

**SHORT supply retest** typically shows:

`Supply Retest, OB/FVG Structure`

Only **one** of Demand/Supply Retest appears per fill (direction-specific).

**Formatter fallback quirk**: If no zone fields match but `winningComponent === "SUPPLY_AND_DEMAND"`, formatter returns all three labels — sparse meta only; normal fills include `zoneType`.

### Typical examples

| Side / zone | Example labels |
| --- | --- |
| LONG demand OB | `Demand Retest, OB/FVG Structure` |
| SHORT supply FVG | `Supply Retest, OB/FVG Structure` |
| Plain demand (no ob/fvg in zoneType) | `Demand Retest` |
| Missing meta | *(empty)* |

---

## AS-IS quirks

- **MINT umbrella**: SUPPLY_AND_DEMAND wins stamp `winningComponent: "SUPPLY_AND_DEMAND"`.
- **Reversal candle is a gate**: no separate label for reversal confirmation.
- **Formatter fallback**: can emit all three labels when meta is sparse — not typical on real fills.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Zone identification | Yes | Partial — via `OB/FVG Structure` when zone kind matches |
| Demand/supply retest | Yes (trigger) | Yes — `Demand Retest` / `Supply Retest` |
| Reversal candle | Yes (gate) | No |
| Volume confirm | No (confidence) | No |

---

*Update this file when `evaluateSupplyDemandEntry` zone kinds or signal label mapping change.*
