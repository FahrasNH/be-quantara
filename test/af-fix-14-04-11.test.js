/**
 * af-fix-14-04-11.test.js — QA Engineer (Sprint 7.5)
 *
 * Covers three new Engineer deliverables:
 *   AF-FIX-14  EMA9 slope filter (A & B), RSI period 21, TP adjustment RR 1.8
 *   AF-FIX-04  Net-edge filter (expected move < 2× fee → skip)
 *   AF-FIX-11  MACD histogram alignment gate for Component B
 *
 * QA strategy: positive path, negative path, edge cases, backward-compat, preset assertions.
 */

const test   = require("node:test");
const assert = require("node:assert");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");
const { STRATEGIES } = require("../src/domain/legacyStrategies");

const afs = new AdaptiveFusionStrategy();
const N   = 30;
const mk  = (n, v) => Array(n + 1).fill(v);

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * Clean BULL setup: rising EMA9, pullback-resume event, RSI in B's band.
 * emaFast[N] > emaFast[N-1] → slope filter passes for LONG.
 */
function bullFixture({ macdHistogram = null, ema9Slope = "rising" } = {}) {
  const closes   = mk(N, 104);
  closes[N - 1]  = 103.4; // pullback below EMA9
  closes[N]      = 104.1; // resume above

  const emaFastArr = mk(N, 103.4);
  if (ema9Slope === "rising")  emaFastArr[N] = 103.5; // current > prev → rising ✅
  if (ema9Slope === "flat")    emaFastArr[N] = 103.4; // current == prev → not rising
  if (ema9Slope === "falling") emaFastArr[N] = 103.3; // current < prev → falling

  const ind = {
    closes,
    emaFast:  emaFastArr,
    emaSlow:  mk(N, 102.5),
    emaTrend: mk(N, 101.0),
    rsi:      mk(N, 62),
    atr:      mk(N, 0.5),
    volumes:  mk(N, 200),
    volSMA:   mk(N, 100),
    macdHistogram: macdHistogram !== null ? mk(N, macdHistogram) : null,
  };
  return ind;
}

/**
 * Clean BEAR setup: falling EMA9, RSI in B's SHORT band.
 */
function bearFixture({ macdHistogram = null, ema9Slope = "falling" } = {}) {
  const closes   = mk(N, 98);
  closes[N - 1]  = 98.6; // brief bounce above EMA9 (98.5)
  closes[N]      = 98.0; // resumes below

  const emaFastArr = mk(N, 98.6);
  if (ema9Slope === "falling") emaFastArr[N] = 98.5; // current < prev → falling ✅
  if (ema9Slope === "flat")    emaFastArr[N] = 98.6; // flat → not falling
  if (ema9Slope === "rising")  emaFastArr[N] = 98.7; // rising → not falling

  const ind = {
    closes,
    emaFast:  emaFastArr,
    emaSlow:  mk(N, 100.0),
    emaTrend: mk(N, 102.0),
    rsi:      mk(N, 36),
    atr:      mk(N, 0.5),
    volumes:  mk(N, 200),
    volSMA:   mk(N, 100),
    macdHistogram: macdHistogram !== null ? mk(N, macdHistogram) : null,
  };
  return ind;
}

const bullCfg = {
  balance: 500, volatility: 0.8, trend_strength: 0.3,
  htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
  afEnabledComponents: ["B"],
};

const bearCfg = {
  balance: 500, volatility: 0.8, trend_strength: 0.3,
  htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
  afEnabledComponents: ["B"],
};

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-14 — EMA9 Slope Filter (Component B)
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-14 (B): LONG fires when EMA9 is rising", () => {
  const sig = afs.detectSignalMulti(bullFixture({ ema9Slope: "rising" }), N, bullCfg);
  assert.strictEqual(sig.B, "LONG", "rising EMA9 → B LONG fires");
});

