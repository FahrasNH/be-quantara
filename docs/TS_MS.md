# MARKET_STRUCTURE — Entry Triggers (AS-IS)

**Scope**: What triggers a MARKET_STRUCTURE entry and the signal labels emitted on fill.  
**Strategy key**: `MARKET_STRUCTURE` (`MarketStructureStrategy`, v2.0)  
**Engine SSOT**: `marketStructureComponent.js` → `evaluateMarketStructureEntry`  
**Config SSOT**: `strategyDefaults.js` → `MARKET_STRUCTURE` (inherits `TREND_FOLLOWING`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`MARKET_STRUCTURE`** preset (= Trend Following geometry); Dow-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss |
| `riskReward` | 2.0 | × SL | Take-profit = 3.0×ATR (RR 1:2) |
| `maxTradesPerDay` | 4 | trade | Cap harian |
| `leverage` | 2 | × | Leverage default |

### Entry thresholds (Dow structure component)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `leftLook` / `rightLook` | 2 / 2 | bar | Fractal swing confirmation (anti-repaint) |
| `scanBars` | 80 | bar | Swing scan window |
| `minSwingPairs` | 2 | pair | Minimum HH/HL or LH/LL pairs |
| `entryPullbackPct` | 0.35 | fraksi range | Pullback tolerance vs last swing span |
| `entryAtrMult` | 0.75 | × ATR | Pullback tolerance (prefer ATR when available) |

### FORGE umbrella (race)

| Parameter | Default | Kegunaan |
| --- | --- | --- |
| `tsCombinationMode` | `"race"` | TREND_FOLLOWING / MARKET_STRUCTURE / AUCTION_MARKET_THEORY race independently |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

MARKET_STRUCTURE (Dow Theory) trades **pullbacks to established swing structure** on the HTF series.

```
Classify Structure (uptrend/downtrend) → Pullback to HL/LH zone → Bounce/Reject confirm → signal
```

**Entry sequence** (`evaluateMarketStructureEntry`):

1. **Swing structure** — detect HH/HL (uptrend) or LH/LL (downtrend) from pivot swings
2. **Pullback tolerance** — price within `entryPullbackPct` / ATR distance of last swing low (LONG) or swing high (SHORT)
3. **Entry confirm** on current bar:
   - LONG: `dow_hl_pullback_bounce` — HL held + bullish close
   - SHORT: `dow_lh_rally_reject` — LH held + bearish close

Awaiting states (`awaiting_hl_pullback`, `awaiting_lh_rally`, etc.) do not open trades.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Race mode uses HTF arrays (`highsHTF`, `lowsHTF`, `closesHTF`). Signal labels are the same across trade types.

---

## Entry signal labels

Labels come from `entryMeta.reason` + `entryMeta.meta.structure`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Swing Structure** | Confirmed trend structure | `reason` starts with `dow_`, includes `structure_confirmed/uptrend/downtrend`, or `structure` is uptrend/downtrend |
| **HH/HL Pattern** | Uptrend or downtrend structure | `/hl\|hh\|lh\|ll/i` in reason, or `structure` is uptrend/downtrend |
| **Pullback Bounce** | LONG entry confirm | `/bounce/i` in reason |
| **Pullback Reject** | SHORT entry confirm | `/reject/i` in reason |
| **Same-Bar Confirm** | Dow entry reason prefix | `reason.startsWith("dow_")` |

### When each label actually appears

**LONG fills** (`dow_hl_pullback_bounce`) typically show:

`Swing Structure, HH/HL Pattern, Pullback Bounce, Same-Bar Confirm`

**SHORT fills** (`dow_lh_rally_reject`) typically show:

`Swing Structure, HH/HL Pattern, Pullback Reject, Same-Bar Confirm`

**Variance**: LONG vs SHORT swaps Bounce/Reject. Structure labels repeat across fills (hard-gate style).

### Typical examples

| Side | Example labels |
| --- | --- |
| LONG | `Swing Structure, HH/HL Pattern, Pullback Bounce, Same-Bar Confirm` |
| SHORT | `Swing Structure, HH/HL Pattern, Pullback Reject, Same-Bar Confirm` |
| Gate-only / no fill | *(empty)* |

---

## AS-IS quirks

- **FORGE umbrella**: MARKET_STRUCTURE wins stamp `winningComponent: "MARKET_STRUCTURE"`.
- **Pullback step has no label**: pullback to swing is a gate but not a separate signal label.
- **HH/HL Pattern label**: same text used for both uptrend and downtrend structure.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| HH/HL or LH/LL structure | Yes | Yes — `Swing Structure`, `HH/HL Pattern` |
| Pullback to swing | Yes | Implicit (no separate label) |
| Bounce / reject bar | Yes (trigger) | Yes — `Pullback Bounce` / `Pullback Reject` |
| `dow_*` reason code | Yes | Yes — `Same-Bar Confirm` |

---

*Update this file when `evaluateMarketStructureEntry` reason codes or signal label mapping change.*
