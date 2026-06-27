/**
 * Grok backtest async job service — unit tests.
 * Run: node test/grok-backtest-job.test.js
 */

const GrokBacktestJobService = require("../src/server/services/GrokBacktestJobService");

let pass = 0;
let fail = 0;

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail++;
      console.log(`  ✗ ${name}: ${err.message}`);
    } finally {
      GrokBacktestJobService._clearAll();
    }
  })();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log("\n=== Grok Backtest Job Tests ===\n");

(async () => {
  await test("createJob — invalid signals selesai tanpa API call", async () => {
    const jobId = GrokBacktestJobService.createJob("user-1", {
      strategy_key: "ADAPTIVE_FUSION",
      symbol: "BTCUSDT",
      signals: [{ id: "1", barIndex: 1 }],
    });

    let job;
    for (let i = 0; i < 50; i++) {
      job = GrokBacktestJobService.getJob("user-1", jobId);
      if (job?.status === "done") break;
      await sleep(50);
    }

    if (!job || job.status !== "done") throw new Error(`expected done, got ${job?.status}`);
    if (job.stats.total !== 1) throw new Error(`expected total 1, got ${job.stats.total}`);
    if (job.stats.rejected !== 1) throw new Error(`expected rejected 1, got ${job.stats.rejected}`);
    if (!job.decisions["1"]) throw new Error("missing decision for signal 1");
  });

  await test("getJob — user mismatch returns null", async () => {
    const jobId = GrokBacktestJobService.createJob("user-a", {
      strategy_key: "TREND_MOMENTUM",
      symbol: "ETHUSDT",
      signals: [{ id: "x" }],
    });
    const job = GrokBacktestJobService.getJob("user-b", jobId);
    if (job) throw new Error("expected null for wrong user");
  });

  await test("toPublicJob — hides decisions until done", async () => {
    const jobId = GrokBacktestJobService.createJob("user-1", {
      strategy_key: "MEAN_REVERSION",
      symbol: "SOLUSDT",
      signals: [{ id: "2" }],
    });
    const queued = GrokBacktestJobService.getJob("user-1", jobId);
    const pub = GrokBacktestJobService.toPublicJob(queued);
    if (pub.decisions) throw new Error("decisions should not be public while processing");
    if (!["queued", "processing"].includes(pub.status)) {
      throw new Error(`unexpected status ${pub.status}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
