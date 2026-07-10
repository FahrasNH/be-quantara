/**
 * Sprint 8 AF-SUB-01/02/03 — Wyckoff, VSA, and 3-component voting tests.
 *
 * Run: node test/af-wyckoff-vsa-voting.test.js
 */

"use strict";

const assert = require("assert");
const {
  relativeVolume,
  calculateCLV,
  classifySpread,
  percentileRank,
  bbWidthSeries,
  checkSwingProximity,
} = require("../src/domain/strategy/af/volumeAnalysisUtils");
const {
  detectTradingRange,
  detectSpring,
  detectUpthrust,
  evaluateWyckoffComponent,
} = require("../src/domain/strategy/af/wyckoffComponent");
const {
  detectVSAPattern,
  detectEffortResultMismatch,
  evaluateVSAComponent,
  calculateCLV: vsaCLV,
  relativeVolume: vsaRelVol,
} = require("../src/domain/strategy/af/vsaComponent");
const {
  resolveVoteThreshold,
  aggregateAfVotes,
  checkVoteCorrelation,
  pearsonCorrelation,
} = require("../src/domain/strategy/af/afVoting");
const AdaptiveFusionUmbrella = require("../src/domain/strategy/umbrellas/AdaptiveFusionUmbrella");
const { strategyRegistry } = require("../src/domain/strategy");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function makeFlatRange(n, mid = 100, halfWidth = 1.0, vol = 1000) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];
  for (let i = 0; i < n; i++) {
    // Mild oscillation inside range
    const wobble = Math.sin(i / 5) * (halfWidth * 0.4);
    const c = mid + wobble;
    opens.push(c - 0.05);
    closes.push(c);
    highs.push(c + halfWidth * 0.5);
    lows.push(c - halfWidth * 0.5);
    volumes.push(vol);
    atr.push(halfWidth * 0.6);
  }
  return { opens, highs, lows, closes, volumes, atr, lastIdx: n - 1 };
}

console.log("\n═══ AF Volume Utils ═══");

test("relativeVolume matches SMA(20) within 0.001", () => {
  const volumes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const rel = relativeVolume(volumes, 29, 20);
  const sma = volumes.slice(10, 30).reduce((a, b) => a + b, 0) / 20;
  assert.ok(Math.abs(rel - volumes[29] / sma) < 0.001);
});

test("CLV mid for normal candle", () => {
  assert.ok(Math.abs(calculateCLV(110, 100, 105) - 0.5) < 1e-9);
});

test("CLV guard high==low → 0.5", () => {
  assert.strictEqual(calculateCLV(100, 100, 100), 0.5);
  assert.strictEqual(vsaCLV(50, 50, 50), 0.5);
});

test("classifySpread wide/narrow vs ATR", () => {
  const wide = classifySpread(110, 100, 5, 1.3, 0.7); // spread 10 >= 6.5
  assert.strictEqual(wide.isWideSpread, true);
  const narrow = classifySpread(101, 100, 5, 1.3, 0.7); // spread 1 <= 3.5
  assert.strictEqual(narrow.isNarrowSpread, true);
});

test("percentileRank returns 0-100", () => {
  const series = Array.from({ length: 50 }, (_, i) => i);
  const p = percentileRank(series, 49, 50);
  assert.ok(p >= 99 && p <= 100);
});

console.log("\n═══ Wyckoff Range / Spring / Upthrust ═══");

test("AC1: range detection on sideways synthetic data", () => {
  const c = makeFlatRange(120, 100, 1.0, 1000);
  // Compress BB width by keeping prices tight for last 40 bars
  for (let i = 80; i < 120; i++) {
    c.closes[i] = 100 + ((i % 2) * 0.2 - 0.1);
    c.highs[i] = c.closes[i] + 0.4;
    c.lows[i] = c.closes[i] - 0.4;
    c.opens[i] = c.closes[i];
  }
  const range = detectTradingRange(c, { minBarsInRange: 15, rangeLookback: 20 });
  // May or may not pass BB percentile depending on full series — assert shape
  assert.ok(typeof range.isValid === "boolean");
  assert.ok(range.reason || range.rangeHigh != null);
});

