/**
 * MD-SUB-01 / MD-SUB-02 / MD-SUB-03 — ADX regime gate + OB/FVG precision + pipeline.
 */

"use strict";

const assert = require("assert");
const { classifyAdxRegime, evaluateAdxRegimeGate } = require("#core/strategy-engine/md/adxRegimeGate.js");
const {
  detectFairValueGaps,
  detectOrderBlocks,
  refineMdEntry,
  resolveMdTakeProfit,
} = require("#core/strategy-engine/md/orderBlockFvg.js");
const MeanReversionStrategy = require("#core/strategy-engine/implementations/MeanReversionStrategy.js");
const { TIER_COMPONENT_MAP } = require("../src/config/strategies");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

console.log("\n═══ MD-SUB-01: ADX Regime Gate ═══");

test("classifyAdxRegime: balance / transition / imbalance / unknown", () => {
  assert.strictEqual(classifyAdxRegime(19.9), "balance");
  assert.strictEqual(classifyAdxRegime(20.0), "transition");
  assert.strictEqual(classifyAdxRegime(20.1), "transition");
  assert.strictEqual(classifyAdxRegime(24.9), "transition");
  assert.strictEqual(classifyAdxRegime(25.0), "imbalance");
  assert.strictEqual(classifyAdxRegime(null), "unknown");
  assert.strictEqual(classifyAdxRegime(undefined), "unknown");
});

test("evaluateAdxRegimeGate: imbalance blocks", () => {
  const r = evaluateAdxRegimeGate({ adx: 30 });
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.regime, "imbalance");
  assert.strictEqual(r.confidenceMult, 0);
});

test("evaluateAdxRegimeGate: balance full confidence", () => {
  const r = evaluateAdxRegimeGate({ adx: 15 });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.regime, "balance");
  assert.strictEqual(r.confidenceMult, 1);
});

test("evaluateAdxRegimeGate: transition reduces confidence", () => {
  const r = evaluateAdxRegimeGate({ adx: 22 });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.regime, "transition");
  assert.strictEqual(r.confidenceMult, 0.75);
});

test("evaluateAdxRegimeGate: boundary 19.9 vs 20.1", () => {
  const a = evaluateAdxRegimeGate({ adx: 19.9 });
  const b = evaluateAdxRegimeGate({ adx: 20.1 });
  assert.strictEqual(a.regime, "balance");
  assert.strictEqual(b.regime, "transition");
  assert.ok(a.confidenceMult > b.confidenceMult);
});

test("evaluateAdxRegimeGate: missing ADX fail-open", () => {
  const r = evaluateAdxRegimeGate({ adx: null });
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.regime, "unknown");
});

console.log("\n═══ MD-SUB-02: Order Block + FVG ═══");

test("detectFairValueGaps: bullish 3-candle gap", () => {
  // bars: 0 flat, 1 displacement up leaving gap vs bar -1... need i-2, i-1, i
  const highs = [100, 101, 110, 112];
  const lows  = [99, 100, 108, 109]; // lows[2]=108 > highs[0]=100 → bullish FVG
  const closes = [100, 100.5, 109, 110];
  const { bullish, bearish } = detectFairValueGaps(highs, lows, closes, 3, { fvgMinGapPct: 0.01 });
  assert.ok(bullish.length >= 1, "expected bullish FVG");
  assert.strictEqual(bearish.length, 0);
  assert.strictEqual(bullish[0].filled, false);
});

test("detectFairValueGaps: filled when price trades through", () => {
  const highs = [100, 101, 110, 112];
  const lows  = [99, 100, 108, 90];
  const closes = [100, 100.5, 109, 95]; // close below gap bottom → filled
  const { bullish } = detectFairValueGaps(highs, lows, closes, 3, { fvgMinGapPct: 0.01 });
  assert.ok(bullish.some((f) => f.filled));
});

test("detectOrderBlocks: bullish OB before displacement", () => {
  const n = 25;
  const opens = Array(n).fill(100);
  const highs = Array(n).fill(101);
  const lows = Array(n).fill(99);
  const closes = Array(n).fill(100);
  const volumes = Array(n).fill(1000);
  const volSMA = Array(n).fill(1000);
  // bar 20: bearish candle (OB), bar 21: impulsive bull with volume
  opens[20] = 100; closes[20] = 98; highs[20] = 100.5; lows[20] = 97.5;
  opens[21] = 98; closes[21] = 105; highs[21] = 106; lows[21] = 97.8;
  volumes[21] = 2500;
  closes[24] = 104;
  const { bullish } = detectOrderBlocks(opens, highs, lows, closes, volumes, volSMA, 24, {
    obLookback: 20,
    obDispMult: 1.5,
  });
  assert.ok(bullish.length >= 1, "expected bullish order block");
  assert.strictEqual(bullish[0].idx, 20);
});

