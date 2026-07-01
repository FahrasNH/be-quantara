/**
 * smc-strategy.test.js — Unit tests for SmartMoneyConceptsStrategy (SAC v1.0)
 *
 * Coverage:
 *   Component A — Sweep detection, CVD, OB confluence
 *   Component B — CHoCH detection, EMA trend, OB strength
 *   Component C — FVG detection, Displacement, premium/discount
 *   Confidence scoring per component
 *   Voting / conflict resolution
 *   HTF blocking logic
 *   calculateRiskConfig (A, B, C sub-strategies)
 *   validateEntry / canActivate / rankByMarketConditions
 *
 * SAC-FIX-09 — 25 tests
 */

"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const SmartMoneyConceptsStrategy = require("../src/domain/strategy/implementations/SmartMoneyConceptsStrategy");

// ── Test helpers ─────────────────────────────────────────────────────────────

function mk(n, v) {
  return Array(n + 1).fill(v);
}

const N = 60;

/** Base flat indicators — all signals null */
function baseIndicators(overrides = {}) {
  return {
    closes:  mk(N, 100),
    highs:   mk(N, 101),
    lows:    mk(N, 99),
    opens:   mk(N, 100),
    volumes: mk(N, 200),
    volSMA:  mk(N, 200),
    emaFast: mk(N, 100),
    emaSlow: mk(N, 100),
    ...overrides,
  };
}

/** Build a bullish liquidity sweep setup on the last bar */
function sweepBullishIndicators({ volMult = 4, cvdBullish = true } = {}) {
  const ind = baseIndicators();
  // Establish a swing low 6 bars back
  ind.lows[N - 6] = 97.0;
  // Last bar wicks below that swing low then closes above
  ind.lows[N]    = 96.8;
  ind.closes[N]  = 100.5;
  ind.highs[N]   = 101.0;
  ind.volumes[N] = 200 * volMult;
  // CVD: if bullish, close at top of range for all lookback bars
  if (cvdBullish) {
    for (let i = N - 14; i <= N; i++) {
      ind.closes[i] = ind.highs[i] - 0.05; // near top → dp≈0.95, strong buyer
    }
  }
  return ind;
}

/** Build a bearish CHoCH setup */
function chochBearishIndicators() {
  const ind = baseIndicators();
  // Older half (30 bars ago): higher highs (uptrend)
  const oldStart = N - 20;
  const oldEnd   = N - 10;
  for (let i = oldStart; i <= oldEnd; i++) {
    ind.highs[i] = 110; // high peak
    ind.lows[i]  = 100;
  }
  // Recent half: makes lower high
  for (let i = oldEnd + 1; i < N; i++) {
    ind.highs[i] = 105;
    ind.lows[i]  = 102;
  }
  // Last bar closes below old period's swing low → bearish CHoCH
  ind.closes[N] = 98.0;
  ind.lows[N]   = 97.5;
  // EMA confirms downtrend
  ind.emaFast = mk(N, 99.0);
  ind.emaSlow = mk(N, 101.0);
  return ind;
}

/** Build an FVG + displacement setup for LONG */
function fvgLongIndicators() {
  const ind = baseIndicators();
  const i   = N - 5; // FVG candle index

  // Bullish FVG: lows[i] > highs[i-2] → gap above i-2's high
  // Use 1% range bars around 100
  ind.highs[i - 2] = 99.5;
  ind.lows[i - 2]  = 98.5;
  ind.closes[i - 2] = 99.0;

  ind.highs[i - 1] = 100.5;
  ind.lows[i - 1]  = 99.6;
  ind.closes[i - 1] = 100.0;

  ind.highs[i] = 101.2;
  ind.lows[i]  = 100.4; // lows[i]=100.4 > highs[i-2]=99.5 → bullish FVG (gap 0.9%)
  ind.closes[i] = 101.0;

  // FVG midpoint = (100.4 + 99.5) / 2 = 99.95
  // Last bar: close inside discount zone (≤ midpoint)
  ind.closes[N] = 99.9;
  ind.highs[N]  = 100.2;
  ind.lows[N]   = 99.7;

  // Displacement: 3× vol + wide range bar 4 bars ago (inside scanBars)
  const d = N - 8;
  ind.volumes[d] = 200 * 3.5;   // > 2× SMA (200)
  ind.highs[d]   = 103.0;
  ind.lows[d]    = 101.0;       // range = 2% > 1.2%
  ind.closes[d]  = 102.8;       // bullish displacement

  return ind;
}

// ── Instantiation ─────────────────────────────────────────────────────────────

test("SMC-01: class instantiates without error", () => {
  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.config.name, "SMART_MONEY_CONCEPTS");
  assert.equal(smc.config.version, "3.0.0");
});

