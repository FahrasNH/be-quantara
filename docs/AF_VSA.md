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

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.05 | fraksi equity | Combined risk; engine ctor fallback 0.01 |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR nominal (RR 1:2) |
| `maxTradesPerDay` | 8 | trade | Batas frekuensi harian |
| `leverage` | 3 | × | Leverage default |

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

**SL/TP**: inherits `STANDARD_LEG_TYPE_OVERRIDES` geometry — Scalping RR 2.0 / 2h hold; Intraday 6h; Swing 120h.

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