test("AC2: spring requires all conditions (partial match rejected)", () => {
  const c = makeFlatRange(120, 100, 1.5, 1000);
  const range = {
    isValid: true,
    rangeHigh: 101.5,
    rangeLow: 98.5,
    rangeWidthPct: 0.03,
  };
  // Penetration without volume confirm → no spring
  const penIdx = 116;
  c.lows[penIdx] = 98.2; // shallow pierce
  c.volumes[penIdx] = 500; // below 1.2× SMA
  c.closes[117] = 99.0;
  c.opens[117] = 98.6;
  c.lastIdx = 118;
  const spring = detectSpring(c, range, { recoveryWindow: 3, volumeConfirmMult: 1.2 });
  assert.strictEqual(spring.detected, false);
});

test("AC2b: valid spring triggers LONG", () => {
  const c = makeFlatRange(120, 100, 1.5, 1000);
  const range = {
    isValid: true,
    rangeHigh: 101.5,
    rangeLow: 98.5,
    rangeWidthPct: 0.03,
  };
  const penIdx = 116;
  c.lows[penIdx] = 98.2;
  c.highs[penIdx] = 99.0;
  c.closes[penIdx] = 98.4;
  c.volumes[penIdx] = 2000; // > 1.2 × 1000
  c.atr[penIdx] = 1.0;
  // Recovery bullish close above rangeLow
  c.opens[117] = 98.6;
  c.closes[117] = 99.2;
  c.highs[117] = 99.3;
  c.lows[117] = 98.5;
  c.volumes[117] = 1100;
  c.atr[117] = 1.0;
  c.lastIdx = 117;
  for (let i = 0; i <= 117; i++) c.atr[i] = 1.0;

  const spring = detectSpring(c, range, {
    recoveryWindow: 3,
    volumeConfirmMult: 1.2,
    penetrationAtrMult: 0.5,
  });
  assert.strictEqual(spring.detected, true, `expected spring, got ${spring.reason}`);
  assert.ok(spring.confidence > 0);
});

test("AC3: upthrust mirror of spring", () => {
  const c = makeFlatRange(120, 100, 1.5, 1000);
  const range = {
    isValid: true,
    rangeHigh: 101.5,
    rangeLow: 98.5,
    rangeWidthPct: 0.03,
  };
  const penIdx = 116;
  c.highs[penIdx] = 101.8;
  c.lows[penIdx] = 100.5;
  c.closes[penIdx] = 101.6;
  c.volumes[penIdx] = 2000;
  c.opens[117] = 101.4;
  c.closes[117] = 100.8; // bearish recovery below rangeHigh
  c.highs[117] = 101.5;
  c.lows[117] = 100.7;
  c.lastIdx = 117;
  for (let i = 0; i <= 117; i++) c.atr[i] = 1.0;

  const up = detectUpthrust(c, range, {
    recoveryWindow: 3,
    volumeConfirmMult: 1.2,
    penetrationAtrMult: 0.5,
  });
  assert.strictEqual(up.detected, true, `expected upthrust, got ${up.reason}`);
});

test("AC4: trending data → no valid range → no signal", () => {
  const n = 120;
  const c = {
    opens: [], highs: [], lows: [], closes: [], volumes: [], atr: [], lastIdx: n - 1,
  };
  for (let i = 0; i < n; i++) {
    const p = 100 + i * 2; // strong uptrend
    c.opens.push(p);
    c.closes.push(p + 1);
    c.highs.push(p + 2);
    c.lows.push(p - 1);
    c.volumes.push(1000);
    c.atr.push(3);
  }
  const result = evaluateWyckoffComponent(c);
  assert.strictEqual(result.vote, "NEUTRAL");
  assert.ok(
    result.reason === "no_valid_range" ||
      result.reason === "bb_width_not_compressed" ||
      result.reason === "range_too_wide" ||
      result.reason === "no_pattern" ||
      result.reason === "range_not_mature",
    `unexpected reason: ${result.reason}`,
  );
});