test("refineMdEntry: no structure → reduced confidence, signal kept", () => {
  const n = 40;
  const flat = Array(n).fill(100);
  const r = refineMdEntry({
    signal: "LONG",
    price: 100,
    atr: 2,
    opens: flat,
    highs: flat.map((v) => v + 0.1),
    lows: flat.map((v) => v - 0.1),
    closes: flat,
    volumes: Array(n).fill(100),
    volSMA: Array(n).fill(100),
    lastIdx: n - 1,
  });
  assert.strictEqual(r.hasConfluence, false);
  assert.ok(r.confidenceMult < 1);
});

test("resolveMdTakeProfit: prefers unfilled FVG midpoint", () => {
  const fvgs = {
    bullish: [{ type: "bullish", top: 110, bottom: 108, midpoint: 109, filled: false, idx: 5 }],
    bearish: [],
  };
  const tp = resolveMdTakeProfit({ signal: "LONG", entryPrice: 100, fvgs, bbMiddle: 105 });
  assert.strictEqual(tp.source, "fvg");
  assert.strictEqual(tp.takeProfit, 109);
});

test("resolveMdTakeProfit: fallback to BB middle when no FVG", () => {
  const tp = resolveMdTakeProfit({
    signal: "LONG",
    entryPrice: 100,
    fvgs: { bullish: [], bearish: [] },
    bbMiddle: 105,
  });
  assert.strictEqual(tp.source, "bb_middle");
  assert.strictEqual(tp.takeProfit, 105);
});

console.log("\n═══ MD-SUB-03: Pipeline integration ═══");

test("TIER_COMPONENT_MAP MINT/VAULT race pools (Sprint 10/11)", () => {
  const mint = TIER_COMPONENT_MAP.MINT;
  assert.deepStrictEqual(mint.active, ["MD_MR", "MD_SD", "MD_SA"]);
  assert.strictEqual(mint.combination.mode, "race");
  assert.deepStrictEqual(mint.combination.participants, ["MD_MR", "MD_SD", "MD_SA"]);
  const vault = TIER_COMPONENT_MAP.VAULT;
  assert.deepStrictEqual(vault.active, ["BS_ICT", "BS_LS"]);
  assert.deepStrictEqual(vault.halted, ["BS_BR"]);
  assert.strictEqual(vault.combination.mode, "race");
});

function buildOversoldIndicators({ adxVal = 15 } = {}) {
  const closes = Array(60).fill(42000);
  closes[59] = 40500;
  const rsi = Array(60).fill(50);
  rsi[59] = 20;
  const volumes = Array(60).fill(1500);
  const atr = Array(60).fill(120);
  const volSMA = Array(60).fill(1500);
  const vwap = Array(60).fill(42000);
  const highs = closes.map((c) => c + 50);
  const lows = closes.map((c) => c - 50);
  const opens = closes.map((c) => c);
  const adx = Array(60).fill(adxVal);
  return { closes, rsi, volumes, atr, volSMA, vwap, highs, lows, opens, adx };
}

test("MeanReversionStrategy: ADX imbalance blocks signal", () => {
  const s = new MeanReversionStrategy();
  const ind = buildOversoldIndicators({ adxVal: 30 });
  assert.strictEqual(s.detectSignal(ind, 59), null);
});

test("MeanReversionStrategy: ADX balance allows signal + meta", () => {
  const s = new MeanReversionStrategy();
  const ind = buildOversoldIndicators({ adxVal: 12 });
  const sig = s.detectSignal(ind, 59);
  assert.strictEqual(sig, "LONG");
  const meta = s.getLastSignalMeta();
  assert.strictEqual(meta.adxRegime, "balance");
  assert.ok(meta.componentConfidence > 0);
});

test("MeanReversionStrategy: ADX transition reduces confidence vs balance", () => {
  const s = new MeanReversionStrategy();
  const bal = buildOversoldIndicators({ adxVal: 12 });
  s.detectSignal(bal, 59);
  const confBal = s.getLastSignalMeta().componentConfidence;

  const s2 = new MeanReversionStrategy();
  const tr = buildOversoldIndicators({ adxVal: 22 });
  s2.detectSignal(tr, 59);
  const confTr = s2.getLastSignalMeta().componentConfidence;
  assert.ok(confTr < confBal, `transition ${confTr} should be < balance ${confBal}`);
});

test("MeanReversionStrategy: mdAdxGateEnabled=false bypasses gate", () => {
  const s = new MeanReversionStrategy();
  const ind = buildOversoldIndicators({ adxVal: 40 });
  const sig = s.detectSignal(ind, 59, { mdAdxGateEnabled: false });
  assert.strictEqual(sig, "LONG");
});

console.log("\nAll MD pipeline tests passed.\n");
