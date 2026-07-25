# AUCTION_MARKET_THEORY — Entry Triggers (AS-IS)

**Scope**: What triggers an AUCTION_MARKET_THEORY entry and the signal labels emitted on fill.  
**Strategy key**: `AUCTION_MARKET_THEORY` (`VolumeProfileStrategy`, v2.0) — label: **Auction Market Theory**  
**Engine SSOT**: `volumeProfileEntry.js` → `evaluateVolumeProfileEntry`  
**Config SSOT**: `strategyDefaults.js` → `AUCTION_MARKET_THEORY` (inherits `TS_COMPONENT_BASE`)  
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

Per-leg SL/TP: `VolumeProfileStrategy.calculateRiskConfig` (1.5 / 3.0).

### Entry thresholds (Auction Market Theory)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bins` | 20 | bin | Volume profile histogram |
| `valueAreaPct` | 0.7 | fraksi | Value Area = 70% volume |
| `vwapAtrMult` | 0.5 | × ATR | VWAP proximity tolerance |
| `vwapTolerancePct` | 0.005 | fraksi | Fallback VWAP tolerance (~0.5%) |
| `minSessionBars` | 20 | bar | Intraday UTC-day session floor |
| `minSessionBarsSwing` | 6 | bar | Swing UTC-week session floor |

### Per trade type overrides

| Leg | Overrides |
| --- | --- |
| Scalping | `atrGateRelative: true`, `amtSessionFilter: true`, RR 2.0 / 2h |
| Intraday | `atrMinMult: 0.4`, 6h hold |
| Swing | `atrMinMult: 0.8`, 120h hold |

---

## Risk & SL/TP (per Trade Type)

Session **VWAP proximity** for entries uses `vwapAtrMult` 0.5×ATR — separate from SL/TP distances below. Entry triggers: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **1%** | Relative ATR gate; `amtSessionFilter`; UTC-day session; `maxHoldHours` **2** |
| Intraday | 15m / 1h | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **2%** | `minSessionBars` 20; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.5 | ATR × 3.0 | 1.5 / 3.0 → **RR 2.0** | **2%** | UTC-**week** session (`minSessionBarsSwing` 6); `maxHoldHours` **120** |

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 4 | `TS_COMPONENT_BASE` |
| Cooldown after loss | 5 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 6% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

---

## How Entry Works

Trades **session auction imbalances** — price reclaiming or rejecting VWAP and value-area edges.

### Entry triggers

```
Session VWAP/VA Compute → Trigger at VWAP or VA edge → signal
```

| `reason` code | Direction | Condition |
| --- | --- | --- |
| `vwap_reclaim` | LONG | Close crosses back above session VWAP |
| `vwap_lose` | SHORT | Close crosses back below session VWAP |
| `val_bounce` | LONG | Rejection from Value Area Low (VAL) |
| `vah_reject` | SHORT | Rejection from Value Area High (VAH) |

Precision helpers (`vwap_retest`, `poc_retest`) exist for rollback mode; race-mode fills use the four codes above.

### Gate funnel

| Stage | Effect |
| --- | --- |
| Session warmup (`minSessionBars`) | hard gate |
| `awaiting_amt_trigger` | no trade |
| Session filter | Scalping only (`amtSessionFilter`) |
| ATR gate | per-leg overrides |
| Live money | Scalping blocked; Intraday + Swing allowed |

Swing uses UTC-week session (`minSessionBarsSwing: 6`) because 4h bars have ≤6 per UTC-day.

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked | Allowed |
| Intraday | 15m | 1h | Allowed | Allowed |
| Swing | 4h | 1w | Allowed | Allowed |

Each fill maps to **exactly one** trigger label.

---

## Tick open trade

| Parameter | Default | Unit |
| --- | --- | --- |
| `interval` | `5m` | TF |
| `checkInterval` | `60_000` | ms |
| `higherTf` | `1h` | HTF |

---

## Entry signal labels

| Label | `reason` | Direction |
| --- | --- | --- |
| **VWAP Reclaim** | `vwap_reclaim` | LONG |
| **VWAP Lose** | `vwap_lose` | SHORT |
| **VAL Bounce** | `val_bounce` | LONG |
| **VAH Reject** | `vah_reject` | SHORT |
| **VWAP Retest** / **POC Retest** | precision path only | — |

---

## AS-IS quirks

- **Trend Surge umbrella**: AMT wins stamp `winningComponent: "AUCTION_MARKET_THEORY"`.
- **Single label per fill** — unlike TF checklist multi-label fills.
- **`tsUseVwapPrecision` default false** in factory reset.

---

*Update when `evaluateVolumeProfileEntry` reason codes or `VP_REASON_MAP` change.*