test("AF-FIX-14 (B): LONG blocked when EMA9 is flat", () => {
  const sig = afs.detectSignalMulti(bullFixture({ ema9Slope: "flat" }), N, bullCfg);
  assert.strictEqual(sig.B, null, "flat EMA9 → B LONG blocked (no momentum)");
});

test("AF-FIX-14 (B): LONG blocked when EMA9 is falling (counter-momentum)", () => {
  const sig = afs.detectSignalMulti(bullFixture({ ema9Slope: "falling" }), N, bullCfg);
  assert.strictEqual(sig.B, null, "falling EMA9 → B LONG blocked");
});

test("AF-FIX-14 (B): SHORT fires when EMA9 is falling", () => {
  const sig = afs.detectSignalMulti(bearFixture({ ema9Slope: "falling" }), N, bearCfg);
  assert.strictEqual(sig.B, "SHORT", "falling EMA9 → B SHORT fires");
});

test("AF-FIX-14 (B): SHORT blocked when EMA9 is flat", () => {
  const sig = afs.detectSignalMulti(bearFixture({ ema9Slope: "flat" }), N, bearCfg);
  assert.strictEqual(sig.B, null, "flat EMA9 → B SHORT blocked");
});

test("AF-FIX-14 (B): SHORT blocked when EMA9 is rising (counter-momentum)", () => {
  const sig = afs.detectSignalMulti(bearFixture({ ema9Slope: "rising" }), N, bearCfg);
  assert.strictEqual(sig.B, null, "rising EMA9 → B SHORT blocked (would be counter-trend)");
});

// ── EMA9 slope in Component A ─────────────────────────────────────────────

function aLongFixture(ema9Slope = "rising") {
  const rsiArr = mk(N, 55);
  rsiArr[N - 2] = 53; // slope = (55-53)/2 = 1 > 0.5 → A fires
  const closes  = mk(N, 104);
  const emaFastArr = mk(N, 103.4);
  if (ema9Slope === "rising")  emaFastArr[N] = 103.5;
  if (ema9Slope === "flat")    emaFastArr[N] = 103.4;
  if (ema9Slope === "falling") emaFastArr[N] = 103.3;
  return {
    closes, rsi: rsiArr,
    emaFast: emaFastArr, emaSlow: mk(N, 102.5), emaTrend: mk(N, 101.0),
    atr: mk(N, 0.5), volumes: mk(N, 300), volSMA: mk(N, 100),
  };
}

const aCfg = {
  balance: 500, volatility: 0.8, trend_strength: 0.25, // NORMAL → A eligible
  htfTrend: "BULLISH", maxEntryExtensionATR: 1.5, volSmaMultiplier: 1.0,
  afEnabledComponents: ["A"],
};

test("AF-FIX-14 (A): LONG fires when EMA9 is rising", () => {
  const sig = afs.detectSignalMulti(aLongFixture("rising"), N, aCfg);
  assert.strictEqual(sig.A, "LONG", "rising EMA9 → A LONG fires");
});

test("AF-FIX-14 (A): LONG blocked when EMA9 is flat or falling", () => {
  const flat    = afs.detectSignalMulti(aLongFixture("flat"),    N, aCfg);
  const falling = afs.detectSignalMulti(aLongFixture("falling"), N, aCfg);
  assert.strictEqual(flat.A,    null, "flat EMA9 → A LONG blocked");
  assert.strictEqual(falling.A, null, "falling EMA9 → A LONG blocked");
});

// ── RR 1.8 assertion ─────────────────────────────────────────────────────

test("AF-FIX-14: Component C RR = 1.8 (tpMultiplier 2.16, slMultiplier 1.2)", () => {
  const sub = afs.SUB_STRATEGIES.C;
  const rr  = sub.tpMultiplier / sub.slMultiplier;
  assert.ok(Math.abs(rr - 1.8) < 0.01, `C RR = ${rr.toFixed(2)}, expected 1.8`);
});

