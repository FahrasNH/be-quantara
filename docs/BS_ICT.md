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

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.08 | fraksi equity | Daily loss halt |
| `maxTradesPerDay` | 5 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 5 | menit | Cooldown after loss |
| `maxConsecLoss` | 3 | loss | Consecutive-loss stop |
| `leverage` | 1 | × | Spot-only default |

Raid-aware SL/TP: `IctStyleStrategy.calculateRiskConfig` — see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

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

## Risk & SL/TP (per Trade Type)

SL prefers **beyond raid wick** when `raid.level` is available (± 0.2×ATR buffer); otherwise ATR × 1.5. TP fixed ATR multiple. Kill-zone entry logic: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | Raid wick **or** ATR × 1.5 | ATR × 3.0 (typeOverride) / 2.5 (engine) | **RR ~1.67–2.0** | **1%** | Relative ATR gate; `ictSessionFilter`; `maxHoldHours` **2** |
| Intraday | 15m / 1h | Raid wick **or** ATR × 1.5 | ATR × 2.5 (engine) / 3.0 (merged) | **RR ~1.67–2.0** | **2%** | Abs ATR floor 0.4%; `maxHoldHours` **6** |
| Swing | 4h / 1w | Raid wick **or** ATR × 1.5 | ATR × 2.5–3.0 | **RR ~1.67–2.0** | **2%** | Abs ATR floor 0.8%; `maxHoldHours` **120** |

Parent `riskReward` 3.0 is preset nominal; engine ctor defaults 1.5 / 2.5 unless typeOverride scalping geometry applies.

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 5 | `BS_COMPONENT_BASE` |
| Cooldown after loss | 5 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 8% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

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

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

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
