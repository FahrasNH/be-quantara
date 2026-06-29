/**
 * adaptive-fusion-confidence.test.js — Sprint 7 (AF-FIX) Engineer deliverable.
 *
 * Covers the four Engineer-role tasks:
 *   AF-FIX-01  per-component confidence scoring (0–100), explicit weight table
 *   AF-FIX-02  entry gate: a component only votes/fires if confidence ≥ 60;
 *              voting path requires ≥2 valid components, else no-entry
 *   AF-FIX-03  block low-conviction reversal entries via the aggregate gate
 *   AF-FIX-09  QA edge cases: no-entry, all-below-60 (no crash), regime flip
 *
 * The confidence gate is KNOB-GATED: with no afMinComponentConfidence /
 * afMinAggregateConfidence in config it is OFF (legacy behaviour, asserted in
 * adaptive-fusion-v26 / fee-edge-guards / afs). These tests pass the knobs
 * explicitly to exercise the gate.
 */

const test   = require("node:test");
const assert = require("node:assert");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");
const { STRATEGIES } = require("../src/domain/legacyStrategies");

const afs = new AdaptiveFusionStrategy();
const N   = 30; // lastIdx
const mk  = (n, v) => Array(n + 1).fill(v);

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Clean uptrend where A, B and C all fire LONG with high confidence.
 * pullback-resume event for B (close[N-1] dips to/below EMA9, close[N] resumes).
 * rsi default 62 sits inside B's band [60,68], C's band [45,65] and A's >40.
 */
function upAllFire({ rsi = 62, rsiPrev2 = 60, vol = 200, volSMA = 100, lastClose = 104 } = {}) {
  const closes = mk(N, 104);
  closes[N - 1] = 103.4;     // pullback below EMA9 (103.5)
  closes[N]     = lastClose; // resume above
  const rsiArr  = mk(N, rsi);
  rsiArr[N - 2] = rsiPrev2;  // RSI velocity for component A
  // AF-FIX-14: EMA9 must be rising for A/B LONG to fire. Slightly rising series.
  const emaFastArr = mk(N, 103.4);
  emaFastArr[N] = 103.5; // current bar EMA9 > previous → slope rising
  return {
    closes,
    emaFast:  emaFastArr,    // EMA9  > EMA21 > EMA50, rising at N
    emaSlow:  mk(N, 102.5),
    emaTrend: mk(N, 101.0),
    rsi:      rsiArr,
    atr:      mk(N, 0.5),
    volumes:  mk(N, vol),
    volSMA:   mk(N, volSMA),
  };
}

/** Downtrend where C/B fire SHORT (RSI 42 inside both bands). */
function downIndicators() {
  return {
    closes:   mk(N, 98),
    emaFast:  mk(N, 98.5),   // EMA9 < EMA21 < EMA50 (downtrend)
    emaSlow:  mk(N, 100.0),
    emaTrend: mk(N, 102.0),
    rsi:      mk(N, 42),
    atr:      mk(N, 0.5),
    volumes:  mk(N, 100),
    volSMA:   mk(N, 80),
  };
}

const baseCfg = { balance: 500, volatility: 1.5, trend_strength: 0.5, maxEntryExtensionATR: 1.5 };

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-01 — confidence scoring (0–100) + explicit weight table
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-01: weight table exists and each component sums to 100", () => {
  const W = afs.getConfidenceWeights();
  for (const key of ["A", "B", "C"]) {
    assert.ok(W[key], `weights for ${key} exist`);
    const sum = Object.values(W[key]).reduce((s, v) => s + v, 0);
    assert.strictEqual(sum, 100, `component ${key} weights sum to 100 (got ${sum})`);
  }
});

test("AF-FIX-01: _componentConfidence is always within 0..100", () => {
  const ctx = afs._buildConfidenceContext(upAllFire(), N, baseCfg, { trend_strength: 0.5 });
  for (const key of ["A", "B", "C"]) {
    for (const dir of ["LONG", "SHORT"]) {
      const c = afs._componentConfidence(key, dir, ctx);
      assert.ok(Number.isFinite(c) && c >= 0 && c <= 100, `${key} ${dir} → ${c} in 0..100`);
    }
  }
  assert.strictEqual(afs._componentConfidence("A", null, ctx), 0, "null direction → 0");
});

test("AF-FIX-01: a clean setup scores high (≥60) for the firing direction", () => {
  const ctx = afs._buildConfidenceContext(upAllFire(), N, baseCfg, { trend_strength: 0.5 });
  assert.ok(afs._componentConfidence("B", "LONG", ctx) >= 60, "clean B LONG ≥ 60");
  assert.ok(afs._componentConfidence("C", "LONG", ctx) >= 60, "clean C LONG ≥ 60");
});

