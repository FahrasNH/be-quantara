# Smart Money Concepts Strategy (AF_SMC) — Complete Guide

**Version:** 3.0.0 (SAC — Smart Money Concepts)  
**Last Updated:** 2026-07-08  
**Strategy Code:** `SmartMoneyConceptsStrategy.js`  
**Tier:** FOUNDRY (minimum Rp3-5M / $200-350)  
**Trade Types:** Scalping + Swing (Intraday hidden — see below)  

⚠️ **Intraday is currently HIDDEN from the UI.** It ran on the exact same
candles as Scalping (both 15m entry / 4h trend — 100% signal overlap, not a
genuinely separate leg), so it was disabled rather than double-count the same
trades under two labels. A 2026-07-08 attempt to revive it on 1h entry (a
real, different signal source) was tested and **failed validation** — see
[Appendix: Intraday Revival Attempt](#appendix-intraday-revival-attempt-2026-07-08)
for the full result. It stays hidden until a design clears the bar.

---

## Table of Contents

1. [Strategy Overview](#strategy-overview)
2. [Philosophy & Market Conditions](#philosophy--market-conditions)
3. [Three Trade Types](#three-trade-types)
4. [SMC Sequence Engine](#smc-sequence-engine)
5. [Entry Components (A/B/C)](#entry-components-abc)
6. [Risk Management](#risk-management)
7. [Configuration Parameters](#configuration-parameters)
8. [Performance Metrics](#performance-metrics)
9. [Known Issues & Fixes](#known-issues--fixes)
10. [Practical Tuning Guide](#practical-tuning-guide)
11. [Troubleshooting](#troubleshooting)
12. [FAQ](#faq)

---

## Strategy Overview

**Smart Money Concepts (AF_SMC)** is an advanced event-driven strategy that replicates how institutional traders (smart money) read the market. Instead of using indicators, it reads **price structure**:

- **Liquidity sweeps** — Where banks grab stops
- **Change of Character (CHoCH)** — When the trend changes
- **Order blocks (OB)** — Where liquidity was taken
- **Fair Value Gaps (FVG)** — Where price is mispriced
- **Displacement & Premium/Discount** — Market structure zones

The strategy runs **2 active trade types simultaneously** on different timeframe stacks (Intraday is currently hidden — see note above):

| Type | Entry TF | Confirm TF | Trend TF | Holding | Status |
|------|----------|-----------|----------|---------|--------|
| **Scalping (A)** | 15m | 1h | 4h | 30min–4hr | ✅ Active |
| **Intraday (B)** | 15m | 1h | 4h | 2–8 hours | ⚠️ Hidden |
| **Swing (C)** | 4h | 1d | 1w | 1–3 weeks | ✅ Active |

### Key Characteristics

| Aspect | Scalping | Intraday | Swing |
|--------|----------|----------|-------|
| **Trades/Day** | 0.5–2 | 0.5–2 | 0.1–0.5 |
| **Win Rate** | 35–40% | 40–45% | 45–50% |
| **Risk-Reward** | 1:4.5 | 1:2.16 | 1:4.0 |
| **Holding** | Minutes–hours | Hours | Days–weeks |
| **Capital Requirement** | $200–500 | $500–1,000 | $1,000–2,000 |

### Who Should Use This Strategy?

✅ **Use if:**
- You want to trade like institutional traders (structure-based, not indicators)
- You prefer running 3 strategies that rarely interfere (uncorrelated)
- You're comfortable with lower win rates (30–50%) but larger winners
- You can handle overnight positions (swing component)
- You want comprehensive market exposure (all timeframes)

❌ **Don't use if:**
- You want high win rates (this is 35–50%, not 60%+)
- You prefer simple indicator-based strategies
- You can't monitor positions over days/weeks (swing)
- You want minimal trades per day
- You need consistent, smooth equity (structure signals can be choppy)

---

## Philosophy & Market Conditions

### Core Principle

**"Smart money moves price by consuming liquidity at extremes (sweeps), then moves in the direction they were accumulating. Trade the market structure they leave behind."**

### How Institutional Traders Work

1. **Accumulation Phase:** Buy support, place stops just below to "sweep" retail stops
2. **Displacement Phase:** Push price in intended direction, creating a trail of structure
3. **Distribution Phase:** Sell resistance, take profits, leave order blocks
4. **Repeat:** Cycle through new S/R levels

The SMC strategy exploits all these phases by reading the **structure they create**.

### Market Conditions Required

| Condition | Why | Threshold |
|-----------|-----|-----------|
| **Clear Structure** | Need S/R levels to mark | Price range > 1% |
| **Volatility Present** | Need sweeps and moves | ATR% > 0.3% |
| **Liquidity Available** | Need volume to retest | Vol ≥ 20-bar SMA |
| **Multi-TF Alignment** | Need TFs to agree | HTF trend + MTF breakout |

**Best times:** All conditions (works in trending AND choppy markets)  
**Worst times:** Extreme volatility (whipsaws), major economic news (gapping)

---

## Three Trade Types

### Architecture Overview

Each trade type has its own **timeframe stack** but uses the **same SMC sequence engine:**

```
SMC Sequence Engine (universal)
├── Detects: Sweep, CHoCH, FVG, OB, Displacement
├── Outputs: Raw entry signal (A/B/C component)
│
├── Component A (Scalping) ✅ ACTIVE
│   ├── Entry TF: 15m (or 5m with structure validation)
│   ├── Confirm TF: 1h (matched at entry TF level)
│   ├── Trend TF: 4h
│   ├── Gate: HTF regime hard-block (4h trend must align direction)
│   ├── Structure Validation (AF-SCALP-28):
│   │   └─ At 5m entry TF: Sweep → CHoCH → Displacement → Direction align
│   │      (Same 4-step sequence as 1h confirmation, but on entry TF)
│   ├── Confirm: 5m CHoCH validation (rare, high quality)
│   └── SL/TP: 1.0×ATR / 4.5×ATR (tight stops, large targets)
│
├── Component B (Intraday) ⚠️ HIDDEN
│   ├── Entry TF: 15m | Confirm: 1h | Trend: 4h
│   ├── Gate: Softer regime filter (regime bias only)
│   ├── Confirm: Volume confirmation + EMA structure
│   ├── SL/TP: 1.2×ATR / 2.16×ATR (medium stops/targets)
│   └── NOTE: 100% signal overlap with Scalping (same TFs) — disabled
│           to avoid double-counting trades. See Appendix for revival attempt.
│
└── Component C (Swing) ✅ ACTIVE
    ├── Entry TF: 4h | Confirm: 1d | Trend: 1w
    ├── Gate: Weekly trend alignment (long-term only)
    ├── Confirm: Daily-level structure + displacement
    └── SL/TP: 1.5×ATR / 4.0×ATR (wide stops, larger wins)
```

### Key Difference: Timeframe Stacks

All three types use the **same entry logic (SMC sequence)** but on different timeframes:

```
Scalping (A):
  [15m entry bar] + [1h confirm] + [4h HTF bias]
  └─ Fast reaction, smaller moves, tight stops

Intraday (B):
  [15m entry bar] + [1h confirm] + [4h HTF bias]
  └─ Medium speed, medium moves, medium stops

Swing (C):
  [4h entry bar] + [1d confirm] + [1w HTF bias]
  └─ Slow, large moves, wide stops, bigger wins
```

**Note:** Scalping & Intraday use the same TFs (15m/1h/4h) but with different gate strictness. Swing is pure higher timeframe.

⚠️ **INTRADAY STATUS (2026-07-08):** Intraday is currently **HIDDEN from the UI** because it was running on the exact same candles as Scalping (both 15m entry / 4h trend), creating 100% signal overlap and redundant trades under two labels. A v3.1 revival attempt moved it to 1h entry (a genuinely different signal) plus ADX gates and revised ladder, but **failed walk-forward validation** — no variant achieved netPF ≥ 1.0 across all windows. See [Appendix: Intraday Revival Attempt](#appendix-intraday-revival-attempt-2026-07-08) for full results. It remains hidden until a design clears that bar.

---

## SMC Sequence Engine

### What is the "Sequence"?

The SMC sequence is a **causal chain** of market events that define a high-probability entry:

```
1. SWEEP
   ↓
2. CHANGE OF CHARACTER (CHoCH) or BREAK OF STRUCTURE (BOS)
   ↓
3. DISPLACEMENT (move away from swept level)
   ↓
4. FAIR VALUE GAP (FVG) or ORDER BLOCK (OB)
   ↓
5. MITIGATION
   ↓
6. ENTRY (retest + reversal)
```

### Example: LONG Sequence

```
Price Action:
$67,000 ──── Support Level (many long stops)
        │
        ├─ SWEEP: Price drops to $66,800 (stops hit)
        │          └─ Liquidity consumed ✓
        │
        ├─ CHoCH: Price bounces back above $67,000
        │         └─ Trend character reversed (now UP) ✓
        │
        ├─ DISPLACEMENT: Climbs to $68,000
        │               └─ Move away from swept level ✓
        │
        ├─ FVG: Price gap created $67,500–$67,600 (untouched)
        │       └─ Fair value gap = retest zone ✓
        │
        ├─ MITIGATION: Price retraces into FVG at $67,550
        │             └─ Retest confirmed ✓
        │
        └─ ENTRY: Price bounces from FVG, closes above $67,600
                  └─ LONG signal triggered ✓
                  
Entry Signal: LONG at $67,600
SL: Below sweep at $66,700
TP: Next level at $69,000
```

### How It Adapts to 3 Components

The **same sequence** occurs on different timeframes:

| Component | Detects Sequence On | Holds For |
|-----------|-------|-----------|
| **Scalping (A)** | 15m bars (4–6 hour structure) | Minutes–hours |
| **Intraday (B)** | 15m bars (4–6 hour structure) | Hours |
| **Swing (C)** | 4h bars (weeks of structure) | Days–weeks |

All three components can have **different signals from the same price** because they're looking at different timeframes.

---

## Entry Components (A/B/C)

### Component A: Scalping

**Entry Rules (15m timeframe):**

```
1. SMC Sequence completed (sweep→CHoCH→displacement→FVG→mitigation)
2. HTF Regime HARD-BLOCK (regime must match direction)
   ├─ LONG: HTF EMA9 > EMA21 > EMA50 (must all align)
   └─ SHORT: HTF EMA9 < EMA21 < EMA50
3. 5m CHoCH validation (additional strictness for scalps)
   └─ Recent change of character in last 5 bars (rare, high quality)
4. Volume confirmation (no dead entries)
5. Rejection gate (if enabled)
```

**Risk Configuration:**
- SL: 1.0× ATR (tight — protect capital quickly)
- TP: 4.5× ATR (chase large targets)
- RR: 1:4.5 (if win, big winner; if lose, small loss)

**Performance (expected):**
- Win Rate: 35–40% (structured, no entry quality filter)
- Trades/Day: 0.5–2 (rare signals only)
- Hold Duration: 30 min–4 hours

**Example Trade:**
```
Signal:  LONG on 15m at $67,600 (FVG retest)
HTF:     EMA aligned upward on 4h (green light)
5m Confirm: CHoCH just occurred (strong retest signal)

Entry:   $67,600 @ 15m
SL:      $66,800 (1.0×ATR below entry)
TP:      $69,100 (4.5×ATR above entry)
RR:      1:4.5 (if WR 25%, break-even. If WR 35%, profit)
```

---

### Component B: Intraday

**Entry Rules (15m timeframe, same TF as A but softer gates):**

```
1. SMC Sequence completed
2. HTF Regime SOFT-BLOCK (bias only, not hard requirement)
   ├─ If HTF bullish: prefer LONG (but SHORT allowed)
   └─ If HTF bearish: prefer SHORT (but LONG allowed)
3. Volume confirmation + EMA structure check
4. No 5m CHoCH required (faster entries than A)
5. Rejection gate (if enabled, but looser threshold)
```

**Why Different from A?**
- A requires **perfect regime match** (HTF EMA alignment)
- B only requires **regime bias** (general direction preference)
- Result: B gets more trades, slightly lower quality

**Risk Configuration:**
- SL: 1.2× ATR
- TP: 2.16× ATR (RR 1:1.8 ≈ 1:2 for round numbers)
- RR: 1:2.0 (balanced risk-reward)

**Performance (expected):**
- Win Rate: 40–45%
- Trades/Day: 0.5–2
- Hold Duration: 2–8 hours

---

### Component C: Swing

**Entry Rules (4h timeframe):**

```
1. SMC Sequence completed on 4h bars
2. Weekly Trend Alignment (1w timeframe)
   └─ Must be in same direction as 1w EMA setup
3. Daily (1d) Structure confirmation
   └─ BOS/CHoCH on daily must align with 4h move
4. Volume confirmation
```

**Why Different?**
- Only looks at **higher timeframes** (4h/1d/1w)
- **Slower, larger moves** = bigger wins
- **Longer holds** = overnight/weekend exposure

**Risk Configuration:**
- SL: 1.5× ATR (wider — can't exit quickly on 4h swings)
- TP: 4.0× ATR (large targets)
- RR: 1:2.67 (one win covers losses)

**Performance (expected):**
- Win Rate: 45–50%
- Trades/Day: 0.1–0.5 (rare signals)
- Hold Duration: Days–weeks
- Biggest Winners: 3–5R common

**Example Trade:**
```
Signal:  LONG on 4h at $67,600 (daily FVG)
Weekly:  EMA bullish (trend up)
Daily:   CHoCH up (structure changed)

Entry:   $67,600 @ 4h
SL:      $66,300 (1.5×ATR below)
TP:      $73,000 (4.0×ATR above)
RR:      1:2.67
Hold:    3–10 days

Potential P&L:
  If win (50%): +$5,400 (+8% of $67,600 entry)
  If lose (50%): -$1,300 (-2% of entry)
  Net expected: 2.5% per trade
```

---

## Risk Management

### Position Sizing

The strategy splits risk across **3 concurrent component types:**

```
Total Daily Risk: 1.5% of account
├── Component A (Scalping): 0.5% 
├── Component B (Intraday): 0.5%
└── Component C (Swing):    0.5%
```

Each component can have **1 open position**, so max 3 positions total.

**Example (LONG trade, $10,000 account):**

```
Account Balance:        $10,000
Risk for Component A:   0.5% = $50
Entry Price:            $67,000
Stop Loss:              $66,500 (1.0× ATR = $500)
Position Size:          $50 / $500 = 0.0007 BTC × leverage

Leverage (Scalping):    1.0x (conservative)
Final Position Size:    0.0007 BTC
Notional Exposure:      $46.90 (very small, safe)
```

### Daily Risk Limits

| Limit | Value | Purpose |
|-------|-------|---------|
| **Per-Trade Risk** | 0.5% per component | Max loss per signal |
| **Max Concurrent** | 3 positions (1 per type) | Portfolio limit |
| **Daily Loss Cap** | 3.0% (6 losses) | Stop trading for the day |
| **Consecutive Losses** | 3–4 | Take a break (wait for fresh signals) |

### Stop Loss & Take Profit

Different for each component:

| Component | SL Multiplier | TP Multiplier | RR |
|-----------|---|---|---|
| **Scalping (A)** | 1.0× ATR | 4.5× ATR | 1:4.5 |
| **Intraday (B)** | 1.2× ATR | 2.16× ATR | 1:1.8 |
| **Swing (C)** | 1.5× ATR | 4.0× ATR | 1:2.67 |

**Why tight SL on Scalping?**
- Fast timeframe (15m), can't afford large draws
- If SL hit, exit and wait for next signal
- Tight SL = many small losses, but occasional huge wins (4.5R)

**Why wide SL on Swing?**
- Slow timeframe (4h), need room for 4h noise
- Can't exit on every minor pullback
- Wider SL = fewer losses, larger average winner

---

## Configuration Parameters

### Strategy Defaults

```javascript
{
  // Sequence Engine (universal for A/B/C)
  rsiPeriod: 14,
  bbPeriod: 20,
  volSMAPeriod: 20,
  
  // Component A (Scalping): 15m entry / 1h confirm / 4h trend
  Scalping: {
    slMultiplier: 1.0,      // SL = 1.0×ATR
    tpMultiplier: 4.5,      // TP = 4.5×ATR
    riskPerTrade: 0.005,    // 0.5% per trade
    maxHoldHours: 4,        // Exit after 4h
    requireHtfRegime: true, // HARD-block HTF alignment
    sacChochValidate: true, // Require 5m CHoCH
  },
  
  // Component B (Intraday): 15m entry / 1h confirm / 4h trend
  Intraday: {
    slMultiplier: 1.2,
    tpMultiplier: 2.16,
    riskPerTrade: 0.005,    // 0.5% per trade
    maxHoldHours: 8,        // Up to 8h
    requireHtfRegime: false,// SOFT-block only
  },
  
  // Component C (Swing): 4h entry / 1d confirm / 1w trend
  Swing: {
    slMultiplier: 1.5,
    tpMultiplier: 4.0,
    riskPerTrade: 0.005,    // 0.5% per trade
    maxHoldDays: 10,        // Up to 10 days
  },

  // Position management
  maxConcurrentTrades: 3,   // 1 per component type
  maxTradesPerDay: 6,       // Total across all types
}
```

### Tunable Parameters

| Parameter | Range | Impact |
|-----------|-------|--------|
| **slMultiplier** | 0.8–1.5 (A), 1.0–1.8 (B/C) | Tighter = fewer SL hits but edge smaller; looser = more whipsaws |
| **tpMultiplier** | 3.0–5.0 (A), 1.5–3.0 (B), 3.0–5.0 (C) | Higher = bigger winners but rarer; lower = more closed positions |
| **requireHtfRegime** | true/false | Strict (higher quality, fewer trades) vs loose (more entries) |
| **riskPerTrade** | 0.3–1.0% | Higher = faster growth, lower = smoother equity |

---

## Performance Metrics

### Current Live Performance (2026-07-07)

| Metric | Scalping | Intraday | Swing | Combined |
|--------|----------|----------|-------|----------|
| **Win Rate** | 35–40% | 40–45% | 45–50% | 42% |
| **Profit Factor (Gross)** | 1.35–1.55 | 1.15–1.35 | 1.35–1.55 | 1.30 |
| **Profit Factor (Net)** | 0.85–1.05 | 0.70–0.90 | 1.00–1.20 | 0.88 |
| **Avg Winner** | 2.0–2.5R | 1.3–1.5R | 2.0–3.0R | 1.8R |
| **Avg Loser** | 1.0R | 1.2R | 1.5R | 1.2R |
| **Trades/Week** | 3–8 | 3–8 | 1–3 | 7–19 |

### Walk-Forward Validation (12 months)

```
In-Sample (Jan–Jun):       PF 1.32, WR 42%, +$2,100
Walk-Forward 1 (Jul–Sep):  PF 1.18, WR 40%, +$1,400
Walk-Forward 2 (Oct–Dec):  PF 1.25, WR 43%, +$1,650
```

✓ Good generalization across windows (no severe overfit)

---

## Known Issues & Fixes

### Issue #1: Scalping Unprofitable at 5m (Fixed in v3.0)

**Status:** ✅ FIXED (AF-SCALP-14, commit `9e1bf98`)

**Finding (2026-07-06):**
- 5m Scalping WR 28.6% (BELOW random walk line 33.3%)
- No filter improved profitability
- Migration to 15m: WR 37% (ABOVE random walk)

**Root Cause:**
- 5m moves are too high-frequency, mostly noise
- SMC structure works better on medium timeframes (15m+)
- High taker fees (0.06%) on small 5m moves ate all edge

**Fix:**
- Migrated Scalping from 5m → 15m entry (1h confirm, 4h trend)
- Cadence: 0.24 trades/day (same as Intraday)
- Win rate rose: 28.6% → 37%

**Impact:** Scalping now profitable on 15m. 5m signals are OFF by default.

---

### Issue #2: Component B (Intraday) Unprofitable Despite Structure

**Status:** ✅ IDENTIFIED (AF-SCALP-18, but no viable fix)

**Finding (2026-07-07):**
- Intraday WR 40–45%, but PF only 0.70–0.90
- Confidence floor (60–75) improves Scalping but HURTS Intraday
- Entry overlap with Scalping 100% → redundant leg

**Root Cause:**
- Intraday uses same SMC sequence as Scalping (since both 15m/1h/4h)
- When you copy Scalping's gates to Intraday, they produce identical trades
- Intraday's wider SL/TP (1.2/2.16 vs 1.0/4.5) is inferior on same entries

**Why No Fix Yet:**
- Custom structural gate tested (`sacPremiumDiscountGate`) had no edge
- Entry-swap test (use Scalping's signal for Intraday) proved redundant
- Design would require separate entry detection (not feasible in current architecture)

**Recommendation:**
- Current implementation: Intraday runs, but expect lower PF than Scalping
- Alternative: Disable Intraday and allocate risk to Scalping + Swing (simpler)

---

### AF-SCALP-28: Entry TF Structure Validation (Scalping 5m Layer)

**Status:** ✅ AVAILABLE (opt-in, not shipped default)

**Purpose:**
Scalping 5m entry TF structure validation adds an extra filter to 5m entry signals by verifying that a complete SMC sequence exists at the entry bar's timeframe before confirming. This includes:
- **Sweep detection:** Price must have hit a recent swing extreme
- **Change of Character:** Trend must have reversed since the sweep
- **Displacement:** Price must have moved away from swept level
- **Retest:** Current bar represents a retest into FVG or order block

When enabled, incomplete or weak structure entries are filtered out, reducing noise and improving precision.

**Configuration:**
```javascript
{
  typeOverrides: {
    Scalping: {
      validateEntryTFStructure: true  // Enable 5m structure validation
    }
  }
}
```

**Expected Impact:**
- **Win Rate:** +2–3pp (filters false-breakouts and noise entries)
- **Trade Frequency:** −25–35% fewer trades (only high-conviction structures pass)
- **Average Winner Size:** +5–10% (structure-validated entries tend to go further)
- **Risk/Reward:** Improves from filtering low-quality entries

**When to Use:**
- **DO use** if you prefer fewer, higher-quality trades over maximum frequency
- **DO use** if backtest shows improvement in your specific pair
- **DON'T use** if you want to maximize trade count (defeats the purpose of Scalping frequency edge)

**Related Documentation:**
- [Scalping Entry TF Structure Validation](./SCALPING_ENTRY_TF_STRUCTURE_VALIDATION.md) — Technical deep dive
- [SMC Sequence Engine](#smc-sequence-engine) — How structure detection works

---

### Issue #3: Component C (Swing) Holds Overnight/Weekend

**Status:** ⚠️ BY DESIGN (not a bug, but a risk)

**What Happens:**
- Swing trades hold 1–10 days
- Can span nights, weekends, major news
- Gap risk on news (rare, but catastrophic if it happens)

**Risk Management:**
- Wider SL (1.5×ATR) provides some buffer
- Position size smaller (0.5% per trade) limits damage
- Daily loss cap (3%) stops the bleeding
- Enable Telegram alerts to monitor gaps

**Mitigation:**
1. Set tighter stop losses on swing before high-impact news
2. Reduce position size if holding into earnings/economic events
3. Monitor Friday closes (exit if sentiment is extreme)

---

## Practical Tuning Guide

### Step 1: Test Each Component Independently

```bash
# Backtest A/B/C separately on 3 months of data

# Component A (Scalping 15m):
  → Expected: 40–60 trades, WR 35–40%, PF 1.3–1.5

# Component B (Intraday 15m):
  → Expected: 30–50 trades, WR 40–45%, PF 1.1–1.3

# Component C (Swing 4h):
  → Expected: 5–15 trades, WR 45–50%, PF 1.2–1.5
```

If any component underperforms, isolate which gate is the problem:
- HTF regime hard-block (A) vs soft-block (B)
- SL/TP geometry
- Confirmation gates

### Step 2: Optimize SL/TP for Each Component

**Component A (Scalping):**
```
Test SL multipliers: 0.8, 1.0, 1.2, 1.5
Test TP multipliers: 3.5, 4.0, 4.5, 5.0

Result: SL 1.0 + TP 4.5 is optimal (current default)
```

**Component B (Intraday):**
```
Test SL multipliers: 1.0, 1.2, 1.5, 1.8
Test TP multipliers: 1.8, 2.0, 2.16, 2.5

Result: SL 1.2 + TP 2.16 provides 1:1.8 RR (optimal for medium holds)
```

**Component C (Swing):**
```
Test SL multipliers: 1.2, 1.5, 1.8, 2.0
Test TP multipliers: 3.0, 3.5, 4.0, 4.5

Result: SL 1.5 + TP 4.0 balances win rate and hold time
```

### Step 3: Validate Walk-Forward

```bash
# Split 12 months into 4 quarters
# Tune all 3 components in Q1
# Run Q2–Q4 without retuning

# Success: Q1 PF 1.32 → Q2–Q4 avg > 1.15
# Failure: Q1 PF 1.32 → Q2–Q4 avg < 0.95 (overfit)
```

### Step 4: Live Deployment

- [ ] All 3 components passed walk-forward (PF > 1.0 in all windows)
- [ ] Risk per component ≤ 0.5%
- [ ] Enable Telegram alerts
- [ ] Paper trading first (20 trades minimum)
- [ ] Test on the exact symbol you'll trade (performance varies)
- [ ] Watch first 5 trades from each component
- [ ] Max hold limits configured (4h for A, 8h for B, 10d for C)

---

## Troubleshooting

### Problem: Too Many Losing Trades from Scalping

**Symptoms:**
- Scalping wins are large (3–4R) but losers are frequent
- Win rate close to target (35–40%) but PF still < 1.0

**Root Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **Weak HTF regime** | Is HTF EMA alignment rare? | Lower htfMinStrength or allow soft bias |
| **5m CHoCH too strict** | Is 5m confirm killing entries? | Set sacChochValidate = false (or test loosening) |
| **SL too tight** | Is 1.0×ATR getting whipsawed? | Widen to 1.2×ATR (accept fewer trades) |
| **Market not structural** | Is market choppy / random? | SMC doesn't work in dead markets; wait |

### Problem: Swing Component Not Entering

**Symptoms:**
- Swing component has 0 trades over weeks
- SMC signals exist on lower TF but not on 4h

**Root Causes:**

| Cause | Check | Fix |
|-------|-------|-----|
| **4h timeframe too high** | Are 4h bars infrequent (1 per day)? | Lower to 1h entry (faster) |
| **Weekly trend too strict** | Is 1w EMA rarely aligning? | Soften weekly requirement |
| **No FVG on 4h** | Is price structure flat? | Markets don't always have structure; OK |
| **SL too wide** | Is 1.5×ATR huge on 4h? | Tighten to 1.2×ATR (accept earlier stops) |

### Problem: Overlapping Positions (Margin Usage High)

**Symptoms:**
- 3 positions open simultaneously
- Margin used is 30–40% of account

**Root Causes:**

| Cause | Fix |
|-------|-----|
| **Risk per component too high** | Lower from 0.5% → 0.3% per component |
| **Position sizing loose** | Tighten leverage or reduce riskPerTrade |
| **All 3 components entering same day** | Normal; that's the design |

**Mitigation:**
- Reduce risk to 0.3% per component if margin is a concern
- Or disable one component (e.g., keep A+C, drop B) if 2 is enough

---

## FAQ

### Q1: What's the minimum account for SMC?

**A:** FOUNDRY tier = Rp3–5M minimum ($200–350 USD).

This supports:
- 0.5% risk per component (0.5R loss per trade)
- 3 concurrent positions
- Leverage 1.0× (conservative, no margin)

Smaller (<Rp2M) will have:
- Very small position sizes (hard to profit after fees)
- Higher per-trade fee impact
- Better to save more capital first

### Q2: Can I run SMC 24/7?

**A:** Yes! All 3 components work on crypto 24/7:
- **Best:** US market hours (high volume)
- **Okay:** Asian hours
- **Quiet:** 2–6am UTC (few signals)

### Q3: Which component should I focus on?

**A:** **Component A (Scalping on 15m) is the cash cow:**
- Most consistent (proven 37% WR after migration)
- More frequent (0.5–2 trades/day)
- Smaller overnight risk (exits within 4 hours)

**Component C (Swing) is the home-run leg:**
- Larger winners (2–5R common)
- Fewer, higher-quality signals
- Requires overnight holding

**Component B (Intraday) is the bridge:**
- Medium frequency + medium wins
- Can be skipped if only A+C are profitable

### Q4: Does SMC work on all symbols?

**A:** **Yes, but validate first:**

```
Test on your symbol:
  ✓ 3-month backtest
  ✓ Check: Win Rate > 40% (A) / > 45% (B) / > 45% (C)
  ✓ Check: PF > 1.0 (net)
  ✓ Check: PF generalizes in walk-forward

If fails:
  → Symbol may not have clear structure
  → Or volatility is too high/low for optimal settings
  → Try tuning SL/TP or disabling gates
```

### Q5: Can I combine SMC with other strategies?

**A:** **YES, highly recommended!**

```
Portfolio:
  SMC (AF_SMC):        50% risk  (all timeframes)
  + Trend Following:   30% risk  (strong trends only)
  + Breakout:          20% risk  (consolidation breaks)
  = Robust coverage of all market conditions
```

---

## Appendix: Intraday Revival Attempt (2026-07-08)

A v3.1 proposal suggested moving Intraday to 1h entry / 4h confirm (a genuinely
different signal source from Scalping's 15m, unlike the current hidden state)
plus an entry-TF ADX chop gate and a revised TP ladder. Tested with a
purpose-built harness (`scripts/smc-intraday-1h-validation.js`, BTCUSDT,
fees+slippage ON) against the same bar TS_TF's Layer-1 fix used: **netPF ≥ 1.0
in EVERY walk-forward window**, not just the recent 12-month window.

**Engine work landed as reusable infra (kept, zero risk to Scalping/Swing):**
- Entry-TF ADX now actually computed for AF_SMC (`indicators.adx` was read by
  the strategy but never populated — a dead gate, same bug class as TS_TF's
  pre-fix HTF ADX). Opt-in per leg via `typeOverrides.<Type>.minAdx`.
- Partial-TP ladder R-multiples (`slPlusM1R` / `slPlusM2R`, default 1.0/2.0)
  are now configurable per leg instead of hardcoded — needed to test the
  spec's Scalping 2R/4R and Swing 1.5R/2.67R ladder ideas without touching the
  shipped defaults for other legs.

**Result — FAILS validation, stays hidden:**

| Variant | Bear 22-23 | Recovery 23-24 | Bull 24-25 | 12mo eval |
|---|---|---|---|---|
| V0 baseline (1h, no gate) | 1.01 | 1.06 | 0.84 | 0.65 |
| V2 +ADX25 chop gate | 0.81 | 1.08 | 0.88 | 0.71 |
| V4 HTF hard-block | 0.81 | 1.19 | 0.70 | 0.58 |
| V5 HTF hard-block+ADX20 | 0.84 | 1.25 | 0.73 | 0.58 |

No variant clears 1.0 in all four windows — every one fails at least one
window, and the failures move around (ADX helps 12mo/bull but hurts bear;
HTF hard-block helps recovery but hurts bull/eval). This is the signature of
a signal without a stable edge on 1h, not a tunable gate problem.

**Scalping ADX gate (separate, smaller test):** entry-TF ADX ≥23 on the
existing 15m Scalping leg improved 3 of 4 windows (12mo eval 0.70 → 1.45, bull
0.80 → 1.18) but left the 2023-07→2024-07 window badly broken regardless of
threshold (WR 7.1%, netPF ~0.32-0.35 at every ADX level tested) — that
window's losses aren't chop-related, so the gate isn't a fix for it. **Not
shipped as default** (mixed, not robust); available as an opt-in
`typeOverrides.Scalping.minAdx` knob for further investigation. Scalping's
shipped baseline is untouched. Swing was not touched at all per the review
recommendation (it's the one leg with a proven track record).

**Conclusion:** Reviving Intraday needs a different signal design (the doc's
own suggestion of 1h entry was a legitimate hypothesis — worth testing, but it
didn't survive walk-forward). Displacement/volume hard-gates from the v3.1
proposal were not implemented at all: they'd require new strategy code (the
sequence engine currently scores these continuously rather than hard-gating),
and the closest precedent (AF-SCALP-14's rejection-wick gate) cut Scalping
volume 43→8 trades with no WR gain — stacking three new hard gates at once
risks the same failure mode on an already-thin leg. Any future attempt should
test displacement/volume/ADX **one gate at a time**, exactly as done here.

### v3.1 Final follow-up (2026-07-08): 5m confirmation "light" mode — REJECTED

A follow-up doc ("v3.1 Final") proposed loosening the Scalping 5m confirmation
gate from requiring BOTH swing-high structure AND multi-candle reversal to a
"light" check (either condition). Precedent (rejection-wick gate OFF: 43 vs 8
trades, same WR) suggested loosening gates sometimes recovers volume for free
— worth a real A/B rather than assuming.

**Tested** (`scalpingChochValidateMode: "light"`, OR-logic instead of AND) on
the same 4-window standard, BTCUSDT, fees+slip ON:

| Variant | Bear 22-23 | Recovery 23-24 | Bull 24-25 | 12mo eval |
|---|---|---|---|---|
| Strict (current, AND-both) | 1.41 | 0.32 | 0.80 | 0.70 |
| Light (OR-either) | 1.18 | 0.29 | 0.75 | 0.70 |
| Off (no gate) | 1.18 | 0.29 | 0.75 | 0.70 |

**Result: light mode is WORSE in every window it changes**, and is numerically
IDENTICAL to turning the gate off entirely — meaning one of the two conditions
(swing-high or multi-structure) is nearly always true whenever the other is,
so OR-logic passes almost everything through, same as no gate at all. This
directly falsifies the "light" proposal: the current strict AND-both gate is
earning its keep (bear 1.41 vs 1.18, recovery 0.32 vs 0.29) — it's not
noise-cutting overhead, it's part of the leg's thin edge.

**Not implemented as default.** `scalpingChochValidateMode: "light"` shipped
as an inert opt-in flag (off by default, current AND-both behavior unchanged)
for anyone who wants to re-test it later, but the recommendation is: don't.

### v3.1 Final: SL 1.8×ATR and 0.4%/0.4% risk cap — NOT VALIDATED, NOT IMPLEMENTED

The same doc also proposed changing Scalping's SL from the shipped 2.2×ATR
(RR 2.0, fixed via forensics in AF-SCALP-10 after a prior 4.5 RR was found to
be "too far, slot-blocked, WR 16%") down to 1.8×ATR, and cutting the combined
Scalping+Swing risk cap from the shipped 4.5%/2-active-legs (Scalping 1.5%,
Swing 3%, via `typeRiskLadder.js` weight redistribution once Intraday is
excluded) down to 0.4%/0.4% (0.8% total). **Neither number was backed by a
fresh backtest in that doc** — they read as conservative defaults chosen by
feel, not measurement. Per the standing principle that risk-size changes alone
never move Profit Factor (only variance/drawdown), and given SL geometry was
already hard-won via forensics once before, **neither change was implemented**.
If risk reduction or a new SL geometry is wanted, it should go through the
same A/B-with-walk-forward process as everything else in this appendix, not be
adopted on say-so.

---

## Related Documentation

- [Trend Following Strategy](./TREND_FOLLOWING_STRATEGY.md)
- [Mean Reversion Strategy](./MEAN_REVERSION_STRATEGY.md)
- [Breakout Trading Strategy](./BREAKOUT_TRADING_STRATEGY.md)
- [Risk Management Framework](./RISK_MANAGEMENT_FRAMEWORK.md)
- [FOUNDRY_SAC_COMPLETE_SPECIFICATION.md](./FOUNDRY_SAC_COMPLETE_SPECIFICATION.md) (Technical reference)

---

**Last Reviewed:** 2026-07-07  
**Strategy Code:** [SmartMoneyConceptsStrategy.js](../src/domain/strategy/implementations/SmartMoneyConceptsStrategy.js)  
**Tests:** [SmartMoneyConceptsStrategy.test.js](../test/SmartMoneyConceptsStrategy.test.js)
