# AUCTION_MARKET_THEORY — Entry Triggers

**Scope**: What triggers an AUCTION_MARKET_THEORY entry and the signal labels emitted on fill.  
**Strategy key**: `AUCTION_MARKET_THEORY` (`VolumeProfileStrategy`, v2.0) — label: **Auction Market Theory**  
**Engine SSOT**: `volumeProfileEntry.js` → `evaluateVolumeProfileEntry`  
**Config SSOT**: `strategyDefaults.js` → `AUCTION_MARKET_THEORY` (inherits `TS_COMPONENT_BASE`)  
**Live gate SSOT**: `liveTradeTypeGate.js` → default `["Intraday","Swing"]`  
**Doc date**: 2026-09-26

---

## Default Config (Factory Reset)

### Global risk preset (combined cap)

- **`riskPerTrade`:** 0.05 (fraksi equity) — Combined cap → split 1% / 2% / 2% per leg
- **`maxDailyLossPct`:** 0.06 (fraksi equity) — Daily loss halt
- **`maxTradesPerDay`:** 4 (trade) — Per-bot daily count
- **`cooldownAfterLoss`:** 5 (menit) — Cooldown after loss
- **`maxConsecLoss`:** 3 (loss) — Consecutive-loss stop
- **`leverage`:** 2 (×) — Default leverage

Per-leg SL/TP: `VolumeProfileStrategy.calculateRiskConfig` (1.5 / 3.0).

### Entry thresholds (Auction Market Theory)

- **`bins`:** 20 (bin) — Volume profile histogram
- **`valueAreaPct`:** 0.7 (fraksi) — Value Area = 70% volume
- **`vwapAtrMult`:** 0.5 (× ATR) — VWAP proximity tolerance
- **`vwapTolerancePct`:** 0.005 (fraksi) — Fallback VWAP tolerance (~0.5%)
- **`minSessionBars`:** 20 (bar) — Intraday UTC-day session floor
- **`minSessionBarsSwing`:** 6 (bar) — low-level UTC-week fallback; the production AMT Swing preset pins a 20-bar context floor after long-history validation
- **`amtEntryQualityGate`:** true — closed-candle acceptance gate
- **`amtHtfAlignGate`:** true — blocks counter-trend entries when HTF is directional
- **`amtMinBodyAtr`:** 0.15 (base; per-leg override) — minimum body size
- **`amtMinVolumeRatio`:** 0.8 (base; per-leg override) — current volume / prior 20-bar SMA
- **`amtMinVwapDistanceAtr`:** 0.1 — minimum close distance beyond VWAP for cross entries
- **`amtEdgeAtrMult`:** 0.25 — VA edge tolerance, separate from VWAP proximity tolerance
- **`amtEdgePenetrationAtr`:** 0.1 — minimum sweep beyond VAL/VAH before an edge trigger is valid
- **`amtVahRejectEnabled`:** false in the AMT preset — short VAH fades remain research opt-in until failed-auction confirmation is implemented

### Per trade type overrides

- **Scalping:** `atrGateRelative: true`, `atrMinMult: 0.75`, `maxTradesPerDay: 1`, `amtSessionFilter: false`, body ≥ 0.2 ATR, volume ≥ 1.0×, RR 2.0
- **Intraday:** `atrMinMult: 0.6`, `maxTradesPerDay: 1`, body ≥ 0.15 ATR, volume ≥ 0.9×
- **Swing:** `atrMinMult: 0.8`, one trade/day, `minSessionBars: 20`, body ≥ 1.0 ATR, volume ≥ 0.8×

---

## Confidence Calculation

**Entry SSOT**: `volumeProfileEntry.js` → `evaluateVolumeProfileEntry`  
**Precision SSOT**: `volumeProfileEntry.js` → `evaluateVolumeProfilePrecision`  
**Graded SSOT**: `ComponentScoringEngine.js` → `scoreAmt` via `VolumeProfileStrategy` / `TrendSurgeUmbrella.js`

### How score is built

- **Range:** 0–1 on primary race triggers
- **Edge triggers (fixed tiers):**
  - VWAP reclaim / lose → **0.72**
  - VAL bounce / VAH reject → **0.68**
  - Above/below VWAP bias → **0.60**
- **Precision overlay (`evaluateVolumeProfilePrecision`):** base **0.55** + near POC (+0.15) + near VWAP (+0.10) + in value area (+0.10); deep discount/premium without POC → −0.20 (floor 0.4)
- **Graded overlay (race):** value-area edge distance, POC magnetism, VWAP relationship, trigger type quality, acceptance/rejection score — 0–100 via `enrichMetaWithGradedScore`

### Per leg thresholds

### Scalping

- **Floor:** none
- **Formula / components:** UTC-day session VWAP + VA profile; `minSessionBars` **20**

### Intraday

- **Floor:** none
- **Formula / components:** same trigger tiers on 15m session profile

### Swing

- **Floor:** none
- **Formula / components:** UTC-week session; production floor `minSessionBars` **20**

---

## Risk & SL/TP (per Trade Type)