test("AF-FIX-14: Component B RR = 1.8 (tpMultiplier 2.88, slMultiplier 1.6)", () => {
  const sub = afs.SUB_STRATEGIES.B;
  const rr  = sub.tpMultiplier / sub.slMultiplier;
  assert.ok(Math.abs(rr - 1.8) < 0.01, `B RR = ${rr.toFixed(2)}, expected 1.8`);
});

test("AF-FIX-14: calculateRiskConfig C LONG TP is closer than before (1.8× vs 2.5× SL)", () => {
  const risk = afs.calculateRiskConfig(100, 1, "LONG", "C");
  const rrActual = (risk.takeProfit - 100) / (100 - risk.stopLoss);
  assert.ok(Math.abs(rrActual - 1.8) < 0.01, `LONG C RR=${rrActual.toFixed(2)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-04 — Net-Edge Filter
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-04: gate OFF when netEdgeK absent (backward compat)", () => {
  // No netEdgeK in config → _netEdgeCheck returns true (allowed)
  const result = afs._netEdgeCheck(0.1, 10000, {});
  assert.strictEqual(result, true, "absent knob → gate OFF");
});

test("AF-FIX-04: thin edge blocked (ATR/price < 2× fee)", () => {
  // price=100000, ATR=100 → ATR/price=0.001 < 0.0024 → blocked
  const result = afs._netEdgeCheck(100, 100000, { netEdgeK: 2.0, feePct: 0.0012 });
  assert.strictEqual(result, false, "ATR 0.1% < 0.24% min → blocked");
});

test("AF-FIX-04: sufficient edge allowed (ATR/price >= 2× fee)", () => {
  // price=100000, ATR=300 → ATR/price=0.003 >= 0.0024 → allowed
  const result = afs._netEdgeCheck(300, 100000, { netEdgeK: 2.0, feePct: 0.0012 });
  assert.strictEqual(result, true, "ATR 0.3% >= 0.24% min → allowed");
});

test("AF-FIX-04: exactly at threshold is allowed", () => {
  // ATR/price = 0.0024 exactly = k × feePct
  const result = afs._netEdgeCheck(240, 100000, { netEdgeK: 2.0, feePct: 0.0012 });
  assert.strictEqual(result, true, "ATR exactly at threshold → allowed (>=)");
});

test("AF-FIX-04: gate blocks entry in detectSignalMulti when edge too thin", () => {
  // Use very low ATR (price=100, ATR=0.01 → 0.01%) to guarantee thin edge
  const ind = {
    ...bullFixture({ ema9Slope: "rising" }),
    atr: mk(N, 0.01), // very thin ATR/price ratio
  };
  // closes[N]=104, atr=0.01 → 0.01/104 ≈ 0.0096% << 0.24%
  const sig = afs.detectSignalMulti(ind, N, {
    ...bullCfg,
    netEdgeK: 2.0, feePct: 0.0012,
  });
  assert.strictEqual(sig.B, null, "thin-edge entry blocked by net-edge filter");
});

test("AF-FIX-04: gate allows entry in detectSignalMulti when edge sufficient", () => {
  // ATR=1.0, price≈104 → 1/104 ≈ 0.96% >> 0.24%
  const ind = { ...bullFixture({ ema9Slope: "rising" }), atr: mk(N, 1.0) };
  const sig = afs.detectSignalMulti(ind, N, {
    ...bullCfg,
    netEdgeK: 2.0, feePct: 0.0012,
  });
  assert.strictEqual(sig.B, "LONG", "sufficient edge → B LONG fires");
});

test("AF-FIX-04: no crash when atr or price is 0 (gate returns true)", () => {
  assert.strictEqual(afs._netEdgeCheck(0,    100, { netEdgeK: 2.0 }), true, "atr=0 → gate passthrough");
  assert.strictEqual(afs._netEdgeCheck(0.5,  0,   { netEdgeK: 2.0 }), true, "price=0 → gate passthrough");
});

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-11 — MACD Histogram Alignment for Component B
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-11 (B): LONG fires when MACD histogram is positive (bUseMacd=true)", () => {
  const sig = afs.detectSignalMulti(
    bullFixture({ ema9Slope: "rising", macdHistogram: 0.5 }), N,
    { ...bullCfg, bUseMacd: true }
  );
  assert.strictEqual(sig.B, "LONG", "positive MACD → B LONG fires");
});

test("AF-FIX-11 (B): LONG blocked when MACD histogram is negative (bUseMacd=true)", () => {
  const sig = afs.detectSignalMulti(
    bullFixture({ ema9Slope: "rising", macdHistogram: -0.3 }), N,
    { ...bullCfg, bUseMacd: true }
  );
  assert.strictEqual(sig.B, null, "negative MACD → B LONG blocked (momentum divergence)");
});

test("AF-FIX-11 (B): SHORT fires when MACD histogram is negative (bUseMacd=true)", () => {
  const sig = afs.detectSignalMulti(
    bearFixture({ ema9Slope: "falling", macdHistogram: -0.5 }), N,
    { ...bearCfg, bUseMacd: true }
  );
  assert.strictEqual(sig.B, "SHORT", "negative MACD → B SHORT fires");
});

test("AF-FIX-11 (B): SHORT blocked when MACD histogram is positive (bUseMacd=true)", () => {
  const sig = afs.detectSignalMulti(
    bearFixture({ ema9Slope: "falling", macdHistogram: 0.3 }), N,
    { ...bearCfg, bUseMacd: true }
  );
  assert.strictEqual(sig.B, null, "positive MACD in SHORT setup → divergence → blocked");
});

test("AF-FIX-11 (B): MACD null is pass-through (missing indicator tolerated)", () => {
  // macdHistogram=null means indicator not available → should not block
  const sig = afs.detectSignalMulti(
    bullFixture({ ema9Slope: "rising", macdHistogram: null }), N,
    { ...bullCfg, bUseMacd: true }
  );
  assert.strictEqual(sig.B, "LONG", "null MACD → pass-through (not available ≠ divergence)");
});

test("AF-FIX-11 (B): MACD gate OFF when bUseMacd not set (backward compat)", () => {
  // Negative MACD should NOT block when bUseMacd is absent
  const sig = afs.detectSignalMulti(
    bullFixture({ ema9Slope: "rising", macdHistogram: -0.5 }), N,
    { ...bullCfg } // no bUseMacd
  );
  assert.strictEqual(sig.B, "LONG", "bUseMacd absent → gate OFF → B fires regardless of MACD");
});

// ═══════════════════════════════════════════════════════════════════════════
// Preset Assertions — AF-FIX-14 + AF-FIX-04 + AF-FIX-11 config values
// ═══════════════════════════════════════════════════════════════════════════

test("Preset: RSI period changed to 21 (AF-FIX-14 — Grok recommendation)", () => {
  assert.strictEqual(STRATEGIES.ADAPTIVE_FUSION.rsiPeriod, 21);
});

test("Preset: riskReward changed to 1.8 (AF-FIX-14)", () => {
  assert.strictEqual(STRATEGIES.ADAPTIVE_FUSION.riskReward, 1.8);
});

test("Preset: netEdgeK=2.0 and feePct=0.0012 set (AF-FIX-04)", () => {
  const p = STRATEGIES.ADAPTIVE_FUSION;
  assert.strictEqual(p.netEdgeK, 2.0);
  assert.strictEqual(p.feePct,   0.0012);
});

test("Preset: bUseMacd=true set (AF-FIX-11)", () => {
  assert.strictEqual(STRATEGIES.ADAPTIVE_FUSION.bUseMacd, true);
});

test("Preset: class version is 3.4.0", () => {
  assert.strictEqual(afs.config.version, "3.4.0");
});
