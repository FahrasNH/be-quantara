# VOLUME_SPREAD_ANALYSIS — Entry Triggers (AS-IS)

**Scope**: What triggers a VOLUME_SPREAD_ANALYSIS entry and the signal labels emitted on fill.  
**Strategy key**: `VOLUME_SPREAD_ANALYSIS` (`VsaStrategy`, v1.0)  
**Engine SSOT**: `vsaEntry.js` → `evaluateVSAComponent`  
**Intraday detector SSOT**: `vsaIntradayDetector.js` → `detectIntradayVsaSignal`  
**Config SSOT**: `strategyDefaults.js` → `VOLUME_SPREAD_ANALYSIS` + `VSA_LEG_TYPE_OVERRIDES`  
**Live gate SSOT**: `liveTradeTypeGate.js` → `PER_STRATEGY_LIVE_ELIGIBLE_TYPES.VOLUME_SPREAD_ANALYSIS = []`  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-25

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Per-leg tuning hidup di `VSA_LEG_TYPE_OVERRIDES`. Risk/SL/TP dari **`AF_COMPONENT_BASE`** (inherits SMC geometry).

### Global risk preset (combined cap)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined cap → split 1% / 2% / 2% per leg |
| `maxDailyLossPct` | 0.03 | fraksi equity | Daily loss halt (realized + floating) |
| `maxTradesPerDay` | 8 | trade | Per-bot daily count |
| `cooldownAfterLoss` | 60 | menit | Cooldown after any loss |
| `maxConsecLoss` | 3 | loss | Consecutive-loss stop |
| `leverage` | 3 | × | Default bot leverage |

