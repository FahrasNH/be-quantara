/**
 * Isolated-worker cancellation regression.
 * Run: node test/backtest-job-worker-cancel.test.js
 */

"use strict";

const assert = require("assert");
const path = require("path");

process.env.BACKTEST_ISOLATE = "1";
process.env.BACKTEST_MAX_CONCURRENT = "1";
process.env.BACKTEST_WORKER_PATH = path.join(
  __dirname,
  "fixtures/backtest-controlled-worker.js"
);

const BacktestJobService = require("../src/server/services/BacktestJobService");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(message);
}

function create(mode) {
  return BacktestJobService.createJob("worker-cancel-test", {
    sym: "BTCUSDT",
    strategyKey: "VOLUME_SPREAD_ANALYSIS",
    strategyCfg: { label: "VSA", interval: "15m" },
    periodId: "3m",
    capital: 1000,
    parameters: {},
    mode,
  });
}

(async () => {
  console.log("\n=== Backtest Isolated Worker Cancel Regression ===\n");

  const jobAId = create("hold");
  await waitFor(
    () => BacktestJobService.getJob(jobAId)?.progressLog.some((event) => event.phase === "test"),
    "Job A worker did not start"
  );
  const jobA = BacktestJobService.getJob(jobAId);
  const workerAPid = jobA._worker?.pid;
  assert.ok(workerAPid, "Job A should own an isolated child worker");
  assert.strictEqual(BacktestJobService._stats().activeCount, 1);

  const jobBId = create("done");
  assert.strictEqual(BacktestJobService.getJob(jobBId).status, "queued");
  assert.strictEqual(BacktestJobService._stats().queued, 1);

  assert.strictEqual(BacktestJobService.cancelJob(jobAId), true);
  assert.strictEqual(jobA.status, "cancelled");

  await waitFor(
    () => BacktestJobService.getJob(jobBId)?.status === "done",
    "Job B did not dispatch after cancelling Job A"
  );

  const jobB = BacktestJobService.getJob(jobBId);
  assert.strictEqual(jobB.result?.ok, true);
  assert.notStrictEqual(jobB.result?.workerPid, workerAPid, "Job B must use a new worker");
  assert.deepStrictEqual(BacktestJobService._stats(), {
    activeCount: 0,
    queued: 0,
    jobs: 2,
    isolate: true,
  });

  console.log("  ✓ cancel releases slot and dispatches queued job in a new worker");
  console.log("\n=== Results: 1 passed, 0 failed ===\n");
})()
  .catch((err) => {
    console.error(`  ✗ ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    BacktestJobService._clearAll();
  });
