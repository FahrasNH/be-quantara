/**
 * ml-shadow-backfill.test.js — MLShadowLog backfill helpers
 *
 * Run: node test/ml-shadow-backfill.test.js
 */

"use strict";

const assert = require("assert");
const {
  buildShadowLogPayload,
  resolveEntryContext,
  DEFAULT_THRESHOLD,
} = require("../scripts/ml/backfill-ml-shadow-log");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(".");
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${name}: ${err.message}`);
  }
}

const sampleRow = {
  id:            42,
  symbol:        "BTCUSDT",
  side:          "LONG",
  entry_price:   50000,
  open_time:     new Date("2026-07-01T10:00:00.000Z"),
  close_time:    new Date("2026-07-01T12:00:00.000Z"),
  pnl:           12.5,
  pnl_pct:       0.8,
  reason:        "TP",
  strategy_name: "MEAN_REVERSION",
  indicators:    JSON.stringify({ rsi: 32, atr: 120, htfTrend: "BULLISH", afMarketCond: "trending_up" }),
  entry_context: null,
  pair_tier:     "LIQUID",
};

test("resolveEntryContext falls back to indicators snapshot", () => {
  const ctx = resolveEntryContext(sampleRow);
  assert.strictEqual(ctx.rsi, 32);
  assert.ok(ctx.htfRegime === "trending_up" || ctx.regime != null);
});

test("buildShadowLogPayload sets outcome from pnl", () => {
  const payload = buildShadowLogPayload(sampleRow, { pWin: 0.72, threshold: DEFAULT_THRESHOLD });
  assert.strictEqual(payload.tradeId, "42");
  assert.strictEqual(payload.actualOutcome, "win");
  assert.strictEqual(payload.prediction, "win");
  assert.strictEqual(payload.strategyKey, "MEAN_REVERSION");
  assert.strictEqual(payload.createdAt.toISOString(), sampleRow.open_time.toISOString());
});

test("buildShadowLogPayload marks loss when pWin below threshold", () => {
  const lossRow = { ...sampleRow, pnl: -5, pnl_pct: -0.3 };
  const payload = buildShadowLogPayload(lossRow, { pWin: 0.4, threshold: DEFAULT_THRESHOLD });
  assert.strictEqual(payload.actualOutcome, "loss");
  assert.strictEqual(payload.prediction, "loss");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
