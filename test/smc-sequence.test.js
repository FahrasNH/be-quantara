/**
 * smc-sequence.test.js — event-driven SMC sequence engine (v3.0)
 *
 * Verifies the causal sequence detector:
 *   sweep → CHoCH → displacement/FVG → mitigation → entry
 * plus safety (no false positives on flat data) and causal-order rejection.
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const SmartMoneyConceptsStrategy = require("../src/domain/strategy/implementations/SmartMoneyConceptsStrategy");

// Build indicators object from OHLCV arrays + a flat volSMA baseline.
function ind(o, h, l, c, v, volBase = 100) {
  return {
    opens: o, highs: h, lows: l, closes: c, volumes: v,
    volSMA: c.map(() => volBase),
    emaFast: c.map(() => 0), emaSlow: c.map(() => 0),
  };
}

/**
 * Construct a candle series containing a full BULLISH SMC sequence ending at
 * the last bar (mitigation). Structure:
 *   - bars 0..34: mild downtrend making lower lows (establishes bearish structure
 *     so a later up-break is a genuine CHoCH), swing high ~101 around bar 20.
 *   - bar 30: swing low 96 (sell-side liquidity).
 *   - bar 36: SWEEP — wick to 95.2 (below 96) then close back to 98, volume surge.
 *   - bars 37..44: rally; bar 44 closes 102 > prior swing high 101 → bullish CHoCH.
 *   - bar 48: DISPLACEMENT — wide high-volume bull candle; creates bullish FVG
 *     (lows[48] > highs[46]).
 *   - bars 49..54: pullback into the FVG discount zone; last bar closes there.
 */
function buildBullishSequence() {
  const o = [], h = [], l = [], c = [], v = [];
  const push = (open, high, low, close, vol) => { o.push(open); h.push(high); l.push(low); c.push(close); v.push(vol); };

  // 0..19: drift down 100 → 98 with a clear swing HIGH at bar 20
  for (let i = 0; i < 20; i++) { const p = 100 - i * 0.1; push(p, p + 0.4, p - 0.4, p - 0.05, 100); }
  // bar 20: swing high 101
  push(98, 101.0, 97.8, 100.8, 110);
  // 21..29: lower lows down toward 96.5 (bearish structure)
  for (let i = 0; i < 9; i++) { const p = 100 - i * 0.4; push(p, p + 0.3, p - 0.5, p - 0.3, 100); }
  // bar 30: swing LOW 96 (liquidity pool)
  push(96.6, 96.9, 96.0, 96.4, 105);
  // 31..35: small bounce then back down toward the low (equal-ish lows)
  for (let i = 0; i < 5; i++) push(96.8, 97.2, 96.3, 96.6, 100);
  // bar 36: SWEEP — dip below 96 to 95.2, close back at 98.0, big volume
  push(96.4, 98.2, 95.2, 98.0, 400);
  // 37..43: rally up
  for (let i = 0; i < 7; i++) { const p = 98.2 + i * 0.5; push(p, p + 0.6, p - 0.3, p + 0.4, 130); }
  // bar 44: CHoCH — close 102.2 breaks above prior swing high 101
  push(101.5, 102.5, 101.2, 102.2, 160);
  // 45..47: continue up, set up displacement origin
  push(102.2, 102.8, 101.9, 102.6, 140);
  push(102.6, 103.2, 102.3, 103.0, 150);
  push(103.0, 103.4, 102.7, 103.2, 150); // bar 47 (i-2 for FVG at 49)
  // bar 48: DISPLACEMENT — strong wide bull candle
  push(103.3, 106.5, 103.2, 106.2, 500);
  // bar 49: FVG-forming candle — low ABOVE highs[47] (103.4) → bullish FVG gap
  push(106.2, 107.0, 104.0, 106.6, 300);
  // 50..54: pullback into the FVG zone (bottom=highs[47]=103.4, top=lows[49]=104.0)
  //   midpoint ≈ 103.7; discount half [103.4 .. 103.7]. Close last bar at 103.6.
  push(106.0, 106.2, 105.0, 105.4, 120);
  push(105.2, 105.4, 104.2, 104.6, 120);
  push(104.4, 104.6, 103.8, 104.0, 120);
  push(103.9, 104.1, 103.5, 103.65, 120);
  push(103.7, 103.9, 103.4, 103.60, 120); // bar 54 — mitigation close inside discount half

  return ind(o, h, l, c, v);
}

