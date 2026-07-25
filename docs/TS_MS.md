# MARKET_STRUCTURE — Entry Triggers (AS-IS)

**Scope**: What triggers a MARKET_STRUCTURE entry and the signal labels emitted on fill.  
**Strategy key**: `MARKET_STRUCTURE` (`MarketStructureStrategy`, v2.0) — label: **Dow Theory**  
**Engine SSOT**: `marketStructureEntry.js` → `evaluateMarketStructureEntry`  
**Config SSOT**: `strategyDefaults.js` → `MARKET_STRUCTURE` (inherits `TS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.06 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 4 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 5 | menit | Cooldown after loss |
| `maxConsecLoss` | 3 | loss | Consecutive-loss stop |
| `leverage` | 2 | × | Default leverage |

Per-leg SL/TP: `MarketStructureStrategy.calculateRiskConfig` (default 1.5 / 3.0).

### Entry thresholds (Dow structure)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `leftLook` / `rightLook` | 2 / 2 | bar | Fractal swing confirmation |
| `scanBars` | 80 | bar | Swing scan window |
| `minSwingPairs` | 2 | pair | Minimum HH/HL or LH/LL pairs |
| `entryPullbackPct` | 0.35 | fraksi | Pullback vs last swing span |
| `entryAtrMult` | 0.75 | × ATR | Pullback tolerance (ATR preferred) |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `msSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## Risk & SL/TP (per Trade Type)

Pullback **entry zone** tolerance uses `entryAtrMult` 0.75×ATR (entry module) — distinct from **stop-loss** distance in `calculateRiskConfig`. Entry structure gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **1%** | Relative ATR gate; `msSessionFilter`; `maxHoldHours` **2** |
| Intraday | 15m / 1h | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 4 | `TS_COMPONENT_BASE` |
| Cooldown after loss | 5 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 6% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute floors 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

---

## How Entry Works

Trades **pullbacks to established swing structure** on the HTF series.

### Entry sequence

```
Classify Structure (uptrend/downtrend) → Pullback to HL/LH zone → Bounce/Reject confirm → signal
```

1. **Swing structure** — HH/HL (uptrend) or LH/LL (downtrend) from pivot swings
2. **Pullback tolerance** — price within `entryPullbackPct` / ATR of last swing low (LONG) or high (SHORT)
3. **Entry confirm** on current bar:
   - LONG: `dow_hl_pullback_bounce`
   - SHORT: `dow_lh_rally_reject`

Awaiting states do not open trades.

### Gate funnel

| Stage | Effect |
| --- | --- |
| Structure classification | hard gate |
| Pullback to swing | hard gate (no separate label) |
| Bounce/reject bar | entry trigger |
| Session filter | Scalping only (`msSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

Race mode uses HTF arrays (`highsHTF`, `lowsHTF`, `closesHTF`).

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
| `interval` | `5m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `1h` | HTF |

---

## Entry signal labels

| Side | Typical labels |
| --- | --- |
| LONG | `Swing Structure, HH/HL Pattern, Pullback Bounce, Same-Bar Confirm` |
| SHORT | `Swing Structure, HH/HL Pattern, Pullback Reject, Same-Bar Confirm` |

Pullback step has no separate label.

---

## AS-IS quirks

- **Trend Surge umbrella**: MS wins stamp `winningComponent: "MARKET_STRUCTURE"`.
- **HH/HL Pattern label** same text for uptrend and downtrend structure.

---

*Update when reason codes or label mapping change.*