test("SMC-02: SUB_STRATEGIES has Scalping/Intraday/Swing + A/B/C aliases", () => {
  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.SUB_STRATEGIES.Scalping.name, "SAC_SCALP");
  assert.equal(smc.SUB_STRATEGIES.Intraday.name, "SAC_INTRADAY");
  assert.equal(smc.SUB_STRATEGIES.Swing.name,    "SAC_SWING");
  // Backward-compat aliases
  assert.equal(smc.SUB_STRATEGIES.A.name, "SAC_SCALP");
  assert.equal(smc.SUB_STRATEGIES.B.name, "SAC_INTRADAY");
  assert.equal(smc.SUB_STRATEGIES.C.name, "SAC_SWING");
});

// ── Abstract method implementations ──────────────────────────────────────────

test("SMC-03: canActivate blocks below $20", () => {
  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.canActivate(19).allowed, false);
  assert.equal(smc.canActivate(20).allowed, true);
  assert.equal(smc.canActivate(1000).allowed, true);
});

test("SMC-04: getTimeframeConfig returns Intraday TF (5m/4h)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const tf  = smc.getTimeframeConfig();
  assert.equal(tf.interval,  "5m");
  assert.equal(tf.higherTf,  "4h");
});

test("SMC-05: validateEntry blocks extreme ATR (< 0.8% or > 5%)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  // atrPct = 0.5/100 * 100 = 0.5% → below 0.8%
  assert.equal(smc.validateEntry(100, 0.5, 200, 100).valid, false);
  // atrPct = 6/100 * 100 = 6% → above 5%
  assert.equal(smc.validateEntry(100, 6.0, 200, 100).valid, false);
  // atrPct = 2% → healthy
  assert.equal(smc.validateEntry(100, 2.0, 200, 100).valid, true);
});

test("SMC-06: validateEntry blocks thin volume (ratio < 0.5×)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  // volume=40, volSMA=100 → ratio 0.4×
  assert.equal(smc.validateEntry(100, 2.0, 40, 100).valid, false);
  // volume=60, volSMA=100 → ratio 0.6× → passes
  assert.equal(smc.validateEntry(100, 2.0, 60, 100).valid, true);
});

test("SMC-07: rankByMarketConditions returns sorted rankings", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const rankings = smc.rankByMarketConditions({ volatility: 1.0, trend_strength: 0.3 });
  assert.equal(rankings.length, 3);
  // Scores should be non-ascending
  for (let i = 0; i < rankings.length - 1; i++) {
    assert.ok(rankings[i].score >= rankings[i + 1].score, "Rankings not sorted");
  }
});

test("SMC-08: rankByMarketConditions — volatile market favors Scalping", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const rankings = smc.rankByMarketConditions({ volatility: 3.0, trend_strength: 0.05 });
  // scoreA = 45 + 35 + 20 = 100 → should be top
  assert.equal(rankings[0].key, "Scalping");
});

test("SMC-09: rankByMarketConditions — strong trend favors Swing", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const rankings = smc.rankByMarketConditions({ volatility: 0.8, trend_strength: 0.7 });
  // scoreC = 50 + 35 + 15 = 100
  assert.equal(rankings[0].key, "Swing");
});

// ── Component A — Sweep detector ─────────────────────────────────────────────

test("SMC-10: Component A fires LONG on bullish sweep + CVD > 0", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators();
  const raw = smc._detectSignalA(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, "LONG");
});

test("SMC-11: Component A returns null when volume is below sweep threshold", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators({ volMult: 1.0 }); // volMult=1× → no surge
  const raw = smc._detectSignalA(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, null);
});

test("SMC-12: Component A returns null when CVD is negative (counter to sweep)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators({ cvdBullish: false });
  // Force bearish CVD: close at bottom of range
  for (let i = N - 14; i <= N; i++) {
    ind.closes[i] = ind.lows[i] + 0.05; // near bottom → dp≈0.05
  }
  const raw = smc._detectSignalA(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, null);
});

// ── Component B — CHoCH detector ─────────────────────────────────────────────

test("SMC-13: Component B fires SHORT on bearish CHoCH + EMA downtrend", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = chochBearishIndicators();
  const raw = smc._detectSignalB(
    ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA,
    ind.emaFast, ind.emaSlow, N, {}
  );
  assert.equal(raw, "SHORT");
});

test("SMC-14: Component B blocked when EMA trend conflicts with CHoCH", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = chochBearishIndicators();
  // Force EMA uptrend (blocks bearish entry)
  ind.emaFast = mk(N, 102.0);
  ind.emaSlow = mk(N, 99.0);
  const raw = smc._detectSignalB(
    ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA,
    ind.emaFast, ind.emaSlow, N, {}
  );
  assert.equal(raw, null);
});

// ── Component C — FVG + Displacement ─────────────────────────────────────────

test("SMC-15: Component C fires LONG on bullish FVG + displacement + price in discount", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = fvgLongIndicators();
  const raw = smc._detectSignalC(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, "LONG");
});

