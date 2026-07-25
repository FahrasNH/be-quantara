# SUPPLY_AND_DEMAND — Entry Triggers (AS-IS)

**Scope**: What triggers a SUPPLY_AND_DEMAND entry and the signal labels emitted on fill.  
**Strategy key**: `SUPPLY_AND_DEMAND` (`SupplyDemandStrategy`, v1.0) — Mean Drift racer #1  
**Engine SSOT**: `supplyDemandEntry.js` → `evaluateSupplyDemandEntry`  
**Config SSOT**: `strategyDefaults.js` → `SUPPLY_AND_DEMAND` (inherits `MD_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.03 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 3 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 15 | menit | Cooldown after loss |
| `maxConsecLoss` | 2 | loss | Consecutive-loss stop |
| `leverage` | 1.0 | × | Spot-only default |

Per-leg SL/TP: `SupplyDemandStrategy.calculateRiskConfig` + zone/FVG `tpOverride`.

### Entry thresholds

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `mdSdConfluenceAtrMult` | 0.75 | × ATR | Radius zone retest |
| `mdSdMinReversalBodyPct` / `minReversalBodyPct` | 0.35 | fraksi | Body minimum reversal candle |
| `mdSdVolConfirmMult` | 0.9 | × vol SMA | Soft volume confirm |
| `mdSdScanBars` | 40 | bar | Zone scan window |
| `mdSdFvgMinGapPct` | 0.0015 | fraksi | FVG gap minimum |
| `mdSdObLookback` | 25 | bar | Order block lookback |
| `mdSdObDispMult` | 1.3 | × vol SMA | OB displacement volume |
| `mdSdBaseConfidence` | 0.62 | 0–1 | Confidence floor |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `sdSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## Risk & SL/TP (per Trade Type)

Zone **retest radius** uses `mdSdConfluenceAtrMult` 0.75×ATR (entry) — not the SL distance. TP prefers nearest opposing FVG/structure via `resolveMdTakeProfit`. Entry zone gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | ATR × 1.5 (`slAtrMult`) | FVG/structure override **or** ATR × 2.5 | 1.5 / 2.5 → **RR ~1.67** | **1%** | Relative ATR gate; `sdSessionFilter`; `maxHoldHours` **2** |
| Intraday | 15m / 1h | ATR × 1.4 (engine default) | Override **or** ATR × 2.5 | 1.4 / 2.5 → **RR ~1.79** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.4 | Override **or** ATR × 2.5 | **RR ~1.79** | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 3 | `MD_COMPONENT_BASE` |
| Cooldown after loss | 15 min | `cooldownAfterLoss` |
| Consecutive loss stop | 2 | `maxConsecLoss` |
| Daily loss limit | 3% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

---

## How Entry Works

Enters on **retest of demand or supply zone** with reversal candle confirmation.

### Entry sequence

```
Scan OB/FVG Zones → Price Retest in Zone → Reversal Candle → signal
```

1. Build **demand** and **supply** zones from recent displacement (OB/FVG-style)
2. Find nearest zone within ATR radius of current price
3. **Reversal candle** required at zone
4. Prefer closer zone when both sides qualify
5. `reason` = `sd_retest_{zoneKind}_{long|short}[_vol_ok|_vol_soft]`

### Gate funnel

| Stage | Effect |
| --- | --- |
| Zone proximity | hard gate |
| Reversal candle | hard gate |
| Volume confirm | confidence boost only |
| Session filter | Scalping only (`sdSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

Volume confirmation does not add a separate signal label.

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
| `higherTf` | `15m` | HTF |

---

## Entry signal labels

| Label | Condition |
| --- | --- |
| **Demand Retest** | LONG at demand zone |
| **Supply Retest** | SHORT at supply zone |
| **OB/FVG Structure** | zone kind is OB or FVG |

Typical LONG: `Demand Retest, OB/FVG Structure`

Reversal candle is a gate — no separate label.

---

## AS-IS quirks

- **Mean Drift umbrella**: wins stamp `winningComponent: "SUPPLY_AND_DEMAND"`.
- **Formatter fallback** can emit all three labels when meta sparse — not typical on real fills.

---

*Update when zone kinds or label mapping change.*
