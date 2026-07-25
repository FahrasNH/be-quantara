# ICT_STYLE_TRADING — Entry Triggers (AS-IS)

**Scope**: What triggers an ICT_STYLE_TRADING entry and the signal labels emitted on fill.  
**Strategy key**: `ICT_STYLE_TRADING` (`IctStyleStrategy`, v1.0) — Breakout Storm racer #1  
**Engine SSOT**: `ictKillZoneRaidEntry.js` → `evaluateIctStyleEntry`  
**Config SSOT**: `strategyDefaults.js` → `ICT_STYLE_TRADING` (inherits `BS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-07-25

> Current implementation is a **subset**: kill-zone timing + liquidity raid only. MSS and OTE are **not** computed at entry time.

---

## Default Config (Factory Reset)

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | preset; engine ctor 0.015 |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 3.0 | × SL | TP nominal RR 1:3 |
| `maxTradesPerDay` | 5 | trade | Cap harian |
| `leverage` | 1 | × | Tanpa leverage |

### Entry thresholds (Kill Zone + Liquidity Raid)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bsIctRequireKillZone` | `false` | bool | `true` = hard gate; default soft preference |
| `bsIctSessionLookback` | 20 | bar | Session high/low window |
| `bsIctVolumeMult` | 1.25 | × vol SMA | Volume minimum pada raid |
| `bsIctMinWickBeyondPct` | 0.0005 | fraksi | Sweep minimum beyond level |
| `bsIctBaseConfidence` | 0.7 | 0–1 | Confidence in kill zone |
| `bsIctOutsideKzConfidence` | 0.45 | 0–1 | Confidence outside kill zone |

### Kill zone windows (UTC)

| Zone | Window (UTC) |
| --- | --- |
| `london_open` | 07:00–09:00 |
| `ny_open` | 12:00–14:00 |
| `london_close` | 15:00–16:00 |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `ictSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## How Entry Works

Combines **session kill-zone timing** with **liquidity raid** (sweep + rejection close).

### Entry sequence

```
Kill Zone Check (optional hard) → Liquidity Raid → confidence adjust → signal
```

1. **Kill zone** — bar timestamp in London / NY / London-close windows when `bsIctRequireKillZone === true`
2. **Liquidity raid**:
   - Sweep session high + close back → SHORT (`raid_high_reversal`)
   - Sweep session low + close back → LONG (`raid_low_reversal`)
3. Soft-volume variants reduce confidence but can still fill
4. `reason` e.g. `ict_raid_low_reversal_london`

### Gate funnel

| Stage | Effect |
| --- | --- |
| Kill zone | hard only if `bsIctRequireKillZone`; else confidence boost/penalty |
| Raid detection | entry trigger |
| Session filter | Scalping only (`ictSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

**Not implemented**: MSS, OTE — formatter vocabulary only.

**SL/TP**: inherits BS geometry; per-leg TIME_STOP from `STANDARD_LEG_TYPE_OVERRIDES`.

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

Default interval: `15m`.

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
| **Kill Zone** | `killZone.active` or session in reason |
| **Liquidity Raid (Lo→Long)** | raid of session low |
| **Liquidity Raid (Hi→Short)** | raid of session high |
| **MSS** / **OTE** | **not set by engine** |

Typical: `Kill Zone, Liquidity Raid (Lo→Long)` or `(Hi→Short)`.

---

## AS-IS quirks

- **`requireKillZone` default false** — soft preference unless enabled.
- **MSS / OTE not implemented** on real fills.

---

*Update when `evaluateIctStyleEntry` adds MSS/OTE or label mapping changes.*