Per-leg geometry: [`VSA_LEG_TYPE_OVERRIDES`](#risk--sltp-per-trade-type). No `calculateRiskConfig` on `VsaStrategy` — executor uses ATR fallback from `AF_COMPONENT_BASE`.

### Entry thresholds (VSA component)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `swingRadius` | 5 | bar | Jarak maksimum ke swing high/low |
| `swingLeftLook` | 5 | bar | Pivot swing kiri |
| `swingScanBars` | 50 | bar | Lookback scan swing |
| `wideSpreadMult` | 1.3 | × ATR | Klasifikasi spread lebar |
| `narrowSpreadMult` | 0.7 | × ATR | Klasifikasi spread sempit |
| `lowRelVol` | 0.7 | × vol SMA | Volume relatif rendah |
| `highRelVol` | 1.5 | × vol SMA | Volume relatif tinggi (stopping volume) |
| `mismatchSpreadMult` | 0.5 | × ATR | Effort/result mismatch threshold |
| `mismatchConfidencePenalty` | 0.25 | fraksi | Penalti confidence (bukan gate) |
| `volumeSmaPeriod` | 20 | bar | Volume SMA window |

### Per trade type overrides (`VSA_LEG_TYPE_OVERRIDES`)

| Leg | Key overrides |
| --- | --- |
| **Scalping** | `vsaScalpingShelved: true` (hard block), `vsaSessionFilter: true`, Asia block via `STANDARD_LEG_TYPE_OVERRIDES` |
| **Intraday** | `vsaHtfAlignGate: true`, `vsaHtfCounterPenalty: 0.5`, `vsaSessionFilter: true`, `noTradeSessions: ["London"]`, `vsaIntradayDetectorMode: "confirmation"`, `atrMinMult: 0.4` |
| **Swing** | `noTradeSessions: ["Sydney","Tokyo"]`, `vsaSessionFilter: true`, `vsaSwingLongOnly: true`, `vsaMinConfidenceSwing: 60` |

### AF umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `afCombinationMode` | `"race"` | SMC / Wyckoff / VSA race-to-confirm |

---

## Risk & SL/TP (per Trade Type)

VSA has **no** `calculateRiskConfig` — `RealStrategyBacktestService` applies `atrMultiplier` (1.5×) SL and `riskReward` (2.0) TP distance fallback. Scalping inherits `STANDARD_LEG_TYPE_OVERRIDES` geometry when not shelved. Entry pattern gates: [How Entry Works](#how-entry-works).

| Leg | Entry TF / HTF | SL method | TP method | ATR mult / R:R | Risk % | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Scalping | 5m / 1h | — | — | — | — | **`vsaScalpingShelved: true`** — hard block, no trades |
| Intraday | 15m / 1h | ATR × 1.5 (fallback) | SL dist × 2.0 (`riskReward`) | 1.5 / 3.0 → **RR 2.0** | **2%** | London block; HTF align gate; confirmation-bar detector v2; `maxHoldHours` **6** |
| Swing | 4h / 1w | ATR × 1.5 (fallback) | SL dist × 2.0 | 1.5 / 3.0 → **RR 2.0** | **2%** | Asia block; **LONG-only**; conf≥60 (Stopping Volume bypasses); `maxHoldHours` **120** |

`VsaStrategy.getRiskConfig` documents ctor hints (1.2 / 2.4) but backtest/live sizing path reads merged `strategyDefaults` + fallback chain above.

### Execution limits (all legs)

| Limit | Value | SSOT |
| --- | --- | --- |
| Max trades/day | 8 | `AF_COMPONENT_BASE` |
| Cooldown after loss | 60 min | `cooldownAfterLoss` |
| Consecutive loss stop | 3 | `maxConsecLoss` |
| Daily loss limit | 3% equity (incl. floating) | `maxDailyLossPct` |
| ATR range gate | Scalping: relative 0.4–4.0 (when not shelved); Intraday: abs ≥0.4%; Swing: abs ≥0.8% | `entryRiskGates.js` |
| Position sizing | `size = (equity × legRiskPct) / slDistance` | `typeRiskLadder.js` |
| TIME_STOP | Scalping 2h · Intraday 6h · Swing 120h | `STANDARD_LEG_TYPE_OVERRIDES` |

---

## How Entry Works

VSA requires price **near swing structure**, then classifies the bar's **volume-spread relationship**. Intraday uses a **confirmation-bar detector v2** by default.

### Pattern detection

```
Swing Proximity → VSA Pattern → (Intraday: confirmation bar) → post-pattern gates → signal
```

**Core patterns** (`detectVSAPattern`):

| Pattern | Swing | Direction | `reason` |
| --- | --- | --- | --- |
| Stopping Volume | low | LONG | `vsa_stopping_volume_low` |
| Stopping Volume | high | SHORT | `vsa_stopping_volume_high` |
| No-Demand | high | SHORT | `vsa_no_demand` |
| No-Supply | low | LONG | `vsa_no_supply` |

Effort/result mismatch reduces confidence only — never blocks or adds labels.

### Intraday detector modes (`vsaIntradayDetectorMode`)

| Mode | Behavior |
| --- | --- |
| `confirmation` (default) | Pattern bar + next-bar VSA test |
| `htf_proximity` | Pattern must sit near HTF (1h) swing |
| `sequence` | Wyckoff climax → test within N bars |
| `hvsa` | Trend-aligned EMA-body momentum |
| `legacy` | Single-bar pattern at `lastIdx` (pre-v2) |

### Gate funnel (pattern → execution)

| Stage | Scalping | Intraday | Swing |
| --- | --- | --- | --- |
| Shelved / hard block | **`vsaScalpingShelved`** → no trades | — | — |
| Swing proximity | required (legacy path) | v2 detector handles structure | required (legacy path) |
| Session filter | Asia (Sydney+Tokyo) | **London** block | Asia (Sydney+Tokyo) |
| HTF align gate | — | SHORT vs BULLISH blocked; stopping+counter blocked; LONG vs BEARISH confidence halved | — |
| Direction filter | — | — | **LONG-only** |
| Confidence floor | graded score | graded score | conf≥60 (Stopping Volume bypasses) |
| ATR gate | relative 0.4–4.0 | abs 0.4% | abs 0.8% |
| Live money | **blocked** | **blocked** | **blocked** |

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

**Walk-forward**: Intraday 3-window gate **BLOCK 0/3** — all VSA legs remain dry-run only.

---

## Trade types

| Type | Entry TF | Trend / HTF TF | Real money | Dry-run / backtest |
| --- | --- | --- | --- | --- |
| Scalping | 5m | 1h | Blocked (shelved) | Allowed (returns `vsa_scalping_shelved`) |
| Intraday | 15m | 1h | Blocked | Allowed |
| Swing | 4h | 1w | Blocked | Allowed |

Backtest ladder SSOT: `runBacktestJob.TYPE_TF`.

---

## Tick open trade

**Production path:** `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on confirmed candle; entry at ticker `last` with stale guard.

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `1h` | TF | Live tick candle |
| `checkInterval` | `3_600_000` | ms | ~1 h between ticks |
| `higherTf` | `4h` | TF | HTF trend for align gate |

---

## Entry signal labels

Labels from `entryMeta.reason` + `entryMeta.meta.nearSwing`.

| Label | Emitted when |
| --- | --- |
| **Stopping Volume** | `vsa_stopping_volume_low` / `_high` |
| **No-Demand** | `vsa_no_demand` |
| **No-Supply** | `vsa_no_supply` |
| **Swing Proximity** | `meta.nearSwing` truthy (legacy path fills) |

### Typical examples

| Side / pattern | Example labels |
| --- | --- |
| LONG (stopping volume) | `Stopping Volume, Swing Proximity` |
| SHORT (no demand) | `No-Demand, Swing Proximity` |

---

## AS-IS quirks

- **All legs dry-run** — walk-forward failed post HTF-gate fixes; promote via `liveTradeTypeGate.js` after re-validation.
- **Scalping shelved** — `vsaScalpingShelved: true` returns immediately without pattern scan.
- **Intraday session profile inverted** vs Scalping/Swing — London block, not Asia.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Near swing structure | Yes (hard gate) | Yes — `Swing Proximity` |
| Stopping volume / no-demand / no-supply | Yes (trigger) | Yes — pattern label |
| HTF align / session / shelved | Yes (gate) | No |

---

*Update this file when `evaluateVSAComponent`, `vsaIntradayDetector.js`, or gate flags change.*