test("AF-FIX-01: a marginal component scores below a clean one (gate is meaningful)", () => {
  // Strong A: fast RSI velocity + strong volume.  Weak A: barely-rising RSI + thin volume.
  const strong = afs._buildConfidenceContext(
    upAllFire({ rsi: 58, rsiPrev2: 50, vol: 300, volSMA: 100 }), N,
    { ...baseCfg, volSmaMultiplier: 1.0 }, { trend_strength: 0.5 });
  const weak = afs._buildConfidenceContext(
    upAllFire({ rsi: 41, rsiPrev2: 40, vol: 100, volSMA: 100 }), N,
    { ...baseCfg, volSmaMultiplier: 1.0 }, { trend_strength: 0.5 });
  const cStrong = afs._componentConfidence("A", "LONG", strong);
  const cWeak   = afs._componentConfidence("A", "LONG", weak);
  assert.ok(cStrong > cWeak, `strong (${cStrong}) > weak (${cWeak})`);
  assert.ok(cWeak < 60, `marginal A (${cWeak}) below gate`);
  assert.ok(cStrong >= 60, `strong A (${cStrong}) clears gate`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-02 — entry gate (multi-position + voting)
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-02 (multi): high-confidence component fires under the gate", () => {
  const sig = afs.detectSignalMulti(upAllFire(), N, {
    ...baseCfg, htfTrend: "BULLISH",
    afEnabledComponents: ["B"], afMinComponentConfidence: 60,
  });
  assert.strictEqual(sig.B, "LONG", "clean B clears the 60 gate");
  assert.ok(sig.meta.confidence.B >= 60, "confidence surfaced in meta");
});

test("AF-FIX-02 (multi): low-confidence component is filtered out", () => {
  // A fires (RSI slope 0.6 > 0.5, vol at threshold) but only scores ~58 → gated out.
  const weakA = upAllFire({ rsi: 40.6, rsiPrev2: 39.4, vol: 100, volSMA: 100 });
  const cfg = {
    balance: 500, volatility: 0.8, trend_strength: 0.25, // NORMAL regime → A eligible
    maxEntryExtensionATR: 1.5, htfTrend: "BULLISH", volSmaMultiplier: 1.0,
    afEnabledComponents: ["A"],
  };
  const gated   = afs.detectSignalMulti(weakA, N, { ...cfg, afMinComponentConfidence: 60 });
  const ungated = afs.detectSignalMulti(weakA, N, { ...cfg }); // no knob → gate off
  assert.strictEqual(gated.A, null, "marginal A blocked by 60 gate");
  assert.strictEqual(ungated.A, "LONG", "same A fires when gate is OFF (knob absent)");
});

test("AF-FIX-02 (voting): ≥2 valid components → entry; <2 valid → no-entry", () => {
  const ind = upAllFire();
  // Discover the actual confidences via a threshold-0 pass (gate computes but never blocks).
  const probe = { ...baseCfg, afMinVotes: 2, afMinComponentConfidence: 0 };
  const s0 = afs.detectSignal(ind, N, probe);
  assert.strictEqual(s0, "LONG", "all three fire LONG with the gate effectively open");
  const conf = afs.getLastSignalMeta().confidence;
  const sorted = [conf.A, conf.B, conf.C].sort((a, b) => b - a);

  // Threshold just below the 2nd-highest → exactly 2 valid → entry.
  const tTwo = sorted[1] - 1;
  assert.strictEqual(
    afs.detectSignal(ind, N, { ...baseCfg, afMinVotes: 2, afMinComponentConfidence: tTwo }),
    "LONG", "≥2 valid components → LONG");

  // Threshold just above the 2nd-highest → only 1 valid → no-entry.
  const tOne = sorted[1] + 1;
  assert.strictEqual(
    afs.detectSignal(ind, N, { ...baseCfg, afMinVotes: 2, afMinComponentConfidence: tOne }),
    null, "<2 valid components → skip bar");
});

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-03 — block low-conviction reversal / "Signal" entries
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-03: aggregate-confidence gate blocks a below-threshold entry", () => {
  const ind = upAllFire();
  // Resolve once with the component gate open to read the aggregate confidence.
  const s0 = afs.detectSignal(ind, N, { ...baseCfg, afMinVotes: 2, afMinComponentConfidence: 0 });
  assert.strictEqual(s0, "LONG");
  const agg = afs.getLastSignalMeta().aggregateConfidence;
  assert.ok(agg > 0, "aggregate confidence is reported");

  // Require aggregate just ABOVE what we have → reject.
  assert.strictEqual(
    afs.detectSignal(ind, N, {
      ...baseCfg, afMinVotes: 2, afMinComponentConfidence: 0,
      afMinAggregateConfidence: agg + 5,
    }), null, "entry rejected when aggregate < threshold");

  // Require aggregate just BELOW → accept.
  assert.strictEqual(
    afs.detectSignal(ind, N, {
      ...baseCfg, afMinVotes: 2, afMinComponentConfidence: 0,
      afMinAggregateConfidence: agg - 5,
    }), "LONG", "entry accepted when aggregate ≥ threshold");
});

