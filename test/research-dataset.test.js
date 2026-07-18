"use strict";

/**
 * research-dataset.test.js — Sprint 16 Research Dataset SSOT unit tests.
 */

const assert = require("assert");
const {
  parseDurationMinutes,
  parseDateTime,
  mapExportRowToDataset,
  buildGradedFromRow,
} = require("../src/modules/research/services/ResearchDatasetMapper");
const {
  scoreTierFor,
  smcBreakdownToFeatureScores,
  resolveStrategyKey,
} = require("../src/models/researchDatasetSchema");
const {
  pearsonIC,
  checkMonotonicity,
  tierStats,
} = require("../src/modules/research/services/ResearchDatasetValidator");
const { isCompleteRecord } = require("../src/modules/research/services/ResearchDatasetService");

console.log("\n═══ Research Dataset SSOT ═══\n");

// ── Mapper ──────────────────────────────────────────────────────────────────

assert.strictEqual(parseDurationMinutes("5m"), 5);
assert.strictEqual(parseDurationMinutes("1h 45m"), 105);
assert.strictEqual(parseDurationMinutes("2h"), 120);

const dt = parseDateTime("21 October 2021, 08:20 PM");
assert.ok(dt instanceof Date);
assert.strictEqual(dt.getUTCFullYear(), 2021);

const sampleRow = {
  ID: "session-1-1-1",
  Symbol: "BTCUSDT",
  Side: "LONG",
  Strategy: "Adaptive Fusion",
  Component: "SMART_MONEY_CONCEPTS",
  "Entry Price": 63114.99,
  "Exit Price": 62652.94,
  "PnL Gross": -2.38,
  Fee: 0.26,
  "PnL Net": -2.64,
  Result: "loss",
  Confidence: 50,
  "HTF Trend": "BEARISH",
  "Daily Regime": "STRONG_TREND",
  Session: "New York",
  ATR: 274.8,
  "Entry Reasons": "Liquidity Sweep, CHoCH, Bullish FVG, Displacement",
  "Exit Reason": "Stop Loss",
  Duration: "5m",
  "Open Time": "21 October 2021, 08:20 PM",
  "Close Time": "21 October 2021, 08:25 PM",
  Exchange: "binance",
};

const mapped = mapExportRowToDataset(sampleRow, {
  migrationBatch: "test_window",
  sourceFile: "test.xlsx",
});
assert.ok(mapped.tradeId.startsWith("test_window:"));
assert.strictEqual(mapped.strategyKey, "SMART_MONEY_CONCEPTS");
assert.strictEqual(mapped.symbol, "BTCUSDT");
assert.ok(mapped.gradedScore != null);
assert.ok(mapped.featureScores);
assert.ok(Array.isArray(mapped.entryReasons));
assert.ok(mapped.entryReasons.length >= 3);
assert.strictEqual(mapped.holdDurationMinutes, 5);
assert.ok(mapped.mfe != null || mapped.mae != null);

const mlRow = {
  ...sampleRow,
  "Sweep Strength": 1.38,
  "FVG Size ATR": 0.77,
  "OB Distance ATR": 0.5,
  "Displacement %": 0.17,
  "HTF ADX": 48.5,
};
const mlGraded = buildGradedFromRow(mlRow, "SMART_MONEY_CONCEPTS");
assert.ok(mlGraded.gradedScore >= 0 && mlGraded.gradedScore <= 100);
assert.ok(mlGraded.featureScores.totalSmcScore != null);

// ── Schema helpers ──────────────────────────────────────────────────────────

assert.strictEqual(scoreTierFor(20), "low");
assert.strictEqual(scoreTierFor(50), "mid");
assert.strictEqual(scoreTierFor(80), "high");
assert.strictEqual(resolveStrategyKey("Adaptive Fusion"), "SMART_MONEY_CONCEPTS");

const fs = smcBreakdownToFeatureScores({
  sweepQuality: 20,
  chochDisplacement: 15,
  fvgQuality: 10,
}, 75);
assert.strictEqual(fs.sweepScore, 20);
assert.strictEqual(fs.totalSmcScore, 75);

// ── Validator ───────────────────────────────────────────────────────────────

const ic = pearsonIC([10, 50, 90], [0, 0, 1]);
assert.ok(ic > 0.8);

const tiers = tierStats([
  { gradedScore: 20, result: "loss", pnlNet: -1, mfePercent: 0.1, maePercent: 0.5 },
  { gradedScore: 25, result: "loss", pnlNet: -0.5, mfePercent: 0.2, maePercent: 0.4 },
  { gradedScore: 50, result: "win", pnlNet: 0.5, mfePercent: 0.5, maePercent: 0.2 },
  { gradedScore: 55, result: "loss", pnlNet: -0.2, mfePercent: 0.4, maePercent: 0.3 },
  { gradedScore: 80, result: "win", pnlNet: 1.5, mfePercent: 1.0, maePercent: 0.1 },
  { gradedScore: 85, result: "win", pnlNet: 2.0, mfePercent: 1.2, maePercent: 0.1 },
]);
assert.ok(tiers.high.winRate > tiers.low.winRate);

const mono = checkMonotonicity(tiers);
assert.strictEqual(mono.winRateMonotonic, true);

assert.strictEqual(isCompleteRecord(mapped), true);

console.log("  ✓ mapper + schema + validator tests passed\n");