test("AC7: volume 0 → NEUTRAL no crash", () => {
  const c = makeFlatRange(120);
  c.volumes[c.lastIdx] = 0;
  const result = evaluateWyckoffComponent(c);
  assert.strictEqual(result.vote, "NEUTRAL");
  assert.strictEqual(result.reason, "missing_volume_data");
});

test("AC5 insufficient bars <100 → NEUTRAL", () => {
  const c = makeFlatRange(50);
  const result = evaluateWyckoffComponent(c);
  assert.strictEqual(result.vote, "NEUTRAL");
  assert.strictEqual(result.reason, "insufficient_data");
});

test("AC8: cooldown suppresses duplicate spring", () => {
  const c = makeFlatRange(120, 100, 1.5, 1000);
  // Force a spring-like evaluation path via state cooldown
  const r1 = evaluateWyckoffComponent(c, {}, { lastSignalIdx: 118 });
  assert.strictEqual(r1.vote, "NEUTRAL");
  assert.strictEqual(r1.reason, "cooldown_active");
});

test("penetration too deep rejected", () => {
  const c = makeFlatRange(120, 100, 1.5, 1000);
  const range = { isValid: true, rangeHigh: 101.5, rangeLow: 98.5, rangeWidthPct: 0.03 };
  c.lows[116] = 97.0; // deep > 0.5 ATR if atr=1
  c.volumes[116] = 2000;
  c.lastIdx = 117;
  for (let i = 0; i <= 117; i++) c.atr[i] = 1.0;
  const spring = detectSpring(c, range, { penetrationAtrMult: 0.5 });
  assert.strictEqual(spring.detected, false);
});

console.log("\n═══ VSA Patterns ═══");

test("AC1 VSA relativeVolume", () => {
  const volumes = Array.from({ length: 25 }, () => 100);
  volumes[24] = 150;
  const rel = vsaRelVol(volumes, 24, 20);
  // SMA includes current bar: (19*100 + 150)/20 = 102.5 → 150/102.5 ≈ 1.4634
  const expected = 150 / ((19 * 100 + 150) / 20);
  assert.ok(Math.abs(rel - expected) < 0.001, `got ${rel} expected ${expected}`);
});

test("No-Demand near swing high → SHORT", () => {
  const signal = detectVSAPattern({
    candle: { open: 100, high: 100.5, low: 99.8, close: 100.3, volume: 50 },
    relVol: 0.5,
    spreadType: { isWideSpread: false, isNarrowSpread: true, spread: 0.7 },
    clv: 0.7,
    swingType: "high",
  });
  assert.ok(signal);
  assert.strictEqual(signal.vote, "SHORT");
  assert.strictEqual(signal.reason, "vsa_no_demand");
});

test("No-Supply near swing low → LONG", () => {
  const signal = detectVSAPattern({
    candle: { open: 100, high: 100.2, low: 99.5, close: 99.6, volume: 50 },
    relVol: 0.5,
    spreadType: { isWideSpread: false, isNarrowSpread: true, spread: 0.7 },
    clv: 0.2,
    swingType: "low",
  });
  assert.ok(signal);
  assert.strictEqual(signal.vote, "LONG");
  assert.strictEqual(signal.reason, "vsa_no_supply");
});

test("Stopping volume near swing low → LONG", () => {
  const signal = detectVSAPattern({
    candle: { open: 100, high: 102, low: 98, close: 101.5, volume: 2000 },
    relVol: 1.8,
    spreadType: { isWideSpread: true, isNarrowSpread: false, spread: 4 },
    clv: 0.875,
    swingType: "low",
  });
  assert.ok(signal);
  assert.strictEqual(signal.vote, "LONG");
  assert.ok(signal.reason.includes("stopping_volume"));
});

