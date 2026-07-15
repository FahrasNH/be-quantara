# AF_VSA — Entry Triggers (AS-IS)

**Scope**: What triggers an AF_VSA entry and the signal labels emitted on fill.  
**Strategy key**: `AF_VSA` (`VsaStrategy`, v1.0)  
**Engine SSOT**: `vsaComponent.js` → `evaluateVSAComponent`  
**Config SSOT**: `strategyDefaults.js` → `AF_VSA` (inherits `SMART_MONEY_CONCEPTS` risk) + `vsaComponent.js` DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14 baseline — `typeOverrides: {}`. Risk/SL/TP dari **`AF_VSA`** preset (= SMC geometry); VSA-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% combined risk |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
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
| `atrPeriod` | 14 | bar | ATR untuk spread classification |

### AF umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `afCombinationMode` | `"race"` | SMC / Wyckoff / VSA race-to-confirm |

### Per trade type overrides

Tidak ada — `typeOverrides: {}`.

---

## What triggers an entry

AF_VSA requires price **near swing structure**, then classifies the current bar's **volume-spread relationship** (effort vs result).

```
Swing Proximity Gate → VSA Pattern (stopping volume / no-demand / no-supply) → signal
```

**Detection sequence** (`evaluateVSAComponent`):

1. **Data gates** — sufficient bars, volume, ATR, relative volume SMA
2. **Swing proximity** — price within `swingRadius` of a recent swing high/low (`checkSwingProximity`)
3. **Spread classification** — wide / normal / narrow vs ATR
4. **Pattern match** (`detectVSAPattern`) on candle + relative volume + CLV + swing type:
   - **Stopping Volume** at swing low → LONG (`vsa_stopping_volume_low`)
   - **Stopping Volume** at swing high → SHORT (`vsa_stopping_volume_high`)
   - **No-Demand** near swing high → SHORT (`vsa_no_demand`)
   - **No-Supply** near swing low → LONG (`vsa_no_supply`)
5. Effort/result mismatch may reduce confidence but does **not** add signal labels

Bars failing swing proximity (`not_near_structure`) or with no pattern (`no_pattern`) do not open trades.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Signal labels are **identical across trade types**; pattern direction and swing type drive label choice.

---

## Entry signal labels

Labels come from `entryMeta.reason` + `entryMeta.meta.nearSwing`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Stopping Volume** | Absorption at structure | `reason` is `vsa_stopping_volume_low` or `vsa_stopping_volume_high` |
| **No-Demand** | Weak rally at highs | `reason === "vsa_no_demand"` |
| **No-Supply** | Weak decline at lows | `reason === "vsa_no_supply"` |
| **Swing Proximity** | Pattern required near swing | `meta.nearSwing` truthy (always true on fills) |

### When each label actually appears

Nearly every fill includes **Swing Proximity** because the pattern gate requires `nearSwing.isNear`.

**Variance between trades**:

| Label | Typical behavior |
| --- | --- |
| **Stopping Volume** vs **No-Demand** / **No-Supply** | Which VSA pattern fired (3 mutually exclusive primary labels) |
| **Swing Proximity** | Present on virtually all fills |

Unmapped `reason` strings fall back to `titleCaseSnake(raw)` — rare on successful fills.

### Typical examples

| Side / pattern | Example labels |
| --- | --- |
| LONG (stopping volume) | `Stopping Volume, Swing Proximity` |
| SHORT (no demand) | `No-Demand, Swing Proximity` |
| LONG (no supply) | `No-Supply, Swing Proximity` |
| No signal / missing meta | *(empty)* |

---

## AS-IS quirks

- **AF umbrella**: AF_VSA wins use `winningComponent: "AF_VSA"`. Other AF racers use their own label vocabularies.
- **Effort/result mismatch**: reduces confidence only — never adds or removes labels.
- **Three primary patterns**: Stopping Volume, No-Demand, and No-Supply are mutually exclusive per fill.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Near swing structure | Yes (hard gate) | Yes — `Swing Proximity` |
| Stopping volume / no-demand / no-supply | Yes (trigger) | Yes — pattern label |
| Effort/result mismatch | No (confidence only) | No |

---

*Update this file when `evaluateVSAComponent` pattern codes or signal label mapping change.*
