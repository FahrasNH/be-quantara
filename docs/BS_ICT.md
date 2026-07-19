# ICT_STYLE_TRADING — Entry Triggers (AS-IS)

**Scope**: What triggers a ICT_STYLE_TRADING entry and the signal labels emitted on fill.  
**Strategy key**: `ICT_STYLE_TRADING` (`IctStyleStrategy`, v1.0) — Breakout Storm racer #1  
**Engine SSOT**: `ictKillZoneRaid.js` → `evaluateIctStyleEntry`  
**Config SSOT**: `strategyDefaults.js` → `ICT_STYLE_TRADING` (inherits `BREAKOUT_RETEST`) + component DEFAULTS  
**FE Advance UI**: `fe-bot-trading/.../backtestStrategies.js` → `paramMeta` (subset)  
**Doc date**: 2026-07-15

> Describes **what the code emits today**, not aspirational PRD copy.  
> Current implementation is a **subset**: kill-zone timing + liquidity raid only. MSS and OTE are **not** computed at entry time.

---

## Default Config (Factory Reset)

Sprint 14+ baseline — per-leg `typeOverrides` carry `atrMinMult` (see below). Risk/SL/TP dari **`ICT_STYLE_TRADING`** preset (= Breakout geometry); ICT-specific knobs dari **component DEFAULTS**.

### Risk & SL/TP (umbrella preset)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `riskPerTrade` | 0.01 | fraksi equity | 1% risk per trade |
| `atrMultiplier` | 1.5 | × ATR | Stop-loss dasar |
| `riskReward` | 3.0 | × SL | Take-profit = 4.5×ATR nominal (RR 1:3) |
| `maxTradesPerDay` | 5 | trade | Cap harian (preset) |
| `leverage` | 1 | × | Tanpa leverage |

### Entry thresholds (Kill Zone + Liquidity Raid)

| Parameter | Default | Unit | Kegunaan |
| --- | --- | --- | --- |
| `bsIctRequireKillZone` / `requireKillZone` | `false` | bool | `true` = hard gate; default = soft preference |
| `sessionLookback` | 20 | bar | Session high/low window |
| `volumeMult` | 1.25 | × vol SMA | Volume minimum pada raid |
| `minWickBeyondPct` | 0.0005 | fraksi harga | Sweep minimum beyond level |
| `baseConfidence` | 0.7 | 0–1 | Confidence in kill zone |
| `outsideKzConfidence` | 0.45 | 0–1 | Confidence outside kill zone |

### Kill zone windows (UTC)

| Zone | Window (UTC) |
| --- | --- |
| `london_open` | 07:00–09:00 |
| `ny_open` | 12:00–14:00 |
| `london_close` | 15:00–16:00 |

### Per trade type overrides

| Leg | `atrMinMult` (from `DEFAULT_LEG_TYPE_OVERRIDES`) |
| --- | --- |
| Scalping | 0.15 |
| Intraday | 0.4 |
| Swing | 0.8 |

Backtest merges these onto per-leg cfg; top-level `atrMinMult` remains the live fallback.


---

## What triggers an entry

ICT_STYLE_TRADING combines **session kill-zone timing** with a **liquidity raid** (sweep + rejection close).

```
Kill Zone Check → Liquidity Raid (session H/L sweep + close back) → signal
```

**Entry sequence** (`evaluateIctStyleEntry`):

1. **Kill zone** — bar timestamp in London / NY / London-close windows (`isKillZone`) when `bsIctRequireKillZone === true`
2. **Liquidity raid** (`detectLiquidityRaid`):
   - Sweep session high + close back → SHORT (`raid_high_reversal`)
   - Sweep session low + close back → LONG (`raid_low_reversal`)
3. Soft-volume variants (`raid_high_soft_vol`, `raid_low_soft_vol`) reduce confidence but can still fill
4. `reason` like `ict_raid_low_reversal_london`

**Not implemented in v1 entry path**: MSS detection, OTE fib zone — formatter knows these labels but engine does not set `meta.mss` / `meta.ote`.

---

## Trade types (brief)

| Type | Entry / Confirm / Trend TF | Live eligible |
| --- | --- | --- |
| Scalping | 5m / 15m / 1h | Backtest & dry-run only |
| Intraday | 15m / 1h / 4h | Yes |
| Swing | 4h / 1d / 1w | Yes |

Default interval 15m. Signal labels reflect kill-zone + raid only.

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

Labels come from `entryMeta.killZone`, `entryMeta.raid`, `entryMeta.reason`.

### Label vocabulary

| Label | Emitted when | Code condition |
| --- | --- | --- |
| **Kill Zone** | Bar in active session window | `killZone.active` or `/kz\|kill_zone\|london\|ny_open/i` in `reason` |
| **Liquidity Raid (Lo→Long)** | Raid of session low | `raid.direction === "LONG"` or `/raid_low/i` |
| **Liquidity Raid (Hi→Short)** | Raid of session high | `raid.direction === "SHORT"` or `/raid_high/i` |
| **Liquidity Raid** | Raid detected, direction unclear | `raid.detected` without direction match |
| **MSS** | Market structure shift | `meta.mss` or `/mss\|market.?structure.?shift/i` — **not set by engine today** |
| **OTE** | Optimal trade entry | `meta.ote` or `/ote\|optimal.?trade/i` — **not set by engine today** |

### When each label actually appears

**Normal fills** (kill zone active, raid detected):

| Side | Example labels |
| --- | --- |
| LONG | `Kill Zone, Liquidity Raid (Lo→Long)` |
| SHORT | `Kill Zone, Liquidity Raid (Hi→Short)` |

**Off kill-zone** (when `requireKillZone` false): raid label only, e.g. `Liquidity Raid (Hi→Short)`.

**MSS / OTE**: Do **not** appear on real fills — fields are never populated. Formatter fallback with missing meta can hardcode them — do not treat as observed trade data.

### Typical examples

| Scenario | Example labels |
| --- | --- |
| London KZ + raid low | `Kill Zone, Liquidity Raid (Lo→Long)` |
| NY open + raid high | `Kill Zone, Liquidity Raid (Hi→Short)` |
| Outside KZ with `requireKillZone: true` | *(no trade)* |
| Formatter fallback only | `Kill Zone, Liquidity Raid, MSS, OTE` *(meta missing — not typical)* |

---

## AS-IS quirks

- **VAULT umbrella**: ICT_STYLE_TRADING wins stamp `winningComponent: "ICT_STYLE_TRADING"`.
- **`requireKillZone` default is `false`**: kill zone is soft preference, not a hard gate unless explicitly enabled.
- **MSS / OTE not implemented**: labels exist in formatter vocabulary only.

---

## Quick reference — sequence vs labels

| Sequence step | Drives entry? | Signal label? |
| --- | --- | --- |
| Kill zone active | Yes (when required) | Yes — `Kill Zone` |
| Liquidity raid | Yes (trigger) | Yes — `Liquidity Raid (…)` |
| MSS | No (not implemented) | No on real fills |
| OTE | No (not implemented) | No on real fills |

---

*Update this file when `evaluateIctStyleEntry` adds MSS/OTE or signal label mapping changes.*