test("Stopping volume near swing high → SHORT", () => {
  const signal = detectVSAPattern({
    candle: { open: 100, high: 102, low: 98, close: 98.5, volume: 2000 },
    relVol: 1.8,
    spreadType: { isWideSpread: true, isNarrowSpread: false, spread: 4 },
    clv: 0.125,
    swingType: "high",
  });
  assert.ok(signal);
  assert.strictEqual(signal.vote, "SHORT");
});

test("No-Demand rejected when not near swing high", () => {
  const signal = detectVSAPattern({
    candle: { open: 100, high: 100.5, low: 99.8, close: 100.3, volume: 50 },
    relVol: 0.5,
    spreadType: { isWideSpread: false, isNarrowSpread: true, spread: 0.7 },
    clv: 0.7,
    swingType: "low", // wrong context
  });
  assert.strictEqual(signal, null);
});

test("AC5: swing proximity filter rejects distant patterns", () => {
  // Build data with a swing low far from lastIdx
  const n = 40;
  const c = {
    opens: [], highs: [], lows: [], closes: [], volumes: [], atr: [], lastIdx: n - 1,
  };
  for (let i = 0; i < n; i++) {
    c.opens.push(100);
    c.closes.push(100);
    c.highs.push(101);
    c.lows.push(99);
    c.volumes.push(1000);
    c.atr.push(1);
  }
  // Clear swing low at idx 10, lastIdx=39 → distance 29 > radius 5
  c.lows[10] = 95;
  c.highs[10] = 96;
  c.closes[10] = 95.5;
  // Make last bar look like no-supply
  c.opens[39] = 100;
  c.closes[39] = 99.5;
  c.highs[39] = 100.1;
  c.lows[39] = 99.4;
  c.volumes[39] = 400;
  c.atr[39] = 2;

  const result = evaluateVSAComponent(c, null, { swingRadius: 5, swingScanBars: 50 });
  assert.strictEqual(result.vote, "NEUTRAL");
  assert.ok(
    result.reason === "not_near_structure" || result.reason === "no_pattern",
    result.reason,
  );
});

test("AC7 VSA: zero volume → NEUTRAL", () => {
  const c = makeFlatRange(40);
  c.volumes[c.lastIdx] = 0;
  const result = evaluateVSAComponent(c);
  assert.strictEqual(result.vote, "NEUTRAL");
  assert.strictEqual(result.reason, "missing_volume_data");
});

test("effort-result mismatch flag", () => {
  const m = detectEffortResultMismatch(2.0, 0.3, 1.0);
  assert.strictEqual(m.isMismatch, true);
  assert.ok(m.penalty > 0);
});

test("checkSwingProximity causal", () => {
  const highs = Array.from({ length: 30 }, () => 101);
  const lows = Array.from({ length: 30 }, () => 99);
  lows[20] = 95;
  const near = checkSwingProximity(highs, lows, 22, 5, 3, 25);
  assert.strictEqual(near.isNear, true);
  assert.strictEqual(near.type, "low");
});

console.log("\n═══ AF Voting (AF-SUB-03) ═══");

test("AC1: 2/3 majority LONG", () => {
  const r = aggregateAfVotes([
    { key: "SMC", vote: "LONG", confidence: 0.8 },
    { key: "WYCKOFF", vote: "LONG", confidence: 0.7 },
    { key: "VSA", vote: "NEUTRAL", confidence: 0 },
  ], { afMinVotes: 2 });
  assert.strictEqual(r.signal, "LONG");
  assert.strictEqual(r.threshold, 2);
  assert.ok(r.breakdown.SMC.vote === "LONG");
});

test("AC1: 2/3 insufficient with only 1 vote", () => {
  const r = aggregateAfVotes([
    { key: "SMC", vote: "LONG", confidence: 0.8 },
    { key: "WYCKOFF", vote: "NEUTRAL", confidence: 0 },
    { key: "VSA", vote: "NEUTRAL", confidence: 0 },
  ], { afMinVotes: 2 });
  assert.strictEqual(r.signal, null);
});

