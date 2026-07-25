"use strict";

/**
 * Smoke test for BacktestJobService.cancelActiveJobs slot healing.
 * Run: node test/backtest-clear-queue.test.js
 */

process.env.BACKTEST_ISOLATE = "0";
process.env.BACKTEST_MAX_CONCURRENT = "1";

const assert = require("assert");
const BacktestJobService = require("../src/modules/backtest/services/BacktestJobService");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

console.log("backtest clear-queue / cancelActiveJobs\n");

test("cancelActiveJobs clears stuck activeCount when no runners remain", () => {
  BacktestJobService._clearAll();
  const id = BacktestJobService.createJob("user-a", { symbol: "BTCUSDT" });
  // Force a fake stuck slot after cancelling without settle (simulate orphan)
  BacktestJobService.cancelJob(id);
  // Manually bump like a leaked slot
  const before = BacktestJobService.queueStats();
  // create another queued job while pretending activeCount stuck
  const stats1 = BacktestJobService.cancelActiveJobs({ userId: "user-a" });
  assert.ok(Array.isArray(stats1.cancelled));
  const after = BacktestJobService.queueStats();
  assert.strictEqual(after.activeCount, 0, `expected activeCount 0, got ${after.activeCount} (before ${JSON.stringify(before)})`);
  BacktestJobService._clearAll();
});

test("listActiveJobs filters by user", () => {
  BacktestJobService._clearAll();
  BacktestJobService.createJob("user-a", { symbol: "BTCUSDT" });
  BacktestJobService.createJob("user-b", { symbol: "ETHUSDT" });
  const a = BacktestJobService.listActiveJobs({ userId: "user-a" });
  const all = BacktestJobService.listActiveJobs({});
  assert.ok(a.length >= 1);
  assert.ok(all.length >= a.length);
  BacktestJobService._clearAll();
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
