/**
 * ml-readiness.test.js — Sprint 16 / ML Data Readiness Phase 1 unit tests
 *
 * Run: node test/ml-readiness.test.js
 */

"use strict";

const assert = require("assert");
const {
  detectTradingSession,
  computeIntradayPriceContext,
  resolveSignalDelayMs,
  normalizeExitReason,
  enrichEntryContextLive,
  enrichExitContextLive,
} = require("../src/modules/analytics/domain/engineTradeMlAdapter");

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

test("detectTradingSession maps UTC hours", () => {
  assert.strictEqual(detectTradingSession(10), "London");
  assert.strictEqual(detectTradingSession(15), "NY");
  assert.strictEqual(detectTradingSession(3), "Asia");
});

test("computeIntradayPriceContext finds HOD/LOD", () => {
  const dayStart = Date.UTC(2026, 6, 18, 0, 0, 0);
  const candles = [
    { timestamp: dayStart, open: 100, high: 105, low: 99, close: 102 },
    { timestamp: dayStart + 3600000, open: 102, high: 110, low: 101, close: 108 },
  ];
  const ctx = computeIntradayPriceContext(candles, new Date(dayStart + 3600000));
  assert.strictEqual(ctx.hodPrice, 110);
  assert.strictEqual(ctx.lodPrice, 99);
  assert.strictEqual(ctx.sessionOpen, 100);
});

test("resolveSignalDelayMs is non-negative", () => {
  const entry = Date.now();
  assert.strictEqual(resolveSignalDelayMs(entry - 500, entry), 500);
  assert.strictEqual(resolveSignalDelayMs(entry + 100, entry), 0);
});

test("normalizeExitReason maps SL/TP/TIME", () => {
  assert.strictEqual(normalizeExitReason("SL"), "SL_HIT");
  assert.strictEqual(normalizeExitReason("TP"), "TP_HIT");
  assert.strictEqual(normalizeExitReason("TIME_STOP"), "TIME_STOP");
});

test("enrichEntryContextLive adds session + ML fields", () => {
  const entryTime = new Date(Date.UTC(2026, 6, 18, 14, 0, 0));
  const enriched = enrichEntryContextLive({ rsi: 55 }, {
    entryTime,
    pairTier: "LIQUID",
    signalDelayMs: 120,
    winningComponent: "WYCKOFF",
    htfTrend: "BULLISH",
  });
  assert.strictEqual(enriched.session, "NY");
  assert.strictEqual(enriched.pairTier, "LIQUID");
  assert.strictEqual(enriched.signalDelayMs, 120);
  assert.strictEqual(enriched.winningComponent, "WYCKOFF");
  assert.strictEqual(enriched.htfAlignment, "BULLISH");
});

test("enrichExitContextLive adds slippage + outcome", () => {
  const enriched = enrichExitContextLive({}, {
    pnl: 10,
    pnlPct: 2,
    exitPrice: 101,
    expectedPrice: 100,
    fundingCost: 0.5,
    exitReason: "TP",
    regimeAtExit: "trending_up",
  });
  assert.strictEqual(enriched.outcome, "win");
  assert.strictEqual(enriched.exitReason, "TP_HIT");
  assert.strictEqual(enriched.slippage, 1);
  assert.strictEqual(enriched.fundingCost, 0.5);
});

console.log(`\n\nML Readiness: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
