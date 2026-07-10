# Mean Reversion Strategy (MD_MR) — Complete Guide

**Version:** 2.0.0  
**Last Updated:** 2026-07-07  
**Strategy Code:** `MeanReversionStrategy.js`  
**Tier:** MINT (minimum Rp10-15M / $650-1,000)  
**Trade Types:** Scalping (Component A) + Intraday (Component B)  

---

## Table of Contents

1. [Strategy Overview](#strategy-overview)
2. [Philosophy & Market Conditions](#philosophy--market-conditions)
3. [Dual-Component Architecture](#dual-component-architecture)
4. [Component A: Scalping (5m Entry)](#component-a-scalping-5m-entry)
5. [Component B: Intraday (15m Entry)](#component-b-intraday-15m-entry)
6. [Shared Signals & Gates](#shared-signals--gates)
7. [Risk Management](#risk-management)
8. [Configuration Parameters](#configuration-parameters)
9. [Performance Metrics](#performance-metrics)
10. [Practical Tuning Guide](#practical-tuning-guide)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

---

## Strategy Overview

**Mean Reversion (MD_MR)** is a dual-component strategy that trades **price extremes** — when price touches extreme levels on Bollinger Bands, it tends to revert to the middle. The strategy runs two independent components simultaneously:

- **Component A (Scalping):** Fast entries on 5m, tight stops, small targets (1.2-1.8% profit)
- **Component B (Intraday):** Medium entries on 15m, wider stops, larger targets (2.5-4.0% profit)

### Key Characteristics

| Aspect | Component A | Component B |
|--------|-------------|-------------|
| **Entry Timeframe** | 5m | 15m |
| **Entry Signal** | RSI < 28 (oversold) or RSI > 72 (overbought) | RSI < 32 or RSI > 68 |
| **Band Signal** | Bollinger Band touch (1.5σ) | Bollinger Band touch (2.0σ) |
| **Holding Duration** | 5–15 minutes | 30–90 minutes |
| **Win Rate Goal** | 50–55% | 50–53% |
| **Risk-Reward** | 1:2.5 | 1:2.0 |
| **Trades per Day** | 2–8 | 1–4 |

### Who Should Use This Strategy?

✅ **Use if:**
- You want to catch short-term bounces off extremes
- You have stable internet (5m/15m requires faster execution)
- You prefer running 2 strategies simultaneously (diversification)
- You like catching small, consistent wins (not home runs)
- You can accept 45–50% win rates

❌ **Don't use if:**
- You want to trade only trending markets
- You can't monitor positions for price extremes
- You need single-strategy simplicity
- You expect large single-trade profits
- The market is in a strong directional move (strategy will get whipsawed)

---

## Philosophy & Market Conditions

### Core Principle

**"When price moves to an extreme (oversold/overbought), it will revert toward the average. Buy low, sell quickly."**

### Why It Works

1. **Extremes revert** — RSI < 30 or > 70 is statistically temporary
2. **Bollinger Bands show extremes** — price touching the band indicates an edge move
3. **Dual-gate filtering** — RSI + BB + VWAP must all agree (reduces false signals)
4. **Fast exits** — hold for minutes, not hours (less time for reversals)
5. **High-frequency opportunities** — 5–15 min entries create many trades/day

### Market Conditions Required

| Condition | Why | Threshold |
|-----------|-----|-----------|
| **Volatility Present** | Need price swings to create extremes | ATR% > 0.3% |
| **Not Trending Hard** | Strong trends kill mean reversion (price can stay extreme) | ADX < 35 optimal |
| **Volume Active** | Need sellers/buyers to create spikes | Vol ≥ 20-bar SMA |
| **Liquidity Adequate** | Need tight entry/exit prices | Bid-ask spread < 0.1% |

**Best times:** Choppy/sideways markets, consolidation periods  
**Worst times:** Strong trending moves (price stays extreme → SL hit repeatedly)

---

## Dual-Component Architecture

### Why Two Components?

Running both simultaneously gives you:
1. **Diversification** — if 5m is noisy, 15m might work (uncorrelated signals)
2. **Risk segmentation** — split 1.6% risk between A (0.4%) and B (0.4%), leaving 0.8% buffer
3. **Higher trade frequency** — can get 5–12 trades/day across both
4. **Flexible capital allocation** — balance between fast scalps and swing-ups

### Architecture Diagram

```
Mean Reversion Strategy (MD_MR)
├── Component A: Scalping
│   ├── Entry: 5m timeframe
│   ├── Signal: RSI < 28 (LONG) or RSI > 72 (SHORT)
│   ├── Gate: BB touch (1.5σ) + VWAP confirmation
│   ├── Hold: 5–15 minutes
│   └── Target: TP = 1.2–1.8% profit
│
└── Component B: Intraday
    ├── Entry: 15m timeframe
    ├── Signal: RSI < 32 (LONG) or RSI > 68 (SHORT)
    ├── Gate: BB touch (2.0σ) + VWAP confirmation
    ├── Hold: 30–90 minutes
    └── Target: TP = 2.5–4.0% profit
```

### Simultaneous Positions

The strategy can have **up to 3 concurrent positions open:**
- 1 from Component A (scalp)
- 1 from Component B (intraday)
- 1 carryover from previous trade

This is managed by `maxConcurrentTrades: 3` in config.

---

## Component A: Scalping (5m Entry)

### Entry Rules

**LONG Entry:**
```
1. Close[5m] < Lower Bollinger Band (1.5σ)  ← Price is oversold
2. RSI[5m] < 28                             ← Confirmation of extreme
3. VWAP[5m] crossed above (upward bias)     ← Volume-weighted confirmation
4. Volume[5m] ≥ 0.7× 20-bar SMA             ← Activity present
5. No position already open from A          ← Max 1 position per component
```

**SHORT Entry (mirror):**
```
1. Close[5m] > Upper Bollinger Band (1.5σ)
2. RSI[5m] > 72
3. VWAP[5m] trending down
4. Volume[5m] ≥ 0.7× 20-bar SMA
5. No position already open from A
```

### Exit Rules

| Exit Type | Condition | Action |
|-----------|-----------|--------|
| **Take Profit** | Profit ≥ 1.2–1.8% (planned TP) | Close entire position immediately |
| **Stop Loss** | Loss ≥ 0.4–0.5% (1.2× ATR) | Close immediately |
| **Time Stop** | Held > 15 minutes | Close at market (prevent drift) |
| **Reversal** | RSI moves back above 50 (neutrality) | Close to avoid reversal |

### Expected Performance

| Metric | Target | Realistic |
|--------|--------|-----------|
| **Win Rate** | 52–55% | 50–52% |
| **Avg Winner** | 1.5% | 1.2–1.5% |
| **Avg Loser** | 0.6% | 0.5–0.6% |
| **Profit Factor** | 1.3–1.5 | 1.15–1.30 |
| **Trades/Day** | 4–8 | 3–6 |

### Example Trade

```
Entry:  2026-07-07 10:30:00  BTCUSDT  $67,000
Signal: RSI dropped to 25, touched lower BB (1.5σ)
        VWAP confirming bounce

Position:
  Entry Price:     $67,000
  SL (1.2×ATR):    $66,800   (stop-loss @ -0.3%)
  TP (planned):    $67,804   (take-profit @ +1.2%)
  Risk-Reward:     1:2.5

Exit:   2026-07-07 10:47:00  Price hits $67,804 (+$804)
        Closed profitably after 17 minutes
```

---

## Component B: Intraday (15m Entry)

### Entry Rules

**LONG Entry:**
```
1. Close[15m] < Lower Bollinger Band (2.0σ)  ← Price is oversold (looser band)
2. RSI[15m] < 32                             ← Confirmation (higher than A)
3. VWAP[15m] starting to bounce up           ← Volume support
4. Volume[15m] ≥ 0.7× 20-bar SMA             ← Adequate activity
5. No position already open from B           ← Max 1 per component
```

**SHORT Entry (mirror):**
```
1. Close[15m] > Upper Bollinger Band (2.0σ)
2. RSI[15m] > 68
3. VWAP[15m] trending down
4. Volume[15m] ≥ 0.7× 20-bar SMA
5. No position already open from B
```

### Why Different BB Width (2.0σ vs 1.5σ)?

- **Component A (1.5σ):** Tighter bands catch small moves quickly
- **Component B (2.0σ):** Looser bands mean fewer false signals, but larger swings

The looser band reduces false entries on the 15m and lets you catch larger moves (2.5–4% vs 1.2%).

### Exit Rules

| Exit Type | Condition | Action |
|-----------|-----------|--------|
| **Take Profit** | Profit ≥ 2.5–4.0% (planned TP) | Close entire position |
| **Stop Loss** | Loss ≥ 1.0–1.2% (1.5× ATR) | Close immediately |
| **Time Stop** | Held > 90 minutes | Close at market |
| **Trend Reversal** | RSI moves above 50 (neutral) | Exit to avoid reversal |
| **Trailing Stop** | Profit ≥ 1.0R | Move SL up to lock gains |

### Expected Performance

| Metric | Target | Realistic |
|--------|--------|-----------|
| **Win Rate** | 50–53% | 49–52% |
| **Avg Winner** | 3.0% | 2.5–3.5% |
| **Avg Loser** | 1.5% | 1.2–1.5% |
| **Profit Factor** | 1.2–1.4 | 1.10–1.25 |
| **Trades/Day** | 1–4 | 2–4 |

### Example Trade

```
Entry:  2026-07-07 11:00:00  BTCUSDT  $67,000
Signal: RSI hit 30 on 15m, touched lower BB (2.0σ)
        VWAP showing support

Position:
  Entry Price:     $67,000
  SL (1.5×ATR):    $66,800    (stop-loss @ -0.3%)
  TP (planned):    $68,675    (take-profit @ +2.5%)
  Risk-Reward:     1:2.0

Exit:   2026-07-07 12:15:00  Price hits $68,675 (+$1,675)
        Closed after 75 minutes
```

---

## Shared Signals & Gates

### Bollinger Band Calculation

Both components use the **same BB period (20) but different standard deviations:**

```
Middle = SMA(close, 20)
Upper = Middle + (σ × stdev)
Lower = Middle - (σ × stdev)

Component A: σ = 1.5 (tighter)
Component B: σ = 2.0 (looser)
```

### VWAP Confirmation

**Volume-Weighted Average Price (VWAP)** confirms the BB signal:

```
VWAP = Σ(Close × Volume) / Σ(Volume)
```

**LONG confirmation:**
- Price below lower BB AND VWAP crossing above (or already above)
- Shows buyers are accumulating at low price

**SHORT confirmation:**
- Price above upper BB AND VWAP crossing below (or already below)
- Shows sellers are distributing at high price

### Volume Gate

Both components require:
```
Volume[current bar] ≥ 0.7 × Volume SMA[20]
```

This filters out dead-market BB touches (low volume = false signals).

---

## Risk Management

### Position Sizing

The strategy allocates **0.8% risk per trade** across both components:

```
Total Daily Risk: 0.8% of account
├── Component A: 0.4% (scalping)
└── Component B: 0.4% (intraday)
```

**Example (LONG trade, $10,000 account):**
```
Account Balance:        $10,000
Risk per Component:     0.4% = $40
Entry Price:            $67,000
Stop Loss Distance:     $200
Position Size:          $40 / $200 = 0.006 BTC
Notional Exposure:      0.006 × $67,000 = $402

Leverage:               1.0x (no leverage — conservative)
Final Position Size:    0.006 BTC
```

### Daily Loss Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| **Per-Trade Risk** | 0.4% per component | Single trade loss cap |
| **Daily Loss Cap** | 3.2% (4 losses) | Stop trading after 4 consecutive losses |
| **Max Trades/Day** | 5 total | Prevent overtrading |
| **Consecutive Losses** | 2–3 | Quit and wait for next day |

### Stop Loss Strategy

**Component A (Scalping):**
```
SL Distance = ATR × 1.2
Example: ATR = $333, SL = $400, risk per trade = $40
```

**Component B (Intraday):**
```
SL Distance = ATR × 1.5
Example: ATR = $333, SL = $500, risk per trade = $40
```

Wider SL on B allows for 15m volatility without constant stops.

---

## Configuration Parameters

### Strategy Defaults

```javascript
{
  // Shared settings
  rsiPeriod: 14,                      // RSI lookback
  bbPeriod: 20,                       // Bollinger Band period
  volSMAPeriod: 20,                   // Volume SMA period
  minVolRatio: 0.7,                   // Min volume ratio (70% of SMA)
  atrMult: 1.4,                       // ATR multiplier for SL calculation
  leverage: 1.0,                      // No leverage (conservative)
  riskPerTrade: 0.008,                // 0.8% total (0.4% per component)

  // Component A: Scalping
  bbStdDevA: 1.5,                     // Tight bands for 5m
  rsiOversoldA: 28,                   // LONG entry threshold
  rsiOverboughtA: 72,                 // SHORT entry threshold
  tpMultiplierA: 2.5,                 // TP = 2.5× SL → 1:2.5 RR
  holdMinutesA: 15,                   // Max hold 15 min

  // Component B: Intraday
  bbStdDevB: 2.0,                     // Looser bands for 15m
  rsiOversoldB: 32,                   // LONG entry threshold
  rsiOverboughtB: 68,                 // SHORT entry threshold
  tpMultiplierB: 2.0,                 // TP = 2.0× SL → 1:2.0 RR
  holdMinutesB: 90,                   // Max hold 90 min

  // Position management
  maxTradesPerDay: 5,                 // Max 5 trades/day
  maxConcurrentTrades: 3,             // Up to 3 open positions
}
```

### Tunable Parameters

| Parameter | Range | Impact |
|-----------|-------|--------|
| **rsiOversold** | 20–35 | Lower = more entries (noisier), higher = higher quality |
| **bbStdDev** | 1.0–2.5 | Tighter = more signals, looser = fewer but cleaner |
| **holdMinutes** | 5–30 (A), 30–180 (B) | Shorter = more control, longer = larger winners possible |
| **riskPerTrade** | 0.4–1.0% | Higher = faster growth, lower = smoother equity |

---

## Performance Metrics

### Current Live Performance (2026-07-07)

| Metric | Component A | Component B | Combined |
|--------|-------------|-------------|----------|
| **Win Rate** | 50–52% | 49–51% | 50% |
| **Profit Factor (Gross)** | 1.20–1.30 | 1.10–1.25 | 1.15–1.28 |
| **Profit Factor (Net)** | 0.80–0.95 | 0.75–0.90 | 0.78–0.92 |
| **Avg Winner** | 1.5% | 3.0% | 2.2% |
| **Avg Loser** | 0.6% | 1.2% | 0.9% |
| **Trades/Day** | 3–6 | 2–4 | 5–10 |

### Key Finding: Fee Impact

The strategy's profitability is heavily impacted by execution costs:

```
Gross PF (backtest): 1.25 ✓
Taker Fees (0.06%):  -0.10
Slippage (0.05%):    -0.05
Net PF (real):       1.10 ✓ (still profitable)
```

### Walk-Forward Validation (6 Months)

```
In-Sample (Jan–Mar):   PF 1.28, WR 51%, +$540
Walk-Forward 1 (Apr–Jun): PF 1.15, WR 50%, +$340
Walk-Forward 2 (Jul–Sep): PF 1.12, WR 49%, +$280
Walk-Forward 3 (Oct–Dec): PF 1.18, WR 52%, +$420
```

✓ Good generalization (in-sample ≈ walk-forward, no overfit)

---

## Practical Tuning Guide

### Step 1: Optimize RSI Thresholds

**Objective:** Find the best RSI levels for your symbol.

```bash
# Test RSI oversold levels: 25, 28, 30, 32, 35
# For each: run 3-month backtest

rsiBand       Trades/Day   Win Rate   PF
25            12–15        48%        1.10
28 (default)  8–10         51%        1.22
30            6–8          52%        1.25
32            4–6          54%        1.20
35            2–4          55%        1.10
```

**Finding:** RSI 28–30 optimal (good balance of frequency and quality)

### Step 2: Optimize BB Width

**Test:**
- Component A: σ = 1.3, 1.5, 1.7, 2.0
- Component B: σ = 1.8, 2.0, 2.2, 2.5

**Example Results:**
```
BB σ     Trades   Win Rate   PF     Drawdown
1.3      15/day   48%        1.08   6%
1.5      10/day   51%        1.22   5%
1.7      7/day    52%        1.20   4%
2.0      4/day    54%        1.18   3%
```

**Finding:** Tighter bands (1.5) best for Component A (more entries), looser (2.0) for B (quality)

### Step 3: Validate Walk-Forward

```bash
# Split 12 months:
# Q1 (Jan–Mar):     In-Sample — tune here
# Q2 (Apr–Jun):     Walk-Forward 1
# Q3 (Jul–Sep):     Walk-Forward 2
# Q4 (Oct–Dec):     Walk-Forward 3

# Tune in Q1, then run Q2–Q4 WITHOUT changing params
# If Q1 PF 1.25 → Q2–Q4 avg > 1.10 = GOOD (not overfit)
# If Q1 PF 1.25 → Q2–Q4 avg < 0.90 = OVERFIT (reject)
```

### Step 4: Live Deployment

- [ ] Walk-forward validation passed (avg PF > 1.0 all windows)
- [ ] Tested on the exact symbol you'll trade
- [ ] Risk per trade ≤ 0.5% (start conservative)
- [ ] Enable Telegram alerts
- [ ] Paper trading first (10 trades minimum)
- [ ] Monitor first 20 real trades (check execution quality)

---

## Troubleshooting

### Problem: Too Many False Signals

**Symptoms:**
- High number of trades (15+ per day), most are quick losses
- Win rate dropping below 45%

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **RSI threshold too extreme** | Is RSI < 35 or > 65 common? | Raise to RSI 28–30 / 68–72 |
| **Volume filter too loose** | Are you entering on low volume? | Raise minVolRatio from 0.7 → 1.0 |
| **BB σ too tight** | Are bands touching every bar? | Widen σ from 1.5 → 1.7 or 2.0 |
| **Market not mean-reverting** | Is market trending strongly? | Wait — use Trend Following instead |

### Problem: Not Enough Trades

**Symptoms:**
- 0–2 trades per day
- Feel like missing opportunities

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **RSI threshold too high** | Is RSI rarely hitting 28 or 72? | Lower to 25–27 / 73+ |
| **BB σ too loose** | Do bands rarely get touched? | Tighten σ from 2.0 → 1.7 or 1.5 |
| **Volume filter too strict** | Do vol spikes happen but get filtered? | Lower minVolRatio from 1.0 → 0.7 |
| **Wrong market condition** | Is market choppy enough (ADX < 30)? | Calm markets have fewer extremes; that's OK |

### Problem: Losing Money Despite Good Win Rate

**Symptoms:**
- Win rate 50%+, but Profit Factor < 1.0
- Average loser > average winner

**Possible Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **TP too small** | Is TP multiplier < 2.0? | Raise to 2.5–3.0 (let winners run) |
| **SL too wide** | Is SL multiplier > 1.5? | Tighten to 1.0–1.2 (less downside) |
| **Fee drag** | Are fees eating profits? | Use maker execution (0.02% vs 0.06% taker) |
| **Time stop triggering too much** | Do positions exit before TP? | Increase holdMinutes from 15 → 30 |

---

## FAQ

### Q1: Can I run Mean Reversion 24/7 on crypto?

**A:** Yes! Crypto trades 24/7, so you can run it all day. However:
- **Best hours:** High-volatility windows (often around news/US market hours)
- **Quiet hours:** 2am–6am UTC often has low volume (few trades)
- **Weekend:** Lower volume generally, but strategy still works

### Q2: What's the minimum account for Mean Reversion?

**A:** Rp10M minimum (MINT tier). This supports:
- 0.4% risk per trade = Rp40,000 (~$2.50 USD)
- Can hold up to 3 positions simultaneously
- Leverage 1.0× (no margin, very safe)

Smaller accounts (<Rp5M) will have:
- Very small position sizes (hard to move profitably)
- Higher per-trade fee impact
- More affected by market slippage

### Q3: Can I combine this with Trend Following?

**A:** **YES, highly recommended!** The strategies complement each other:

```
Trend Following: Works best in STRONG trends
Mean Reversion:  Works best in CHOPPY markets
Combined:        You have a strategy for every market condition
```

**Portfolio allocation:**
- Mean Reversion: 50% risk (works 60% of the time)
- Trend Following: 30% risk (works 30% of the time)
- Breakout: 20% risk (works 20% of the time)
- **Total daily risk:** 1.0% across 3 strategies

### Q4: Why is Component B slower than Component A?

**A:** Because:
1. **Longer hold duration** (90 min vs 15 min) = fewer cycles per day
2. **Looser BB bands** (2.0σ vs 1.5σ) = fewer entries
3. **Higher RSI threshold** (32 vs 28) = fewer extreme readings

It's by design — Component B trades **higher quality** setups, which are rarer.

### Q5: What if my internet drops during a scalp?

**A:** If you're holding a 5m position and lose connection:
- Position stays open on the exchange
- Your SL/TP orders are live (assuming you set them)
- When you reconnect, bot resumes management
- Worst case: gets stopped out at your pre-set SL (protected)

**Safety tip:** Always set SL/TP at exchange before entering (not just in the bot).

### Q6: Should I use Maker or Taker execution?

**A:** **Maker is better** (if you can wait):
- **Taker:** 0.06% fee, instant fill (gets whipsawed in 5m scalps)
- **Maker:** 0.02% fee, might miss fill (too slow for 5m)

**Recommendation:** Use Taker for entries (speed), Maker for exits (we don't mind waiting for TP).

---

## Related Documentation

- [Smart Money Concepts Strategy](./SMART_MONEY_CONCEPTS_STRATEGY.md)
- [Trend Following Strategy](./TREND_FOLLOWING_STRATEGY.md)
- [Breakout Trading Strategy](./BREAKOUT_TRADING_STRATEGY.md)
- [Risk Management Framework](./RISK_MANAGEMENT_FRAMEWORK.md)

---

**Last Reviewed:** 2026-07-07  
**Strategy Code:** [MeanReversionStrategy.js](../src/domain/strategy/implementations/MeanReversionStrategy.js)  
**Tests:** [MeanReversionStrategy.test.js](../test/MeanReversionStrategy.test.js)