Session **VWAP proximity** for precision helpers uses `vwapAtrMult` 0.5×ATR — separate from the race-entry acceptance distance and SL/TP distances below. Entry triggers: [How Entry Works](#how-entry-works).

### Scalping

- **Entry TF / HTF:** 5m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **1%**
- **Notes:** Relative ATR gate; session filter OFF; UTC-day session

### Intraday

- **Entry TF / HTF:** 15m / 1h
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** `minSessionBars` 20

### Swing

- **Entry TF / HTF:** 4h / 1w
- **SL method:** ATR × 1.5
- **TP method:** ATR × 3.0
- **ATR mult / R:R:** 1.5 / 3.0 → **RR 2.0**
- **Risk %:** **2%**
- **Notes:** UTC-**week** session; production profile context floor **20 bars**

### Execution limits (all legs)

**Limit:** Max trades/day
**Value:** AMT preset: 1 per leg; generic TS base: 4
**SSOT:** `strategyDefaults.js` → `AUCTION_MARKET_THEORY.typeOverrides`

---
**Limit:** Cooldown after loss
**Value:** 5 min
**SSOT:** `cooldownAfterLoss`

---
**Limit:** Consecutive loss stop
**Value:** 3
**SSOT:** `maxConsecLoss`

---
**Limit:** Daily loss limit
**Value:** 6% equity (incl. floating)
**SSOT:** `maxDailyLossPct`

---
**Limit:** ATR range gate
**Value:** Scalping: relative 0.4–4.0; Intraday/Swing: absolute 0.4% / 0.8%
**SSOT:** `entryRiskGates.js`

---
**Limit:** Position sizing
**Value:** `size = (equity × legRiskPct) / slDistance`
**SSOT:** `typeRiskLadder.js`

---
**Limit:** TIME_STOP
**Value:** **OFF** (no `maxHoldHours` — positions exit on SL/TP only)
**SSOT:** opt-in via `typeOverrides.*.maxHoldHours`

---

## How Entry Works

Trades **session auction imbalances** — price reclaiming or rejecting VWAP and value-area edges.

### Entry triggers

```
Session VWAP/VA Compute → freeze previous completed levels → acceptance/HTF gates → signal
```

### `vwap_reclaim`

- **Direction:** LONG
- **Condition:** Previous close was below the previous completed VWAP, current close reclaims the current VWAP, and the entry candle has bullish body/volume acceptance and minimum distance.

### `vwap_lose`

- **Direction:** SHORT
- **Condition:** Previous close was above the previous completed VWAP, current close loses the current VWAP, and the entry candle has bearish body/volume acceptance and minimum distance.

### `val_bounce`

- **Direction:** LONG
- **Condition:** Current candle sweeps the **previous completed** VAL by the configured penetration floor and closes back above it with bullish body/volume confirmation.

### `vah_reject`

- **Direction:** SHORT
- **Condition:** Research-only trigger. When enabled, the current candle must sweep the **previous completed** VAH by the configured penetration floor and close back below it with bearish body/volume confirmation.

Precision helpers (`vwap_retest`, `poc_retest`) exist for rollback mode; race-mode fills use the four codes above.

### Gate funnel

- **Session warmup (`minSessionBars`):** hard gate
- **Previous-level freeze:** VAH/VAL/POC exclude the entry candle; this prevents a candle from defining its own rejection level.
- **Candle/volume acceptance:** body direction, body/ATR floor, prior-SMA volume ratio, and VWAP distance for cross entries.
- **HTF alignment:** directional HTF counter-trend is blocked; SIDEWAYS/UNKNOWN remains neutral/fail-closed at the engine layer.
- **`awaiting_amt_trigger`:** no trade
- **Session filter:** **off** (`amtSessionFilter: false`)
- **ATR gate:** per-leg overrides
- **Live money:** Scalping blocked; Intraday + Swing allowed

Swing uses UTC-week session (`minSessionBarsSwing: 6`) because 4h bars have ≤6 per UTC-day.

**Risk / SL/TP**: see [Risk & SL/TP (per Trade Type)](#risk--sltp-per-trade-type).

---

## Trade types

### Scalping

- **Entry TF:** 5m
- **Trend / HTF TF:** 1h
- **Real money:** Blocked
- **Dry-run / backtest:** Allowed

### Intraday

- **Entry TF:** 15m
- **Trend / HTF TF:** 1h
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

### Swing

- **Entry TF:** 4h
- **Trend / HTF TF:** 1w
- **Real money:** Allowed
- **Dry-run / backtest:** Allowed

Each fill maps to **exactly one** trigger label.

---

## Tick open trade

- **`interval`:** `5m` (TF)
- **`checkInterval`:** `60_000` (ms)
- **`higherTf`:** `1h` (HTF)

---

## Entry signal labels

- **VWAP Reclaim:** — LONG
- **VWAP Lose:** — SHORT
- **VAL Bounce:** — LONG
- **VAH Reject:** — SHORT
- **VWAP Retest** / **POC Retest:**

---

## AS-IS quirks

- **Trend Surge umbrella**: AMT wins stamp `winningComponent: "AUCTION_MARKET_THEORY"`.
- **Single label per fill** — unlike TF checklist multi-label fills.
- **`tsUseVwapPrecision` default false** in factory reset.

---

*Update when `evaluateVolumeProfileEntry` reason codes or `VP_REASON_MAP` change.*
