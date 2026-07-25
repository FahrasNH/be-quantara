# MARKET_STRUCTURE — Entry Triggers (AS-IS)

**Scope**: What triggers a MARKET_STRUCTURE entry and the signal labels emitted on fill.  
**Strategy key**: `MARKET_STRUCTURE` (`MarketStructureStrategy`, v2.0) — label: **Dow Theory**  
**Engine SSOT**: `marketStructureEntry.js` → `evaluateMarketStructureEntry`  
**Config SSOT**: `strategyDefaults.js` → `MARKET_STRUCTURE` (inherits `TS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | preset; engine ctor 0.015 |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | TP nominal |
| `maxTradesPerDay` | 4 | trade | Cap harian |
| `leverage` | 2 | × | Leverage default |

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
