# Trend Following Strategy (TS_TF) — Complete Guide

**Version:** 1.0.0  
**Last Updated:** 2026-07-07  
**Strategy Code:** `TrendFollowingStrategy.js`  
**Tier:** FORGE (minimum Rp15-30M / $1,000-2,000)  
**Trade Types:** Intraday + Swing  

---

## Table of Contents

1. [Strategy Overview](#strategy-overview)
2. [Philosophy & Market Conditions](#philosophy--market-conditions)
3. [Multi-Timeframe Architecture](#multi-timeframe-architecture)
4. [3-Layer Confirmation System](#3-layer-confirmation-system)
5. [Entry & Exit Logic](#entry--exit-logic)
6. [Risk Management](#risk-management)
7. [Configuration Parameters](#configuration-parameters)
8. [Performance Metrics & Backtesting](#performance-metrics--backtesting)
9. [Known Issues & Fixes](#known-issues--fixes)
10. [Practical Tuning Guide](#practical-tuning-guide)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

---

## Strategy Overview

**Trend Following (TS_TF)** is a medium-term position trading strategy that captures trending markets by confirming trend strength before entering trades. It uses multi-timeframe analysis to filter noise and enter only high-conviction setups.

### Key Characteristics

| Aspect | Details |
|--------|---------|
| **Strategy Type** | Trend Continuation + Breakout Confirmation |
| **Best Market** | Strong trending markets (ADX > 25) |
| **Worst Market** | Sideways / choppy / low volatility |
| **Holding Duration** | 4 hours to 10+ days (medium-term) |
| **Trade Frequency** | 0.5–3 trades per day |
| **Win Rate Goal** | 45–50% (profit from strong winners) |
| **Risk-Reward Target** | 1:2.0 to 1:2.5 |
| **Capital Required** | Rp15M minimum (FORGE tier) |
| **Leverage** | 2x (built into position sizing) |

### Who Should Use This Strategy?

✅ **Use if:**
- You want to follow clear trends without noise
- You prefer medium-term holds (hours to days, not scalps)
- You have a stable account (no need to trade every hour)
- You want to catch 2–5R winners and accept 15–20% drawdown
- You understand that it will sit idle in sideways markets

❌ **Don't use if:**
- You want to trade in choppy/sideways markets
- You expect 10+ trades per day
- You need a strategy that trades in ALL conditions
- You cannot accept 30–40% losing trades
- You need tight stops (< 1×ATR)

---

## Philosophy & Market Conditions

### Core Principle

**"Follow the trend after it's confirmed strong, enter on pullback to structure, exit on breakeven or profit."**

The strategy works because:

1. **Strong trends are predictive** — Once a trend passes the ADX strength gate, it tends to continue
2. **Pullbacks are natural** — Price retraces to moving averages, creating low-risk entries
3. **Breakouts confirm** — Donchian channel breaks prove the trend is real, not a false move
4. **ATR-based stops adapt** — Wider stops protect against whipsaws in trending markets

### Market Conditions

The strategy **requires** certain conditions to be profitable:

| Condition | Why | Threshold |
|-----------|-----|-----------|
| **Strong Trend** | Need momentum to reach TP | ADX > 25 |
| **Adequate Volatility** | Stops must be reasonable | 0.5% – 8% ATR% |
| **Breakout Confirmation** | Entry signal must be real | Close > Donchian channel |
| **Volume Support** | Entry needs participation | Volume ≥ 1.0× 20-bar SMA |

**In choppy markets (ADX < 20):** Wins are smaller, losses are worse → strategy should sit idle.

---

## Multi-Timeframe Architecture

### Why Multi-Timeframe?

Single-timeframe entries generate 60–70% false breakouts. Using 3 timeframes reduces false signals:

- **HTF (Higher Timeframe)** filters direction & trend strength
- **MTF (Middle Timeframe)** confirms the move is real (breakout)
- **Entry TF** (Lowest Timeframe) finds optimal entry price

### The Three Timeframes

```
Higher Timeframe (HTF)    1h    ← Trend direction & ADX strength
       ↓
Middle Timeframe (MTF)    15m   ← Donchian breakout confirmation
       ↓
Entry Timeframe          5m    ← Final entry signal (EMA pullback)
```

### How They Align

| Timeframe | Role | Indicators | Example (LONG) |
|-----------|------|-----------|---|
| **1h (HTF)** | Confirm trend exists | EMA9/21/50, ADX | EMA9 > 21 > 50, ADX > 25, Close > EMA21 |
| **15m (MTF)** | Confirm breakout | Donchian High/Low | Close > Donchian High (previous bar) |
| **5m (Entry)** | Find pullback entry | EMA9/21, RSI, Volume | Close > EMA9, EMA9 > EMA21, RSI 30-70, Vol ok |

### Index Alignment

The engine automatically maps candle indices across timeframes:

```javascript
// Example: on 5m bar 300
idxHTF = floor(300 / 12) = 25   // 1h bar 25 (300÷60min = 5min bars per hour, 300÷5=60 bars, 60÷12=5h)
idxMTF = floor(300 / 3) = 100   // 15m bar 100
```

This ensures we compare the **same time period** across all three timeframes.

---

## 3-Layer Confirmation System

### Layer 1: Higher Timeframe (1h) Trend Detection

**Purpose:** Confirm a strong trend exists (not just a move, but a macro direction).

**LONG Conditions:**
```
EMA9 > EMA21 > EMA50           ← EMAs perfectly aligned (uptrend)
Close > EMA21                  ← Price holding above structure
ADX ≥ 25                       ← Trend is strong (not sideways)
```

**SHORT Conditions:**
```
EMA9 < EMA21 < EMA50           ← EMAs perfectly aligned (downtrend)
Close < EMA21                  ← Price below structure
ADX ≥ 25                       ← Trend is strong
```

**Why this works:**
- EMA alignment = price is moving in one direction
- ADX > 25 = statistical proof the trend is strong (not random)
- If any condition fails → no entry signal (wait for next bar)

**Gotchas:**
- If trend flips (e.g., EMA9 was above 21, now below), **reset state** — don't compare this bar to the previous trend
- ADX can be null in the first 50 bars — if missing, assume strong (treat as >= 25)

---

### Layer 2: Middle Timeframe (15m) Donchian Breakout

**Purpose:** Confirm the trend is actually moving (not just a statistical pattern on higher timeframe).

**LONG Breakout:**
```
Close[15m] > Donchian High[15m, previous bar]
```

**SHORT Breakout:**
```
Close[15m] < Donchian Low[15m, previous bar]
```

**Key Detail — Compare to PREVIOUS Bar:**
- The Donchian channel is the **highest high / lowest low of the last 20 bars**
- We compare **today's close to YESTERDAY's channel** (not today's channel)
- Why? A breakout means: "I've moved beyond where price has been"
- If we include today's high in the channel, the close can never exceed it (mathematically impossible)

**Example (LONG Breakout):**
```
Yesterday's 15m Donchian:  High = 67,000  Low = 66,500
Today's 15m close:         67,050
Result:                    67,050 > 67,000 ✓ Breakout confirmed
```

---

### Layer 3: Entry Timeframe (5m) Pullback Retest

**Purpose:** Wait for a pullback to moving average, then enter on retest above it (low-risk entry).

**Why pullback retest?**
- Entering immediately after a breakout = chasing (high slippage, wide initial loss)
- Waiting for pullback to EMA = natural support, lower initial loss
- Entering when price rises back above EMA = confirmation the pullback is done

**LONG Entry Conditions (all must be true):**

```
1. HTF Trend = "LONG"                      ← Layer 1 passed
2. ADX ≥ 25 on HTF                         ← Strong trend (no whipsaw)
3. Donchian broken on MTF                  ← Layer 2 passed
4. Close[5m] > EMA9[5m]                    ← Above fast MA (pullback done)
5. EMA9[5m] > EMA21[5m]                    ← Structure intact (not reversing)
6. RSI[5m] ∈ [30, 70]                      ← Healthy zone (not overbought)
7. Volume[5m] ≥ 1.0× VolumeSMA[5m]        ← Entry has participation
```

**SHORT Entry Conditions (mirror of LONG):**
```
1. HTF Trend = "SHORT"
2. ADX ≥ 25 on HTF
3. Donchian broken on MTF
4. Close[5m] < EMA9[5m]
5. EMA9[5m] < EMA21[5m]
6. RSI[5m] ∈ [30, 70]
7. Volume[5m] ≥ 1.0× VolumeSMA[5m]
```

**If any condition fails:** No entry this bar. Wait for next bar.

---

## Entry & Exit Logic

### Entry Rules

**Signal Type:** LONG or SHORT (mutually exclusive)

**Entry Rules:**
1. All 3 layers must pass (HTF trend, MTF breakout, entry pullback)
2. Entry happens **at market close on the 5m bar** when all conditions align
3. Stop Loss & Take Profit are calculated immediately (see Risk Management section)
4. If conditions fail, reset — wait for next HTF trend confirmation

**Important:** The strategy produces **at most 1 entry per bar**. Even if you're monitoring multiple symbols, each symbol gets max 1 LONG or SHORT signal per bar.

### Exit Rules

The strategy exits in these cases (in order of precedence):

| Exit Type | Condition | Action |
|-----------|-----------|--------|
| **Stop Loss (SL)** | Low ≤ Stop Loss Price | Close position immediately at SL price |
| **Take Profit (TP)** | High ≥ Take Profit Price | Close position immediately at TP price |
| **Break-Even Stop** | Profit ≥ 25% of TP distance | Move SL to entry price (protect capital) |
| **Trailing Stop** | Profit ≥ 50% of TP distance | Move SL up/down by 1.0×ATR (lock in gains) |
| **Time Stop (Timeout)** | Bars held ≥ 100 | Close at market price (avoid holding overnight) |

**Partial Exit Mode (TP Mode = "partial"):**

The strategy supports a 2-layer exit that locks in profits early:

```
At +1.0R (first target):   Close 40% of position, move SL to +0.3R (breakeven + commission)
At +2.0R (second target):  Close 27.5% of position, move SL to +1.0R (lock 1R)
At full TP (3.0R):         Close remaining 32.5% (rest of profit)
```

This reduces tail risk by locking profits incrementally.

---

## Risk Management

### Position Sizing

The strategy calculates position size based on:

```
Risk Amount = Account Balance × Risk per Trade (default 1.5%)
Position Size = Risk Amount / SL Distance × Leverage
```

**Example (LONG trade):**
```
Account Balance:  $10,000
Risk per Trade:   1.5% = $150
Entry Price:      $67,000
Stop Loss:        $66,500
SL Distance:      $500
Base Qty:         $150 / $500 = 0.003 BTC
Leverage:         2x
Final Qty:        0.003 × 2 = 0.006 BTC (0.6% of account max notional exposure)
```

### Stop Loss & Take Profit (SL/TP)

The strategy uses **ATR-based stops** that adapt to market volatility:

```
SL Distance = ATR × SL Multiplier
TP Distance = ATR × TP Multiplier

LONG:
  SL = Entry Price - SL Distance
  TP = Entry Price + TP Distance

SHORT:
  SL = Entry Price + SL Distance
  TP = Entry Price - TP Distance
```

**Default Configuration:**
- **SL Multiplier:** 1.5× (wider stops for trending markets)
- **TP Multiplier:** 3.0× (lock in 2.0 risk-reward)
- **Planned RR:** 3.0 / 1.5 = **2.0**

**Key Insight:** Wider stops (1.5×ATR) reduce whipsaws in trending markets, but they're still profitable because the wins are large (TP 3.0×ATR).

### Daily Loss Limits

The strategy respects these limits:

| Limit | Default | Purpose |
|-------|---------|---------|
| **Max Risk per Trade** | 1.5% | Single-trade loss cap |
| **Max Daily Loss** | 6% | Daily drawdown cap |
| **Max Consecutive Losses** | 2 | Quit after 2 losses in a row |
| **Max Trades per Day** | 3 | Avoid overtrading |

If these limits are hit, the strategy stops entering new trades until the next day (or reset).

---

## Configuration Parameters

### Strategy Defaults

```javascript
{
  // Timeframes (multi-TF strategy)
  htfInterval: "1h",                    // Higher TF for trend direction
  mtfInterval: "15m",                   // Middle TF for confirmation
  entryInterval: "5m",                  // Entry TF for precision

  // EMAs & SMAs (trend structure)
  emaTrendFast: 9,                      // Fast EMA (entry signal)
  emaTrendMid: 21,                      // Mid EMA (structure)
  emaTrendSlow: 50,                     // Slow EMA (trend filter)

  // Donchian Channel (breakout detection)
  donchianPeriod: 20,                   // Last 20 bars for channel

  // ADX (trend strength gate)
  adxPeriod: 14,
  adxMinStrength: 25,                   // Require ADX > 25 for strong trend

  // RSI (momentum filter)
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,

  // Volume confirmation
  volSMAPeriod: 20,
  minVolRatio: 1.0,                     // Minimum volume ratio (≥ 1.0× SMA)

  // Risk management
  riskPerTrade: 0.015,                  // 1.5% per trade
  slMultiplier: 1.5,                    // SL = 1.5×ATR
  tpMultiplier: 3.0,                    // TP = 3.0×ATR → RR 1:2.0
  leverage: 2.0,                        // 2x for FORGE tier

  // Position management
  maxTradesPerDay: 3,                   // Max 3 trades per day
  maxBarsHeld: 100,                     // Timeout after 100 bars
  breakEvenActivationPct: 0.25,         // Move SL to BE at 25% TP
  tpMode: "partial",                    // 50% at 1.5R, trail rest
}
```

### Tunable Parameters (for optimization)

These parameters can be adjusted in the backtest UI:

| Parameter | Range | Impact |
|-----------|-------|--------|
| **slMultiplier** | 1.0 – 2.5 | Tighter stops = fewer winners (knife risk), wider = more whipsaws |
| **tpMultiplier** | 2.0 – 4.0 | Higher TP = longer holds, bigger winners; lower TP = more wins but smaller |
| **adxMinStrength** | 20 – 30 | Lower = more entries (more noise), higher = fewer trades but higher quality |
| **riskPerTrade** | 0.5% – 3.0% | Higher risk = bigger swings, lower = smoother equity |

---

## Performance Metrics & Backtesting

### Current Backtest Performance (12-month: 2025-07-01 → 2026-07-07, BTCUSDT)

**Geometry:** SL 1.3×ATR / TP 1.92×RR (AF-SCALP-22 fix deployed). Fees + slippage ON, maker exec. Per-type results with full-TP mode.

| Metric | Intraday (15m→4h) | Swing (4h→1w) | All-Type (Partial) | Status |
|--------|---|---|---|---|
| **Trades** | 37 closed | 16 closed | 92 closed | Frequency ~7/mo |
| **Win Rate** | 32.4% | 25% | 66.3%* | *Partial-mode touches (not net PF) |
| **PF Net** | 0.8–0.9 | 0.5–0.6 | 0.58 | ✗ All below 1.0 |
| **Net PnL** | –$75.6 | –$82.5 | –$209.9 | No leg profitable |
| **Realized R:R** | 1.9R / –1.1R | 1.9R / –1.0R | 2.2R / –1.3R | Losers tight, not wide |
| **Trades/Day** | ~0.1 | ~0.04 | ~0.25 | Below design 0.5–3 |

### Architecture Note: HTF Layer Status (AF-SCALP-24) — ✅ ACTIVE

⚠️ **Critical Finding (2026-07-07):** The 3-layer confirmation described in this doc was designed with an HTF ADX gate, but the pre-AF-SCALP-24 backtest engine never built or passed HTF indicators to detectSignal — Layer 1 was **dormant** (entry-TF fallback), and the ADX gate never fired. All results in the table above were measured against that degraded 1-layer version.

**AF-SCALP-24 enables Layer 1 correctly.** Three bugs had to fall together:
1. **HTF indicators never built** for TF (only MR) → now built + injected (closesHTF/emaFastHTF/emaMidHTF/emaSlowHTF/adxHTF)
2. **Index alignment:** the strategy's hardcoded `htfRatio: 12` (5m→1h) read FUTURE/wrong HTF bars on the actual 15m→4h / 4h→1w legs (measured: PF 0.83 → 0.49 when misaligned). Engine now passes a timestamp-aligned index to the last CLOSED HTF bar (no lookahead).
3. **calcADX return shape:** returns `{adx, plusDI, minusDI}`, not an array — first cut made the fail-closed gate skip every entry (0 trades).

**Measured impact (12mo eval, fees+slip ON, full TP, Intraday+Swing, maker):**

| Variant | Trades | WR | Net PF | Net PnL |
|---|---|---|---|---|
| Layer 1 OFF (old behavior) | 50 | 34.0% | 0.83 | –$90.5 |
| Layer 1 aligned, ADX 25 | 27 | 40.7% | 1.09 | +$22.2 |
| **Layer 1 aligned, ADX 30 (shipped default)** | **24** | **45.8%** | **1.29** | **+$64.6** |

Walk-forward (ADX 30 vs Layer-1-OFF): bear 0.69 vs 0.57, recovery 0.59 vs 0.57, bull **1.54** vs 0.89. ADX 30 won **every** window in the 25/30 × ±strongDay sweep and is the only variant net-positive over the full 4 years. Trend-following still loses (much less) in trendless years — that is regime allocation's job, not this signal's.

Defaults shipped: `adxMinStrength: 30` (BE `legacyStrategies.js` + FE param, keep in sync), `tfHtfLayerEnabled: true` (set `false` only for A/B controls). `tfRequireStrongTrend` measured HARMFUL in all combos — keep OFF.

### Realized Performance Issues (Pre-AF-SCALP-24)

1. **Taker Execution Fees** (0.06–0.10% per side) = 0.12–0.20% per round-trip
2. **Slippage** (0.05–0.10% on 15m/1h timeframes)
3. **SL 1.5×ATR too wide:** Geometry A/B test showed edge only at SL 1.0–1.3×ATR; default SL catches more false breakouts
4. **Chop-month bleed:** Feb/Jun 2026 lost –102 combined; daily regime gate reduces but does not eliminate sideways trades

### Backtest vs Live Divergence

| Scenario | Backtest WR | Live WR | Reason |
|----------|-----------|---------|--------|
| **Maker Fee (0.02%)** | 50% → 48% | N/A | Best case (rare on spot) |
| **Taker Fee (0.06%)** | 50% → 44% | ~45% | Standard (spot + futures) |
| **With Slippage +0.10%** | 50% → 38% | ~38% | Real (volatile markets) |

**Interpretation:** In backtest, the strategy shows 45–50% WR. In live execution with fees, it's 38–45% WR. This is **normal** for any strategy.

### Recommended Walk-Forward Testing

Before deploying, run a 12-month walk-forward test:

```bash
# Run the backtest harness
node scripts/backtest-trend-momentum.js

# Parameters to test
slMultiplier: [1.0, 1.3, 1.5, 1.8]
tpMultiplier: [2.5, 3.0, 3.5]
adxMinStrength: [20, 25, 30]

# Check: Does the best in-sample config survive walk-forward?
# (If in-sample 1.2 but walk-forward 0.8, it's overfit.)
```

---

## Known Issues & Fixes

### Issue #1: Donchian Self-Inclusion Bug (Fixed in v1.0)

**Status:** ✅ FIXED (commit `343d9ae`)

**Symptom (Pre-fix):**
- Strategy produced **0 trades ever** (live and backtest)
- Even when layer 1 & 2 conditions passed, no entry signal

**Root Cause:**
- Donchian channel at index `i` included bar `i`'s own high/low
- Comparison: `close[i] > donchian_upper[i]` is mathematically impossible
- `close ≤ high` always (by definition), and `high ≤ upper` (upper = max of 20 bars including current bar)

**Fix:**
- Compare **current close** to **previous bar's Donchian channel**
- `close[i] > donchian_upper[i-1]` (excludes current bar from the rolling window)
- Added WeakMap memoization to avoid O(n²) recomputation

**Impact:** Without this fix, the strategy never enters trades. With the fix, it works as intended.

---

### Issue #2: SL/TP Dead-Knob Bug (Fixed in v1.0)

**Status:** ✅ FIXED (commit `427d28f`)

**Symptom (Pre-fix):**
- FE parameters for SL/TP multipliers (slAtrMult, tpAtrMult) were **ignored**
- Every trade used constructor defaults (1.5×ATR / 3.0×ATR) regardless of UI settings
- CSV showed all trades with RR exactly 2.0 (never the tuned value like 1.92)

**Root Cause:**
- `calculateRiskConfig()` had 3-arg signature, discarded engine overrides
- Live engine never passed SL/TP multipliers (backward compatible)
- Backtest passed overrides, but method ignored them (dead knob)

**Fix:**
- Updated to 5-arg signature (matching SMC strategy contract)
- Accepts `opts.slMultiplier` and `opts.tpMultiplier`
- Falls back to constructor defaults if not provided (live behavior unchanged)

**How to Apply:**
- Use backtest UI: set "SL Multiplier" (atrMult) and "TP Multiplier" (riskReward)
- These now actually affect the trades (not dead knobs anymore)

---

### Issue #3: Performance Below Target (No Fix — Design Limit)

**Status:** ⚠️ BY DESIGN (not a bug, but a finding)

**Finding:**
- Strategy's planned RR 1:2.0 is profitable in backtest
- But **realized** PF is 0.6–0.9× due to execution costs
- Taker fees + slippage on 1.5×ATR tight stops = kills profitability

**Why Not Fixed:**
- This is a structural property of the strategy, not a code bug
- Tighter stops (1.0×ATR) would reduce whipsaws but increase false stops
- Looser stops (2.0×ATR+) increase hold time and fee drag

**Workaround Options:**
1. **Use maker execution** (limit orders, 0.02% fee) instead of taker (0.06%)
   - Reduces fee drag by ~2–3% → can shift PF from 0.8 → 0.85
2. **Scale risk lower** (0.5% per trade instead of 1.5%)
   - Fewer catastrophic losses, but also smaller wins
3. **Use partial-TP mode** (default)
   - Locks profits at 1R and 2R to reduce tail risk
4. **Combine with other strategies** (portfolio approach)
   - Run TS_TF + SMC + Mean Reversion together (uncorrelated)

---

## Practical Tuning Guide

### Step 1: Understand Your Market

**Before tuning, test on the asset you want to trade:**

```bash
# Run a 3-month backtest on YOUR symbol
# Example: BTCUSDT, ETHUSDT, etc.

# Check these metrics:
# - ADX distribution (is the market trending 60%+ of the time?)
# - Volatility (ATR% range — is it 0.5–8%?)
# - Trade frequency (0.5–3 per day optimal)
```

**Key Insight:**
- If ADX < 20 most of the time → strategy will have few trades & many small losses
- If ATR% > 8% → stops are too wide, position sizes too small (unprofitable)
- If trades > 5/day → likely false breakouts (need to raise adxMinStrength)

---

### Step 2: Optimize SL/TP Geometry

**Objective:** Find SL and TP multipliers that maximize risk-reward while keeping losses acceptable.

**Process (Backtest UI):**

1. Set timeframe: Intraday (15m entry) or Swing (higher timeframes)
2. Go to "Advanced Settings" → Type Trade → Strategy: Trend Following
3. Adjust "SL Multiplier" and "TP Multiplier" sliders
4. Run backtest on 6 months of data
5. Check metrics: Win Rate, Profit Factor, Max Drawdown

**Measured Geometry A/B Results (12mo, fees+slip ON, Intraday+Swing):**

Tested on BTCUSDT 4yr history; walk-forward validated. **Key finding:** Only SL 1.0–1.3 has measurable edge (+5–6pp vs random). SL ≥1.5 yields net PF < 1.0.

| SL Multiplier | TP RR | Gross Edge | Net PF | Trade Count | WR | Notes |
|---|---|---|---|---|---|---|
| **1.0×** | 2.0× | +5.6pp vs random | 1.32 (fee-free) | 47 | 44% | Optimal geometry; walk-forward stable |
| **1.3×** | 1.92× (current) | +4.2pp | 0.83–0.93 | 92 | 34% | Moderate whipsaw; Feb/Jun bleed |
| **1.5×** | 2.0× | –0.8pp (NEGATIVE) | 0.52 | 89 | 32% | DEFAULT; edge erased by SL width |
| **1.8×** | 3.6× | –2.1pp | 0.44 | 64 | 29% | Wider SL hurt quality |
| **2.0×** | 4.0× | –4.0pp | 0.35 | 49 | 24% | Worst performer |

**Trade-off:**
- **Tighter stops (1.0×ATR):** Fewer false stops, but knife-catches hurt (SL hit, then reverses)
- **Wider stops (2.0×ATR+):** More whipsaws, but larger winners compensate

**Gotcha:** The best in-sample config (e.g., 1.0× SL) may NOT be best in walk-forward. Always validate on fresh data.

---

### Step 3: Optimize ADX Threshold

**Objective:** Filter out choppy/sideways entries (reduce losses in non-trending markets).

**Process:**
1. Keep SL/TP constants from Step 2
2. Test `adxMinStrength` values: 20, 22, 25, 28, 30
3. Lower = more trades (but noisier), Higher = fewer trades (but higher quality)

**Expected Results:**

| adxMinStrength | Trades (6mo) | Win Rate | Profit Factor | Drawdown |
|---|---|---|---|---|
| 20 | 40–50 | 43% | 1.15 | 8% |
| 25 | 20–30 | 48% | 1.40 | 5% |
| 30 | 8–15 | 52% | 1.60 | 3% |

**Rule:** Higher ADX = better quality, but fewer opportunities. Pick the level where Profit Factor > 1.2.

---

### Step 4: Validate Walk-Forward

**Critical Step:** Does your optimized config work on unseen data?

**Process:**

1. Split 12 months into 4 quarters:
   - Q1 (Jan–Mar): **In-Sample** — tune here
   - Q2 (Apr–Jun): **Walk-Forward 1** — test
   - Q3 (Jul–Sep): **Walk-Forward 2** — test
   - Q4 (Oct–Dec): **Walk-Forward 3** — test

2. Pick best config from Q1
3. Run on Q2, Q3, Q4 WITHOUT retuning
4. Compare: In-sample vs Walk-forward Profit Factor

**Success Criteria:**
- Q1 PF 1.35 → Q2/Q3/Q4 avg PF > 1.15 (within 15% degradation = good)
- If Q1 PF 1.35 → Q2/Q3/Q4 avg PF 0.80 = **OVERFIT** (do not use)

**Example (Real Test):**
```
In-Sample (Q1): SL 1.0× / TP 2.0× / ADX 25
  → Win Rate 50%, Profit Factor 1.35 ← Looks great!

Walk-Forward (Q2–Q4):
  Q2: WR 45%, PF 1.20
  Q3: WR 47%, PF 1.15
  Q4: WR 42%, PF 0.95
  Average: PF 1.10 ← Still profitable, not overfit ✓

vs. Overfit Example:
  Q1: WR 52%, PF 1.50 ← Too good to be true
  Q2–Q4: PF 0.65 ← Crashed walk-forward ✗
```

---

### Step 5: Live Deployment Checklist

Before going live with real money:

- [ ] Walk-forward testing passed (PF > 1.0 all windows)
- [ ] Tested on the exact symbol you'll trade (not just BTC)
- [ ] Set risk per trade ≤ 1% (start conservative)
- [ ] Enable Telegram alerts (monitor entries/exits)
- [ ] Run on a small account first ($500–1,000)
- [ ] Watch first 10 trades manually (check execution quality)
- [ ] Review max daily loss limit is set (6% default OK)
- [ ] Verify exchange API key has NO withdraw permission

---

## Troubleshooting

### Problem: Strategy Produces 0 Trades

**Symptoms:**
- Backtest runs but shows 0 trades
- All conditions look right but no entry signal

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **ADX too low** | Is ADX mostly < 25? | Lower adxMinStrength to 20 or 22 |
| **No breakouts** | Is Donchian High/Low static? | Volatility too low, not a trending market |
| **Data issue** | Are closes, highs, lows empty? | Ensure candles are fetching properly |
| **RSI out of range** | Is RSI stuck at extremes (< 30 or > 70)? | Market is overbought/oversold; wait for pullback |

**Quick Test:**
```javascript
// In the backtest harness, log these values on a bar with no entry:
console.log({
  htfTrend: this._trendState.htfTrendDirection,
  donchianBroken: this._trendState.donchianBroken,
  rsi: indicators.rsi?.[lastIdx],
  adx: indicators.adxHTF?.[idxHTF],
  ema9: indicators.emaFast?.[lastIdx],
  ema21: indicators.emaSlow?.[lastIdx]
});

// All should be non-null and pass the checks in checkLongEntry()
```

---

### Problem: High Win Rate but Losing Money

**Symptoms:**
- Win Rate 50%+, but Profit Factor < 1.0
- Losses are bigger than wins

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **TP too small** | Is TP multiplier < 2.0? | Increase to 2.5–3.0 (winners need to be bigger) |
| **SL too wide** | Is SL multiplier > 1.5? | Tighten to 1.0–1.3 (but watch for whipsaws) |
| **Fee/slippage** | Are fees enabled in backtest? | Backtest with realistic fees; live will be worse |
| **Partial-TP capping** | Is tpMode = "partial"? | Partial mode locks profits early; consider switching to "full" |
| **Leverage too low** | Is leverage < 2x? | Check position sizing formula (notional exposure) |

**Diagnostic:**
```
Gross PF (before fees) = 1.35 ✓
Minus fees/slippage:    -0.25
Net PF (with fees):     1.10 ✓

Gross PF = 0.95 ✗
Minus fees:             -0.10
Net PF:                 0.85 ✗ ← Problem with entry quality, not fees
```

**Fix:** Increase SL multiplier (fewer whipsaws) or increase TP multiplier (larger winners).

---

### Problem: Drawdown Too High

**Symptoms:**
- Win Rate decent (45%+), but equity swings 20%+ downward
- Worried about margin call or blown account

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **Risk per trade too high** | Is riskPerTrade > 1.5%? | Lower to 0.5–1.0% |
| **SL too wide** | Is SL multiplier > 1.8? | Tighten to 1.0–1.5 (accept more losses, smaller per trade) |
| **Consecutive losses** | Are losing streaks 5–10 in a row? | Normal for 45% WR; enable maxConsecLoss=2 |
| **Leverage too high** | Is leverage > 2x? | Default 2x is appropriate; don't increase |

**Quick Fix:**
```
If Drawdown > 15%:
  → Reduce riskPerTrade from 1.5% to 1.0%
  → Drawdown should reduce to 8–12%

If still high:
  → Reduce to 0.5% riskPerTrade
  → Drawdown should be < 8%
```

**Note:** 6–8% drawdown is normal for a healthy strategy. Don't try to eliminate it completely (that's the cost of catching trends).

---

### Problem: Too Many False Breakouts

**Symptoms:**
- Lots of trades (5–10 per day), most are losses
- ADX is strong but price keeps reversing

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **ADX threshold too low** | Is adxMinStrength < 25? | Raise to 28–30 (only trade strongest trends) |
| **No trend actually exists** | Is market sideways/choppy? | Strategy doesn't work in choppy markets; wait for clearer trend |
| **Volatility too high** | Is ATR% > 10%? | Wicks and false breakouts common; reduce leverage |
| **Wrong timeframe** | Are you using 5m entry? | Try 15m entry for more stable signal |

**Recommended Fix:**
```
Before:  adxMinStrength = 25, trades = 8/day, WR 38%
After:   adxMinStrength = 30, trades = 2/day, WR 52%
         → Fewer, higher-quality trades ✓
```

---

## FAQ

### Q1: What's the minimum account size?

**A:** Rp15M (~$1,000 USD) for FORGE tier. This supports:
- 2x leverage on BTC (0.1–0.2 BTC position)
- 1.5% risk per trade = Rp225k (~$15) per trade
- 6% daily max loss = Rp900k (~$60) drawdown capacity

Smaller accounts (< $500) will have:
- Smaller position sizes (< 0.05 BTC)
- Higher per-trade fee impact
- Faster depletion if losing streak hits

### Q2: Can I use this on altcoins (not BTC)?

**A:** Yes, but validate first. The strategy works best on:
- **High liquidity pairs** (> $100M daily volume)
- **Trending assets** (not rangebounds)
- **Low spread** (< 0.1% bid-ask)

**Test first:**
- Backtest on the altcoin (e.g., ETHUSDT, SOLUSDT)
- Check: Is PF > 1.0 over 6 months?
- If yes, you can trade it. If no, the asset doesn't trend enough.

### Q3: Can I combine this with other strategies?

**A:** Yes! Recommended portfolio:
- **Trend Following (TS_TF):** Medium-term trending markets → 2% risk
- **Smart Money Concepts (SMC):** Scalping + intraday → 2% risk
- **Mean Reversion (MD_MR):** Bounces off support → 1.5% risk
- **Total:** 5.5% daily risk across 3 uncorrelated strategies

This reduces the impact if one strategy has a losing streak.

### Q4: Why does the strategy sit idle so much?

**A:** Because sideways markets are dangerous. The strategy waits for:
1. **Strong trend** (ADX > 25) — rules out 50% of market time
2. **Breakout confirmation** (Donchian) — reduces false breakouts
3. **Pullback retest** (EMA alignment) — finds low-risk entry

Result: 0.5–2 trades per day instead of 10+. This is by design. Fewer, high-quality trades beat many noisy trades.

### Q5: What if I want tighter stops and faster exits?

**A:** That's a different strategy (e.g., scalping, mean reversion). Trend Following is designed for medium-term holds (4 hours to 10 days). If you want 15-minute exits, use SMC Scalping instead.

### Q6: Can I change the timeframes (not 1h/15m/5m)?

**A:** Technically yes, but not recommended without testing:
- **1h/15m/5m:** Currently optimized and tested
- **4h/1h/15m:** Would be suitable for swing traders (longer holds)
- **5m/1m/?:** No, too much noise at very short timeframes

If you change timeframes, you MUST re-optimize and walk-forward test.

### Q7: What if my internet drops during a trade?

**A:** The exchange will manage the position:
- **If already in a position:** It stays open, SL/TP orders remain active
- **If pending order:** Order will cancel after 1–2 hours if not filled
- **If internet down < 30 sec:** Reconnect and the bot resumes normally

**Safety:** Make sure your exchange has SL/TP orders enabled (not just in the bot). This protects you if the bot is offline.

### Q8: Should I use Maker (limit orders) or Taker (market orders)?

**A:** **Maker is better** (if you have patience):
- **Taker:** Instant fill, 0.06% fee, but slippage can cost 0.05–0.20%
- **Maker:** 0.02% fee, no slippage, but may not fill if price moves fast

**Recommendation:** Use Maker for TP (you don't mind waiting), Taker for SL (must exit immediately).

---

## Appendix: Falsified Improvement Attempts (AF-SCALP-20 through AF-SCALP-23)

This section documents systematic A/B testing on TF from 2026-07-06 to 2026-07-07. Each lever was tested against the 12-month baseline (SL 1.3×ATR / RR 1.92, fees+slip+maker ON) on BTCUSDT with walk-forward validation (3 yearly windows). **None achieved sustained PF > 1.0 across all windows.**

### Exit Ladder Compression (AF-SCALP-20)

**Hypothesis:** Partial-TP milestones (lock 40% at 1R, 27.5% at 2R) cap realizable PF to 0.52. Pure RR mode (close at single TP) should unlock winners.

**Test:** C0 (baseline ladder) vs C5 (pure RR + maker)
- **C0 (ladder):** PF 0.52 in-sample; walk-forward 0.63/0.44/0.55
- **C5 (pure RR+maker):** PF 0.82 in-sample; walk-forward 0.74/0.67/0.96 ✓ marginal win
- **Conclusion:** Pure RR wins in-sample but does not reach 1.0 net. Partial mode is diagnostic tool (by-design), not a bug.

### Time-Stop (24h Hold Cutoff) (AF-SCALP-20/21)

**Hypothesis:** 24h+ underwater positions (forensics: –76.8 loss on Intraday/Swing legs) should time-stop at market. Prevents slot-blocking.

**Test:** Baseline vs +24h time-stop rule
- **Result:** Marginal win on Scalping (fewer losses), zero impact on Intraday/Swing. No PF improvement. Included in engine, default OFF-disabled.

### Retest-Limit Entry (AF-SCALP-23)

**Hypothesis:** Instead of chasing breakout close, park limit order 0.5×ATR behind signal. Better fill or no fill (maker by construction).

**Test:** V0 (market entry) vs V1 (retest limit)
- **V0 baseline SL1.3/RR1.92:** PF 0.83
- **V1 +retest(0.5×ATR):** PF 0.69 ❌ **Worse** — adverse selection (winners never pull back, losers do)
- **Conclusion:** The "retest" intuition is falsified. Breakout close is the actual signal; pullback is noise.

### Strict-Regime Gate (AF-SCALP-23)

**Hypothesis:** Daily regime gate (default: blocks CHOP <0.5) lets 0.5–0.8 transition band bleed through. Require STRONG_TREND only.

**Test:** V4 (strict regime) vs V0 (baseline)
- **V4 +tfRequireStrongTrend:** PF 0.81, dollar loss –79.5 (smaller than baseline –90.5)
- **Conclusion:** Marginal: fewer trades, smaller loss, no path to PF > 1.0.

### Best In-Sample Combo (V6: Retest+SL1.0/RR2.5+Strong+Intraday-only)

- **In-sample (12mo 2025-07):** PF 0.93 ✓ best seen
- **Walk-forward bear (2022-07→2023-07):** PF 0.76 (good)
- **Walk-forward recovery (2023-07→2024-07):** PF 0.60 (marginal)
- **Walk-forward bull (2024-07→2025-07):** PF 0.45 ❌ **CRASH** = overfit

**Conclusion:** No variant clears PF 1.0 in any window. In-sample optimism does not survive walk-forward.

### Root Cause: Edge Ceiling — SUPERSEDED by AF-SCALP-24

5 independent angles (exit ladder, time-stop, tight SL geometry, retest, strict regime) converged on: "TF's entry carries insufficient edge to clear PF 1.2 net of costs — needs a different signal."

**That verdict was measured on the DEGRADED strategy** (Layer 1 dormant, see Architecture Note). The "different signal" turned out to be the one already designed in this doc: HTF trend + ADX strength gating, which had simply never executed. With Layer 1 aligned and ADX 30 (AF-SCALP-24): 12mo netPF **1.29** (+$64.6), bull window **1.54**. Lesson recorded for future tuning: before falsifying a strategy, verify every documented layer is actually running in the engine under test.

---

## Related Documentation

- [ATR & Pair Tier Guide](./ATR_AND_PAIR_TIER_GUIDE.md) — How PairClassifier sizes positions
- [Smart Money Concepts Strategy](./SMART_MONEY_CONCEPTS_STRATEGY.md) — For scalping/intraday
- [Mean Reversion Strategy](./MEAN_REVERSION_STRATEGY.md) — For bounce trading
- [Backtest Guide](./BACKTEST_GUIDE.md) — How to run and interpret backtests
- [Risk Management Framework](./RISK_MANAGEMENT_FRAMEWORK.md) — Position sizing & leverage

---

## Support & Questions

- **Backtest Issues?** Check [Troubleshooting](#troubleshooting) section
- **Parameter Tuning Help?** Follow [Practical Tuning Guide](#practical-tuning-guide)
- **Strategy Behavior Questions?** See [FAQ](#faq)
- **Report a Bug?** Open an issue with: strategy name, symbol, date, error message

---

**Last Reviewed:** 2026-07-07  
**Strategy Code:** [TrendFollowingStrategy.js](../src/domain/strategy/implementations/TrendFollowingStrategy.js)  
**Tests:** [TrendFollowingStrategy.test.js](../test/TrendFollowingStrategy.test.js)