test("SMC-16: Component C returns null when price is ABOVE FVG midpoint (premium zone)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = fvgLongIndicators();
  // FVG midpoint ≈ 99.95 — push price above it
  ind.closes[N] = 100.6;
  ind.highs[N]  = 101.0;
  ind.lows[N]   = 100.4;
  const raw = smc._detectSignalC(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, null, "Should reject entry in premium zone");
});

test("SMC-17: Component C returns null when no displacement exists", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = fvgLongIndicators();
  // Zero out all volumes to kill displacement signal
  for (let i = 0; i < ind.volumes.length; i++) ind.volumes[i] = 50;
  const raw = smc._detectSignalC(ind.closes, ind.highs, ind.lows, ind.volumes, ind.volSMA, N, {});
  assert.equal(raw, null);
});

// ── Confidence scoring ────────────────────────────────────────────────────────

test("SMC-18: Confidence A > 0 when sweep + CVD align (LONG)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators();
  const ctx = smc._buildConfidenceContext(ind, N, {});
  const conf = smc._componentConfidence("A", "LONG", ctx);
  assert.ok(conf > 0, `Expected conf > 0, got ${conf}`);
});

test("SMC-19: Confidence A = 0 when direction is null", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = baseIndicators();
  const ctx = smc._buildConfidenceContext(ind, N, {});
  assert.equal(smc._componentConfidence("A", null, ctx), 0);
});

test("SMC-20: Confidence is clamped at [0, 100]", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators({ volMult: 100 }); // extreme scenario
  const ctx = smc._buildConfidenceContext(ind, N, {});
  const conf = smc._componentConfidence("A", "LONG", ctx);
  assert.ok(conf >= 0 && conf <= 100, `Confidence ${conf} out of [0, 100]`);
});

// ── detectSignalMulti voting ──────────────────────────────────────────────────

test("SMC-21: detectSignalMulti returns meta object with confidence keys", () => {
  const smc  = new SmartMoneyConceptsStrategy();
  const ind  = baseIndicators();
  const multi = smc.detectSignalMulti(ind, N, {});
  assert.ok("A" in multi, "Expected key A");
  assert.ok("B" in multi, "Expected key B");
  assert.ok("C" in multi, "Expected key C");
  assert.ok("meta" in multi, "Expected meta");
  assert.ok("confidence" in multi.meta);
});

test("SMC-22: detectSignal returns null when no component qualifies", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = baseIndicators(); // flat → no signals
  assert.equal(smc.detectSignal(ind, N, {}), null);
});

test("SMC-23: HTF blocking — LONG entry blocked when htfTrend=BEARISH", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = sweepBullishIndicators();
  const config = { htfTrend: "BEARISH", sacMinVotes: 1 };
  const multi = smc.detectSignalMulti(ind, N, config);
  // All LONG signals should be filtered out by HTF block
  assert.equal(multi.A, null, "A LONG should be blocked by bearish HTF");
  assert.equal(smc.detectSignal(ind, N, config), null);
});

// ── calculateRiskConfig ───────────────────────────────────────────────────────

test("SMC-24: calculateRiskConfig Component A has tighter SL (0.8× ATR)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const rA  = smc.calculateRiskConfig(100, 2.0, "LONG", "A");
  const rB  = smc.calculateRiskConfig(100, 2.0, "LONG", "B");
  // A SL multiplier (0.8) < B SL multiplier (1.2)
  assert.ok(rA.slDistance < rB.slDistance, "Scalp should have tighter SL than intraday");
  assert.equal(rA.stopLoss,   parseFloat((100 - 2.0 * 0.8).toFixed(8)));
  assert.equal(rA.takeProfit, parseFloat((100 + 2.0 * 1.5).toFixed(8)));
});

test("SMC-25: calculateRiskConfig Component C has widest TP (4.0× ATR)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const rC  = smc.calculateRiskConfig(100, 2.0, "LONG", "C");
  // tpDistance = 2.0 × 4.0 = 8.0
  assert.equal(rC.tpDistance, 8.0);
  assert.equal(rC.component, "C");
  assert.ok(rC.riskReward > 2.5, `Expected RR > 2.5, got ${rC.riskReward}`);
});

test("SMC-26: getLastSignalMeta is null before first detectSignalMulti call", () => {
  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.getLastSignalMeta(), null);
});

test("SMC-27: getLastSignalMeta updates after detectSignalMulti", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const ind = baseIndicators();
  smc.detectSignalMulti(ind, N, {});
  const meta = smc.getLastSignalMeta();
  assert.ok(meta !== null);
  assert.ok("confidence" in meta);
  assert.ok("aggregateConfidence" in meta);
});

console.log("SAC test suite loaded (SAC-FIX-09 — 27 tests).");