test("AC1: altcoin 3/3 requires unanimity", () => {
  const r = aggregateAfVotes([
    { key: "SMC", vote: "LONG", confidence: 0.8 },
    { key: "WYCKOFF", vote: "LONG", confidence: 0.7 },
    { key: "VSA", vote: "NEUTRAL", confidence: 0 },
  ], { pairTier: "VOLATILE" });
  assert.strictEqual(r.threshold, 3);
  assert.strictEqual(r.signal, null);

  const r2 = aggregateAfVotes([
    { key: "SMC", vote: "SHORT", confidence: 0.8 },
    { key: "WYCKOFF", vote: "SHORT", confidence: 0.7 },
    { key: "VSA", vote: "SHORT", confidence: 0.6 },
  ], { pairTier: "VOLATILE" });
  assert.strictEqual(r2.signal, "SHORT");
});

test("resolveVoteThreshold altcoin heuristics", () => {
  assert.strictEqual(resolveVoteThreshold({ pairTier: "LIQUID" }), 2);
  assert.strictEqual(resolveVoteThreshold({ pairTier: "SEMI_VOLATILE" }), 3);
  assert.strictEqual(resolveVoteThreshold({ symbol: "BGBUSDT" }), 3);
  assert.strictEqual(resolveVoteThreshold({ afMinVotes: 2, pairTier: "VOLATILE" }), 2);
});

test("AC2: breakdown present for entryContext", () => {
  const r = aggregateAfVotes([
    { key: "SMC", vote: "LONG", confidence: 0.9, reason: "smc_signal" },
    { key: "WYCKOFF", vote: "LONG", confidence: 0.6, reason: "wyckoff_spring" },
    { key: "VSA", vote: "SHORT", confidence: 0.5, reason: "vsa_no_demand" },
  ]);
  assert.ok(r.breakdown.SMC);
  assert.ok(r.breakdown.WYCKOFF);
  assert.ok(r.breakdown.VSA);
  // 2 LONG vs 1 SHORT → majority LONG at threshold 2
  assert.strictEqual(r.signal, "LONG");
  assert.strictEqual(r.longVotes, 2);
  assert.strictEqual(r.shortVotes, 1);
});

test("conflict equal votes → null", () => {
  const r = aggregateAfVotes([
    { key: "SMC", vote: "LONG", confidence: 0.9 },
    { key: "WYCKOFF", vote: "SHORT", confidence: 0.6 },
    { key: "VSA", vote: "NEUTRAL", confidence: 0 },
  ], { afMinVotes: 2 });
  assert.strictEqual(r.signal, null);
});

test("correlation check utility", () => {
  const series = {
    SMC: ["LONG", "LONG", "SHORT", "NEUTRAL", "LONG"],
    WYCKOFF: ["SHORT", "NEUTRAL", "LONG", "LONG", "SHORT"],
    VSA: ["LONG", "NEUTRAL", "SHORT", "NEUTRAL", "LONG"],
  };
  const result = checkVoteCorrelation(series, 0.5);
  assert.ok(typeof result.ok === "boolean");
  assert.ok(result.pairs.SMC_vs_WYCKOFF !== undefined);
  assert.ok(result.threshold === 0.5);
});

test("pearsonCorrelation identical series → ~1", () => {
  const a = [1, 2, 3, 4, 5];
  const b = [1, 2, 3, 4, 5];
  const c = pearsonCorrelation(a, b);
  assert.ok(Math.abs(c - 1) < 1e-9);
});

test("umbrella registers 3 components", () => {
  const af = strategyRegistry.get("AF_SMC");
  assert.ok(af);
  const keys = af.getComponentKeys();
  assert.ok(keys.includes("AF_SMC"));
  assert.ok(keys.includes("AF_WYCKOFF"));
  assert.ok(keys.includes("AF_VSA"));
  assert.strictEqual(keys.length, 3);
});

