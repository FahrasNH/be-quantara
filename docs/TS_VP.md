# AUCTION_MARKET_THEORY — Entry Triggers (AS-IS)

**Scope**: What triggers a AUCTION_MARKET_THEORY entry and the signal labels emitted on fill.  
**Strategy key**: `AUCTION_MARKET_THEORY` (`VolumeProfileStrategy`, v2.0) — label: **Auction Market Theory**  
**Engine SSOT**: `volumeProfileComponent.js` → `evaluateVolumeProfileEntry`  
**Config SSOT**: `strategyDefaults.js` → `AUCTION_MARKET_THEORY` (inherits `TREND_FOLLOWING`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`AUCTION_MARKET_THEORY`** preset (= Trend Following geometry); AMT-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 4 | trade | Cap harian |
| `leverage` | 2 | × | Leverage default |

### Entry thresholds (Auction Market Theory)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bins` | 20 | bin | Volume profile histogram |
| `valueAreaPct` | 0.7 | fraksi | Value Area = 70% volume |
| `vwapAtrMult` | 0.5 | × ATR | VWAP proximity tolerance |
| `vwapTolerancePct` | 0.005 | fraksi harga | Fallback VWAP tolerance (~0.5%) |
| `minSessionBars` | 20 | bar | Intraday UTC-day session floor |
| `minSessionBarsSwing` | 6 | bar | Swing UTC-week session floor |

### FORGE umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `tsCombinationMode` | `"race"` | TREND_FOLLOWING / MARKET_STRUCTURE / AUCTION_MARKET_THEORY race independently |
| `tsUseVwapPrecision` | `false` | Precision/gate path OFF in factory reset |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

AUCTION_MARKET_THEORY trades **session auction imbalances** — price reclaiming or rejecting VWAP and value-area edges.

```
Session VWAP/VA Compute → Trigger at VWAP or VA edge → signal
```

**Entry triggers** (`evaluateVolumeProfileEntry`):

| `reason` code | Direction | Condition (summary) |
| --- | --- | --- |
| `vwap_reclaim` | LONG | Close crosses back above session VWAP |
| `vwap_lose` | SHORT | Close crosses back below session VWAP |
| `val_bounce` | LONG | Rejection from Value Area Low (VAL) |
| `vah_reject` | SHORT | Rejection from Value Area High (VAH) |

Precision/gate helpers (`evaluateVolumeProfilePrecision`, `vwap_retest`, `poc_retest`) exist for rollback mode; race-mode fills use the four codes above. Session warmup and `awaiting_amt_trigger` do not open trades.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Signal labels are **one label per trade** — the trigger type. Trade type affects timeframe, not label vocabulary.

---

## Entry signal labels

Labels map directly from `entryMeta.reason` via `VP_REASON_MAP`.

### Label vocabulary

| Label | `reason` code | Direction |
| --- | --- | --- |
| **VWAP Reclaim** | `vwap_reclaim` | LONG |
| **VWAP Lose** | `vwap_lose` | SHORT |
| **VAL Bounce** | `val_bounce` | LONG |
| **VAH Reject** | `vah_reject` | SHORT |
| **VWAP Retest** | `vwap_retest` | *(precision/gate path only)* |
| **POC Retest** | `poc_retest` | *(precision/gate path only)* |

### When each label actually appears

Each fill maps to **exactly one** mapped label from the four race-mode triggers.

**Variance between trades**: which trigger fired (VWAP vs VA edge, direction).

Unmapped `reason` strings become `titleCaseSnake(raw)` — e.g. `Awaiting Amt Trigger` never appears on fills.

### Typical examples

| Trigger | Example label |
| --- | --- |
| VWAP cross up | `VWAP Reclaim` |
| VWAP cross down | `VWAP Lose` |
| VAL support | `VAL Bounce` |
| VAH resistance | `VAH Reject` |
| No signal | *(empty)* |

---

## AS-IS quirks

- **FORGE umbrella**: AUCTION_MARKET_THEORY wins stamp `winningComponent: "AUCTION_MARKET_THEORY"`.
- **Single label per fill**: unlike TREND_FOLLOWING checklist, each trade gets one trigger label.
- **Session bar floors**: Swing uses UTC-week (`minSessionBarsSwing: 6`) because 4h bars have ≤6 per UTC-day.

---

## Quick reference — trigger vs label

| Trigger | Drives entry? | Signal label |
| --- | --- | --- |
| VWAP reclaim | Yes | `VWAP Reclaim` |
| VWAP lose | Yes | `VWAP Lose` |
| VAL bounce | Yes | `VAL Bounce` |
| VAH reject | Yes | `VAH Reject` |

---

*Update this file when `evaluateVolumeProfileEntry` reason codes or `VP_REASON_MAP` change.*
