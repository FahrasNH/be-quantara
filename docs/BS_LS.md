# LIQUIDATION_SQUEEZE — Entry Triggers (AS-IS)

**Scope**: What triggers a LIQUIDATION_SQUEEZE entry and the signal labels emitted on fill.  
**Strategy key**: `LIQUIDATION_SQUEEZE` (`LiquidationSqueezeStrategy`, v1.0) — Breakout Storm racer #2  
**Engine SSOT**: `liquidationSqueeze.js` → `evaluateLiquidationSqueezeEntry`  
**Config SSOT**: `strategyDefaults.js` → `LIQUIDATION_SQUEEZE` (inherits `BREAKOUT_RETEST`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`LIQUIDATION_SQUEEZE`** preset (= Breakout geometry); liquidation/squeeze knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 3.0 | × SL | Take-profit = 4.5×ATR nominal (RR 1:3) |
| `maxTradesPerDay` | 5 | trade | Cap harian (preset) |
| `leverage` | 1 | × | Tanpa leverage |

### Entry thresholds (Liquidation Wick + OI/Funding)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `wickLookback` | 20 | bar | Range extreme window |
| `minWickBodyRatio` | 1.5 | × body | Wick ≥ 1.5× body |
| `wickVolMult` | 1.2 | × vol SMA | Volume pada wick bar |
| `oiLookback` | 20 | bar | OI change lookback |
| `oiChangeConfirmPct` | 1.0 | % | \|OI change\| minimum |
| `extremeFundingLong` | 0.0005 | rate | +0.05% / 8h funding extreme |
| `extremeFundingShort` | -0.0005 | rate | -0.05% / 8h funding extreme |
| `baseConfidence` | 0.55 | 0–1 | Wick-only confidence |
| `displacementOnlyConfidence` | 0.5 | 0–1 | Fail-open wick path |

### OI/Funding behavior

| Behavior | Default |
| --- | --- |
| Fail-open | Wick entries fire when OI/funding unavailable |
| Funding boost | +0.2 confidence when extreme funding aligns |
| OI boost | +0.15 confidence when OI change confirms |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

LIQUIDATION_SQUEEZE combines **liquidation-style wick displacement** with optional **OI / funding** confirmation. OI/funding is **fail-open** — wick-only entries still fire when exchange data is missing.

```
Liquidation Wick (range extreme sweep) → OI/Funding Boost (optional) → signal
```

**Primary path** (`evaluateLiquidationSqueezeEntry`):

1. **Liquidation wick** (`detectLiquidationWick`) — sweep beyond recent range extreme + rejection close + wick ≥ 1.5× body:
   - Sweep lows → LONG (`liquidation_wick_low_bounce`)
   - Sweep highs → SHORT (`liquidation_wick_high_reject`)
2. **Funding / OI overlay** (when available):
   - Extreme funding aligned with direction boosts confidence; appends `+funding_short_squeeze` / `+funding_long_squeeze` to reason
   - OI change ≥ threshold appends `+oi_rising` / `+oi_falling`
3. **Funding-only path** (no wick): extreme funding + rising OI can fire (`funding_long_extreme_oi_rising` / `funding_short_extreme_oi_rising`)

Final `reason` prefixed with `ls_` (e.g. `ls_liquidation_wick_low_bounce+funding_short_squeeze`).

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Default interval 15m. Backtests often lack OI/funding feeds → wick-only path dominates.

---

## Tick open trade

**Production path (default):** `MULTI_STRATEGY_ENABLED=true` → `MultiStrategyCoordinator` → `AdaptiveStrategyEngine._tick()`. Signal on the **confirmed** candle (`lastIdx = length−2`); **entry fill** at exchange ticker `last`. Fail-closed if ticker unavailable; skip when |ticker − signal close| > 1×ATR (stale guard). ATR gate uses **per-leg** overrides via `resolveAtrLegOverride`.

**Legacy path:** `MULTI_STRATEGY_ENABLED=false` or explicit single `strategyKey` → `BotEngine._tick()` only. Signal and entry both at **confirmed candle close** (no ticker entry). **Generic** config-level ATR gate (`atrMinMult` / `atrMaxMult`, no per-leg `atrGateRelative` baseline unless interval maps to a leg).

Backtest (both paths): fill at the signal bar **close** (`RealStrategyBacktestService`).

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `interval` | `15m` | TF | Signal / indicator candle polled each tick |
| `checkInterval` | `900_000` | ms | Minimum spacing between live ticks (~15 min) |
| `higherTf` | `4h` | TF | HTF trend filter (`BotEngine` HTF cache) |

**Legs that may open on live tick** (`liveTradeTypeGate.js`, real money only):

| Leg | Real money | Dry-run / backtest |
| --- | --- | --- |
| Scalping | Blocked | Allowed |
| Intraday | Allowed | Allowed |
| Swing | Allowed | Allowed |

Backtest multi-TF ladder (`runBacktestJob.TYPE_TF`): Scalping **5m/1h**, Intraday **15m/4h**, Swing **4h/1w** (global). Live tick still runs all `enabledComponents`; the gate only blocks Scalping on real money.

Production ticker guards: `AdaptiveStrategyEngine` §11b–11c.

---

## Entry signal labels

Labels come from `entryMeta.wick`, `entryMeta.funding`, `entryMeta.oiChange`, `entryMeta.dataAvailable`, `entryMeta.reason`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Liquidation Wick (Bounce)** | LONG wick setup | `wick.detected` + side LONG, or `/bounce/i` in `reason` |
| **Liquidation Wick (Reject)** | SHORT wick setup | `wick.detected` + side SHORT, or `/reject/i` in `reason` |
| **Liquidation Wick** | Wick detected, side unclear | `wick.detected` or `/liquidation_wick\|ls_/i` |
| **Squeeze** | Funding squeeze in reason | `meta.squeeze` or `/squeeze/i` in `reason` (e.g. `+funding_short_squeeze`) |
| **OI/Funding Proxy** | OI/funding fields present **or data missing** | `funding`/`oiChange` finite, `/funding\|oi/i` in reason, or `dataAvailable === false` |

### When each label actually appears

**Wick + funding suffix** (live feed available):

`Liquidation Wick (Bounce), Squeeze, OI/Funding Proxy`

**Wick-only backtest** (no OI/funding):

`Liquidation Wick (Bounce), OI/Funding Proxy`

Note: `dataAvailable === false` **still adds** `OI/Funding Proxy` — label means "proxy path / unavailable feed", not confirmed OI data.

**Variance**:

| Factor | Effect |
| --- | --- |
| Direction | Bounce vs Reject wick label |
| Funding in reason | Adds **Squeeze** when reason contains `squeeze` |
| `meta.squeeze` | Never set by engine — Squeeze only from reason regex |

### Typical examples

| Scenario | Example labels |
| --- | --- |
| LONG wick, no exchange data | `Liquidation Wick (Bounce), OI/Funding Proxy` |
| SHORT wick + funding squeeze suffix | `Liquidation Wick (Reject), Squeeze, OI/Funding Proxy` |
| Funding-only entry (no wick) | `OI/Funding Proxy` *(wick labels absent)* |
| No signal | *(empty)* |

---

## AS-IS quirks

- **VAULT umbrella**: LIQUIDATION_SQUEEZE wins stamp `winningComponent: "LIQUIDATION_SQUEEZE"`.
- **Fail-open OI/funding**: missing exchange data does not block wick entries.
- **`OI/Funding Proxy` on missing data**: label appears even when no OI/funding was confirmed — means proxy/unavailable path.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Liquidation wick | Yes (primary trigger) | Yes — `Liquidation Wick (…)` |
| Funding extreme | Boost / alt path | Yes — `Squeeze` when in reason; `OI/Funding Proxy` |
| OI change | Boost / alt path | Yes — `OI/Funding Proxy` |
| Missing OI/funding | Fail-open | Yes — `OI/Funding Proxy` when `dataAvailable === false` |

---

*Update this file when `evaluateLiquidationSqueezeEntry` reason format or signal label mapping change.*