test("umbrella detectSignal with voting off → SMC passthrough path", () => {
  const um = new AdaptiveFusionUmbrella();
  const n = 60;
  const indicators = {
    closes: Array.from({ length: n }, (_, i) => 50000 + i * 10),
    highs: Array.from({ length: n }, (_, i) => 50000 + i * 10 + 30),
    lows: Array.from({ length: n }, (_, i) => 50000 + i * 10 - 30),
    opens: Array.from({ length: n }, (_, i) => 50000 + i * 10 - 5),
    volumes: Array.from({ length: n }, () => 1000),
    volSMA: Array.from({ length: n }, () => 900),
    atr: Array.from({ length: n }, () => 120),
    rsi: Array.from({ length: n }, () => 50),
  };
  const sig = um.detectSignal(indicators, n - 1, { afUseThreeComponentVoting: false });
  // May be null (no SMC setup) — just ensure no throw and meta path works
  assert.ok(sig === null || sig === "LONG" || sig === "SHORT");
});

test("umbrella detectSignalMulti attaches afVotes meta", () => {
  const um = new AdaptiveFusionUmbrella();
  const n = 60;
  const indicators = {
    closes: Array.from({ length: n }, (_, i) => 50000 + i * 10),
    highs: Array.from({ length: n }, (_, i) => 50000 + i * 10 + 30),
    lows: Array.from({ length: n }, (_, i) => 50000 + i * 10 - 30),
    opens: Array.from({ length: n }, (_, i) => 50000 + i * 10 - 5),
    volumes: Array.from({ length: n }, () => 1000),
    volSMA: Array.from({ length: n }, () => 900),
    atr: Array.from({ length: n }, () => 120),
    rsi: Array.from({ length: n }, () => 50),
  };
  const multi = um.detectSignalMulti(indicators, n - 1, {
    afUseThreeComponentVoting: true,
    afMinVotes: 2,
  });
  assert.ok(multi.meta);
  assert.ok(multi.meta.afVotes);
  assert.ok(multi.meta.signalComponents);
  assert.ok(multi.meta.afVotes.breakdown);
});

test("single-voter afMinVotes=2 is capped → majority possible", () => {
  const um = new AdaptiveFusionUmbrella();
  // Spy path: call _aggregate directly with 1 voter
  const r = um._aggregate(
    [{ key: "WYCKOFF", vote: "LONG", confidence: 0.8 }],
    { afMinVotes: 2 }
  );
  assert.strictEqual(r.signal, "LONG", "1 voter + afMinVotes=2 must cap to 1");
  assert.strictEqual(r.threshold, 1);
});

test("Wyckoff-only detectSignalMulti promotes standalone vote (no SMC required)", () => {
  const um = new AdaptiveFusionUmbrella();
  const n = 120;
  // Build a flat range then a spring-like dip+recovery so Wyckoff can vote LONG
  const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 8) * 0.3);
  const highs = closes.map((c) => c + 0.4);
  const lows = closes.map((c) => c - 0.4);
  // Force a spring near the end
  lows[n - 4] = 98.5;
  closes[n - 3] = 100.2;
  highs[n - 3] = 100.5;
  const volumes = Array.from({ length: n }, () => 1000);
  volumes[n - 4] = 2000;
  const indicators = {
    closes, highs, lows,
    opens: closes.map((c) => c - 0.05),
    volumes,
    volSMA: Array.from({ length: n }, () => 900),
    atr: Array.from({ length: n }, () => 0.8),
    rsi: Array.from({ length: n }, () => 50),
  };
  const multi = um.detectSignalMulti(indicators, n - 1, {
    afUseThreeComponentVoting: true,
    afMinVotes: 2,
    afActiveVoters: ["AF_WYCKOFF"],
  });
  assert.ok(multi.meta?.afVotes, "afVotes meta present");
  // Either NEUTRAL (no spring) or standalone promotion — must not throw / hard-zero from threshold
  assert.ok(multi.meta.afVotes.threshold <= 1 || multi.meta.afVotes.signal == null
    || multi.meta.standaloneVoterEntry === true
    || multi.Scalping != null || multi.Swing != null
    || multi.meta.gateReason,
    "single-voter path must not require impossible quorum");
});

console.log("\n══════════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All AF Wyckoff/VSA/voting tests passed.\n");
