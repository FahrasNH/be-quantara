# BREAKOUT_RETEST — Entry Triggers (AS-IS)

**Scope**: What triggers a BREAKOUT_RETEST entry and the signal labels emitted on fill.  
**Strategy key**: `BREAKOUT_RETEST` (`BreakoutTradingStrategy`) — Breakout Storm racer #0  
**Engine SSOT**: `BreakoutTradingStrategy.js` → `detectSignal`  
**Config SSOT**: `strategyDefaults.js` → `BREAKOUT_RETEST` / `BREAKOUT_RETEST` (+ ctor `BreakoutTradingStrategy.js`)  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below).  
Risk/SL/TP dari **`strategyDefaults.js`**; threshold fase retest & vol floor dari **engine ctor** (merge saat runtime).

### Risk & SL/TP

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade (strategyDefaults) |
| `atrMultiplier` / `slMultiplier` | 1.5 / 1.7 | × ATR | SL — ctor engine 1.7× jika key tidak di-override |
| `riskReward` / `tpMultiplier` | 3.0 / 3.2 | × SL / × ATR | TP ≈ 4.5×ATR nominal (RR 1:3); engine cap `maxPlannedRR` 2.5 |
| `preferredTpMode` | `"full"` | enum | `full` = full TP; `partial` = take pertama ≤33% |
| `maxTradesPerDay` | 2 | trade | Cap harian (engine); strategyDefaults = 5 |
| `leverage` | 1 | × | Tanpa leverage |

### Entry thresholds (4-phase sequence)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `rangeLookback` / `lookbackBars` | 20 | bar | High/low S&R untuk breakout |
| `volumeMultiplier` | 1.5 | × vol SMA | Volume minimum saat breakout |
| `maxVolumeRatio` | 3.55 | × vol SMA | Tolak exhaustion volume (>3.55×) |
| `minBbWidthPct` | 0.0076 | fraksi harga | Volatility floor — BB width minimum |
| `minAtrPct` | 0.25 | % harga | Volatility floor — ATR% minimum |
| `minRetestBars` | 16 | bar @15m | Tunggu retest ≥4 jam sebelum entry valid |
| `retestWindow` | 96 | bar @15m | Retest harus terjadi ≤24 jam pasca-breakout |
| `minDisplacementAtr` | 0.30 | × ATR | Harga harus menjauh dari level dulu |
| `minRejectionWickRatio` | 0.5 | fraksi range | Wick rejection minimum di bar retest |
| `minRetestDepthAtr` / `maxRetestDepthAtr` | 0.17 / 0.72 | × ATR | Band kedalaman pullback ke level |

### Gates & regime blocks

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `requireConsolidation` | `true` | Wajib lolos vol floor sebelum arm breakout |
| `blockedMarketConds` | `COILED_BREAKOUT`, `SQUEEZE_BREAKOUT`, `DRY_SQUEEZE` | Regime yang diblok sebelum fill |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


### Yang bisa di-tune di FE Advance

`paramMeta`: `rangeLookback`, `volumeMultiplier`, `maxVolumeRatio`, `retestWindow`, `minRetestBars`, `minBbWidthPct`, `minAtrPct`, `preferredTpMode`, `atrMult`, `riskReward`, `riskPerTrade`, `capital`.

> **Catatan drift**: FE hint `minRetestBars` = 16 tapi form default masih 8; BE engine ctor = **16** (SSOT). `maxVolumeRatio` FE = 5.0 vs engine = 3.55.

---

## What triggers an entry

BREAKOUT_RETEST is a **four-phase sequential** breakout system: consolidation → breakout → displacement wait → true retest entry.

```
S&R Levels → BB Squeeze / Vol Floor → Breakout + Volume → Displacement Wait → Retest Confirm → signal
```

**Phase sequence** (`detectSignal`):

1. **Levels** — 20-bar resistance/support (`detectLevels`)
2. **Volatility floor** — BB squeeze / ATR% consolidation check (`checkConsolidation`)
3. **Breakout arm** — close breaks level with volume (`checkLongBreakout` / `checkShortBreakout`); state stored
4. **Wait** — ≥ `minRetestBars` (default 16 ≈ 4h on 15m), ≤ `retestWindow`, post-breakout displacement ≥ `minDisplacementAtr`
5. **Retest entry** — pullback to level + rejection wick + depth band (`checkRetestEntry`)
6. On fill: `_lastSignalMeta` flags set (`bbSqueeze`, `rangeBreakout`, `retestConfirmation`, etc.)

Blocked regimes (`COILED`/`SQUEEZE` in `blockedMarketConds`) and unreachable structural TP abort before fill.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Strategy default interval is 15m. Signal labels are **nearly identical across fills and trade types**.

---

## Entry signal labels

Labels come from boolean phase flags on `_lastSignalMeta` / `getLastSignalMeta()`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **BB Squeeze** | Consolidation squeeze detected | `bbSqueeze`, `consolidationConfirmed`, or `squeeze` |
| **Range Break** | Breakout from range | `rangeBreakout` or `breakoutConfirmed` |
| **Volume Spike** | Breakout volume elevated | `volumeSpike`, `breakoutVolumeConfirmed`, or `breakoutVolumeRatio > 1` |
| **Retest Confirm** | True retest entry bar | `retestConfirmation` or `retestConfirmed` |

### When each label actually appears

Normal fills set `bbSqueeze`, `rangeBreakout`, `retestConfirmation` on `_lastSignalMeta`.  
`breakoutVolumeRatio` is stored on breakout arm → **Volume Spike** appears when ratio > 1.

**Typical fill**:

`BB Squeeze, Range Break, Volume Spike, Retest Confirm`

**Variance is very low** — all four phases are hard prerequisites. Direction is not in signal labels.

**Formatter fallback**: If flags missing but `winningComponent === "BREAKOUT_RETEST"`, returns all four labels anyway.

### Typical examples

| Scenario | Example labels |
| --- | --- |
| Standard retest fill | `BB Squeeze, Range Break, Volume Spike, Retest Confirm` |
| Low breakout volume (ratio ≤ 1) | `BB Squeeze, Range Break, Retest Confirm` *(Volume Spike absent)* |
| No fill / missing meta | *(empty)* |

---

## AS-IS quirks

- **VAULT umbrella**: BREAKOUT_RETEST wins stamp `winningComponent: "BREAKOUT_RETEST"`. ICT_STYLE_TRADING / LIQUIDATION_SQUEEZE use their own label vocabularies.
- **strategyDefaults vs ctor drift**: `maxTradesPerDay` 5 (defaults) vs 2 (engine); SL/TP multipliers differ unless explicitly overridden.
- **Direction omitted**: LONG vs SHORT is not reflected in signal labels.

---

## Quick reference — phase vs labels

| Phase | Drives entry? | Signal label? |
| --- | --- | --- |
| BB squeeze / vol floor | Yes | Yes — `BB Squeeze` |
| Range breakout | Yes | Yes — `Range Break` |
| Breakout volume | Yes | Yes — `Volume Spike` (when ratio > 1) |
| True retest | Yes (trigger) | Yes — `Retest Confirm` |

---

*Update this file when `detectSignal` meta flags or phase prerequisites change.*