test("AF-FIX-03: counter-trend SHORT blocked in BULLISH HTF even at full confidence", () => {
  // Even a high-conviction SHORT cannot enter against a bullish higher timeframe.
  const sig = afs.detectSignalMulti(downIndicators(), N, {
    balance: 500, volatility: 0.8, trend_strength: 0.6, // STRONG_TREND
    htfTrend: "BULLISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["A", "B", "C"], afMinComponentConfidence: 60,
  });
  assert.strictEqual(sig.A, null);
  assert.strictEqual(sig.B, null);
  assert.strictEqual(sig.C, null, "no SHORT against bullish HTF regardless of confidence");
});

// ═══════════════════════════════════════════════════════════════════════════
// AF-FIX-09 — QA edge cases (no-entry, all-below-60, regime flip, no crash)
// ═══════════════════════════════════════════════════════════════════════════

test("AF-FIX-09: all components below 60 → no entry, no crash (voting)", () => {
  // Flat market: no EMA structure / no event → no component fires. Gate on.
  const flat = {
    closes:  mk(N, 100),
    emaFast: mk(N, 100), emaSlow: mk(N, 100), emaTrend: mk(N, 100),
    rsi:     mk(N, 50),  atr: mk(N, 0.5),
    volumes: mk(N, 100), volSMA: mk(N, 100),
  };
  let sig;
  assert.doesNotThrow(() => {
    sig = afs.detectSignal(flat, N, { ...baseCfg, afMinVotes: 2, afMinComponentConfidence: 60 });
  });
  assert.strictEqual(sig, null, "flat market → null");
});

test("AF-FIX-09: all components below 60 → all null, no crash (multi)", () => {
  const flat = {
    closes:  mk(N, 100),
    emaFast: mk(N, 100), emaSlow: mk(N, 100), emaTrend: mk(N, 100),
    rsi:     mk(N, 50),  atr: mk(N, 0.5),
    volumes: mk(N, 100), volSMA: mk(N, 100),
  };
  let sig;
  assert.doesNotThrow(() => {
    sig = afs.detectSignalMulti(flat, N, {
      ...baseCfg, htfTrend: "BULLISH",
      afEnabledComponents: ["A", "B", "C"], afMinComponentConfidence: 60,
    });
  });
  assert.strictEqual(sig.A, null);
  assert.strictEqual(sig.B, null);
  assert.strictEqual(sig.C, null);
});

test("AF-FIX-09: regime flip — DEAD_MARKET blocks all components with gate on", () => {
  const sig = afs.detectSignalMulti(downIndicators(), N, {
    balance: 500, volatility: 0.2, trend_strength: 0.05, // DEAD_MARKET
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["A", "B", "C"], afMinComponentConfidence: 60,
  });
  assert.strictEqual(sig.A, null);
  assert.strictEqual(sig.B, null);
  assert.strictEqual(sig.C, null);
});

test("AF-FIX-09: regime flip — C eligible in NORMAL (AF-FIX-17) and STRONG_TREND, gated by confidence", () => {
  const ind = downIndicators();
  // AF-FIX-17: NORMAL regime → C IS now eligible; may fire or be gated by confidence.
  const normal = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.8, trend_strength: 0.25,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["C"], afMinComponentConfidence: 60,
  });
  assert.ok(normal.C === "SHORT" || normal.C === null, `C must be SHORT or null in NORMAL BEARISH, got ${normal.C}`);

  // STRONG_TREND → C eligible and clears the gate (clean downtrend).
  const strong = afs.detectSignalMulti(ind, N, {
    balance: 500, volatility: 0.8, trend_strength: 0.6,
    htfTrend: "BEARISH", maxEntryExtensionATR: 1.5,
    afEnabledComponents: ["C"], afMinComponentConfidence: 60,
  });
  assert.strictEqual(strong.C, "SHORT", "C fires SHORT in STRONG_TREND + BEARISH HTF");
  assert.ok(strong.meta.confidence.C >= 60, "C confidence reported and ≥ 60");
});

test("AF-FIX-09: backward compatible — knob absent leaves voting behaviour unchanged", () => {
  // No confidence knob: behaves exactly like the legacy voting path.
  const ind = upAllFire();
  const sig = afs.detectSignal(ind, N, { ...baseCfg, afMinVotes: 2 });
  assert.strictEqual(sig, "LONG", "gate OFF → legacy 2-vote LONG");
  const meta = afs.getLastSignalMeta();
  assert.ok(meta.confidence, "confidence still computed and exposed for observability");
});

test("AF-FIX-09: preset ships the gate enabled at 60 for live + backtest", () => {
  const p = STRATEGIES.ADAPTIVE_FUSION;
  assert.strictEqual(p.afMinComponentConfidence, 60);
  assert.strictEqual(p.afMinAggregateConfidence, 60);
  assert.deepStrictEqual(p.afEnabledComponents, ["A", "B", "C"]);
});
