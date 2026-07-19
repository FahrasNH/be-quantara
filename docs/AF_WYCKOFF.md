# WYCKOFF — Entry Triggers (AS-IS)

**Scope**: What triggers an WYCKOFF entry and the signal labels emitted on fill.  
**Strategy key**: `WYCKOFF` (`WyckoffStrategy`, v2.0)  
**Engine SSOT**: `wyckoffComponent.js` → `evaluateWyckoffComponent`  
**Config SSOT**: `strategyDefaults.js` → `WYCKOFF` (inherits `SMART_MONEY_CONCEPTS` risk) + `wyckoffComponent.js` DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`WYCKOFF`** preset (= SMC geometry); Wyckoff-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% combined risk |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 8 | trade | Batas frekuensi harian |
| `leverage` | 3 | × | Leverage default |

### Entry thresholds (Wyckoff component)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `entryModel` | `"aggressive"` | enum | `moderate` / `conservative` = checklist lebih ketat |
| `lookback` | 100 | bar | Indikator & volume SMA window |
| `rangeLookback` | 20 | bar | Horizontal range S/R |
| `minBarsInRange` | 20 | bar | Range harus mature |
| `minRangeWidthPct` / `maxRangeWidthPct` | 0.005 / 0.05 | fraksi harga | Lebar range valid |
| `bbWidthPercentileMax` | 40 | percentile | Kompresi BB width untuk trading range |
| `penetrationAtrMult` | 0.8 | × ATR | Kedalaman spring/upthrust minimum |
| `recoveryWindow` | 5 | bar | Window reclaim setelah manipulasi |
| `volumeConfirmMult` | 1.0 | × vol SMA | Konfirmasi volume pada event |
| `cooldownBars` | 5 | bar | Jeda antar sinyal |

### Gates (entry model layers)

| Model | Extra checklist layers |
| --- | --- |
| `aggressive` (default) | `tradingRange`, `manipulation`, `reclaimOrReject`, `volumeConfirm` |
| `moderate` | + `priorTrend`, `rejection`, `choch`, `proximityOk`, `rrOk` |
| `conservative` | + `climaxOrWeakening`, `sosOrSow`, `lpsOrLpsy` |

### AF umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `afCombinationMode` | `"race"` | SMC / Wyckoff / VSA race-to-confirm |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

WYCKOFF scans for a **valid trading range**, then looks for a schematic manipulation event and an entry checklist pass.

```
Trading Range → Spring (LONG) or Upthrust (SHORT) → Entry Checklist → signal
```

**Detection sequence** (`evaluateWyckoffComponent`):

1. **Trading range** — BB-width compression + mature horizontal range (`detectTradingRange`)
2. **Manipulation event**:
   - LONG: **Spring** — fake break below range low + reclaim (`detectSpring`)
   - SHORT: **Upthrust** — fake break above range high + rejection (`detectUpthrust`)
3. **Entry checklist** (`evaluateEntryChecklist`) — layers vary by `entryModel` (default **`aggressive`**)
4. On pass: `reason` is `wyckoff_spring` (LONG) or `wyckoff_upthrust` (SHORT)

Failed checklist → no signal (`entry_checklist_failed:…`). Cooldown and range gates can block without changing signal labels on fills.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 30m | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Signal labels are **the same across trade types**; only timeframe and which pattern fired differ.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle (`lastIdx = length−2`); **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` or explicit single `strategyKey` → `BotEngine._tick()` only. Signal and entry both at **confirmed candle close** (no ticker entry). **Generic** config-level ATR gate (`atrMinMult` / `atrMaxMult`, no per-leg `atrGateRelative` baseline unless interval maps to a leg).

Backtest (both paths): fill at the signal bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `1h` | TF | Signal / indicator candle polled each tick |
| `checkInterval` | `3_600_000` | ms | Minimum spacing between live ticks (~1 h) |
| `higherTf` | `4h` | TF | HTF trend filter (`BotEngine` HTF cache) |

**Legs that may open on live tick** (`liveTradeTypeGate.js`, real money only):

| Leg | Real money | Dry-run / backtest |
| --- | --- | --- |
| Scalping | Blocked | Allowed |
| Intraday | Allowed | Allowed |
| Swing | Allowed | Allowed |

Backtest multi-TF ladder (`runBacktestJob.TYPE_TF`): Scalping **5m/30m**, Intraday **15m/1h**, Swing **4h/1w** (global). Live tick still runs all `enabledComponents`; the gate only blocks Scalping on real money.

Production ticker guards: `AdaptiveStrategyEngine` §11b–11c.

---

## Entry signal labels

Labels come from the **pattern reason code** and optional **checklist flags** on `entryMeta`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Spring** | LONG manipulation event | `reason === "wyckoff_spring"` or `/spring/i` |
| **Upthrust** | SHORT manipulation event | `reason === "wyckoff_upthrust"` or `/upthrust\|utad/i` |
| **LPS** | Last-point-of-support context | `/lps/i` in reason (not LPSY) |
| **LPSY** | Last-point-of-supply context | `/lpsy/i` in reason |
| **LPS/LPSY** | Checklist flag without specific LPS/LPSY label yet | `checklist.lpsOrLpsy` true |
| **SOS** | Sign of strength (LONG bias) | `checklist.sosOrSow` + side LONG |
| **SOW** | Sign of weakness (SHORT bias) | `checklist.sosOrSow` + side SHORT |
| **Volume Climax** | Volume climax / confirm in checklist | `checklist.volumeConfirm` or `checklist.volumeClimax` or `/climax/i` in reason |

### When each label actually appears

**Default `aggressive` model** — most fills show only the pattern label:

| Side | Typical labels |
| --- | --- |
| LONG | `Spring` |
| SHORT | `Upthrust` |

**`moderate` / `conservative` models** — checklist extras appear when those layers pass:

| Label | Typical factory-default behavior |
| --- | --- |
| **SOS** / **SOW** | Only when `checklist.sosOrSow === true` (conservative path, or events detected in range) |
| **LPS/LPSY** | When `checklist.lpsOrLpsy` true and no standalone LPS/LPSY already emitted |
| **Volume Climax** | When volume-confirm or climax flags set in checklist |

### Typical examples

| Side / model | Example labels |
| --- | --- |
| LONG (aggressive) | `Spring` |
| SHORT (aggressive) | `Upthrust` |
| LONG + conservative checklist | `Spring, SOS, LPS/LPSY, Volume Climax` |
| Failed / no meta | *(empty)* |

---

## AS-IS quirks

- **AF umbrella**: When WYCKOFF wins the FOUNDRY race, SMC/VSA wins use their own label vocabularies.
- **Backtest default**: `runBacktestJob.js` forces `entryModel: "aggressive"` when unset — aligns with factory reset.
- **Low variance on aggressive**: direction (Spring vs Upthrust) is the main difference between fills.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Valid trading range | Yes (gate) | No |
| Spring / Upthrust | Yes (trigger) | Yes — `Spring` / `Upthrust` |
| Reclaim / rejection | Yes (checklist) | No (implicit in pattern) |
| SOS / SOW / LPS | Model-dependent | Yes — when checklist flags set |
| Volume confirm | Yes (checklist) | Yes — `Volume Climax` when flagged |

---

*Update this file when `evaluateEntryChecklist` prerequisites or signal label mapping change.*