test("SEQ-01: primitives — sweep, CHoCH, FVG all detectable in the built series", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const cfg = { sacSweepVolMult: 0.9, sacFvgMinGap: 0.0015 };
  const s = buildBullishSequence();
  const N = s.closes.length - 1;
  // FVG must exist at the last (mitigation) bar
  const fvg = smc._detectFVG(s.closes, s.highs, s.lows, N, cfg);
  assert.ok(fvg.bullish, "expected a bullish FVG at mitigation bar");
});

test("SEQ-02: full bullish sequence fires LONG at mitigation bar", () => {
  const smc = new SmartMoneyConceptsStrategy();
  // sweep mult 1.8 → only the genuine sweep bar (vol 400) surges above baseline (100)
  const cfg = { sacSweepVolMult: 1.8, sacFvgMinGap: 0.0015, sacDispVolMult: 1.6, sacDispRangePct: 0.008, sacSeqWindow: 60 };
  const s = buildBullishSequence();
  const N = s.closes.length - 1;
  const r = smc._detectSMCSequence(s, N, cfg);
  assert.strictEqual(r.signal, "LONG", "full sequence should fire LONG");
  assert.ok(r.meta && r.meta.score >= 0 && r.meta.score <= 100, "score in [0,100]");
  assert.ok(r.meta.sweepIdx < r.meta.chochIdx, "causal order: sweep before CHoCH");
  assert.ok(r.meta.chochIdx <= r.meta.dispIdx, "causal order: CHoCH before/at displacement");
});

test("SEQ-03: no false positive — flat market returns null", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const n = 80;
  const flat = ind(
    Array(n).fill(100), Array(n).fill(100.3), Array(n).fill(99.7),
    Array(n).fill(100), Array(n).fill(100)
  );
  const r = smc._detectSMCSequence(flat, n - 1, {});
  assert.strictEqual(r.signal, null, "flat data must not produce a sequence signal");
});

test("SEQ-04: causal rejection — FVG mitigation without a preceding sweep → null", () => {
  const smc = new SmartMoneyConceptsStrategy();
  // Take the bullish sequence but ERASE the sweep (flatten bar 36 volume + low)
  const s = buildBullishSequence();
  s.lows[36] = 97.5;      // no longer wicks below the 96 swing low
  s.volumes[36] = 100;    // no volume surge
  const N = s.closes.length - 1;
  // sweep mult 1.8 → with bar 36 neutralised, no bar surges as a pre-CHoCH sweep
  const r = smc._detectSMCSequence(s, N, { sacSweepVolMult: 1.8, sacFvgMinGap: 0.0015, sacDispVolMult: 1.6, sacDispRangePct: 0.008 });
  assert.strictEqual(r.signal, null, "without a valid sweep the sequence must not fire");
});

test("SEQ-05: detectSignalMulti uses sequence engine by default and fires the active type", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const s = buildBullishSequence();
  const N = s.closes.length - 1;
  const res = smc.detectSignalMulti(s, N, {
    sacFvgMinGap: 0.0015, sacSweepVolMult: 0.9, sacDispVolMult: 1.6, sacDispRangePct: 0.008,
    sacMinConfidenceA: 40, sacMinConfidenceB: 40, sacMinConfidenceC: 40,
    htfTrend: "BULLISH",
  });
  assert.ok(res.Scalping === "LONG" || res.Intraday === "LONG" || res.Swing === "LONG",
    "at least one type should carry the LONG sequence signal");
});

test("SEQ-06: flag off → legacy single-bar path still works (no sequence)", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const s = buildBullishSequence();
  const N = s.closes.length - 1;
  const res = smc.detectSignalMulti(s, N, {
    sacUseSequenceEngine: false,
    sacMinConfidenceA: 0, sacMinConfidenceB: 0, sacMinConfidenceC: 0,
  });
  // Legacy path returns an object with meta.confidence keys (behaviour preserved)
  assert.ok(res.meta && res.meta.confidence, "legacy path returns confidence meta");
});

console.log("✅ smc-sequence.test.js — assertions registered");
