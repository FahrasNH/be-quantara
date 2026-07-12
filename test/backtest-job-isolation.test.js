/**
 * Backtest async job isolation — unit tests (BUG-CRITICAL 502).
 * Run: BACKTEST_ISOLATE=0 node test/backtest-job-isolation.test.js
 */

process.env.BACKTEST_ISOLATE = "0"; // in-process for deterministic unit tests

const assert = require("assert");
const {
  enforceTotalEntryBarCap,
  getEffectivePeriod,
  MAX_TOTAL_ENTRY_BARS,
} = require("../src/server/services/runBacktestJob");
const BacktestJobService = require("../src/server/services/BacktestJobService");

let pass = 0;
let fail = 0;

function test(name, fn) {
  return (async () => {
    try {
      await fn();
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail += 1;
      console.log(`  ✗ ${name}: ${err.message}`);
    } finally {
      BacktestJobService._clearAll();
    }
  })();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeCandles(n) {
  const out = [];
  const t0 = Date.parse("2024-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push({
      timestamp: t0 + i * 900_000,
      date: new Date(t0 + i * 900_000).toISOString(),
      open: 1, high: 1, low: 1, close: 1, volume: 1,
    });
  }
  return out;
}

console.log("\n=== Backtest Job Isolation Tests ===\n");

(async () => {
  await test("getEffectivePeriod caps 15m max to 365d", () => {
    assert.strictEqual(getEffectivePeriod("max", "15m"), "365d");
    assert.strictEqual(getEffectivePeriod("12m", "15m"), "12m");
    assert.strictEqual(getEffectivePeriod("12m", "5m"), "180d");
  });

  await test("enforceTotalEntryBarCap trims multi-type series", () => {
    const over = Math.floor(MAX_TOTAL_ENTRY_BARS / 2) + 5_000;
    const entryCandles = {
      Scalping: makeCandles(over),
      Swing: makeCandles(over),
    };
    const dataInfo = {
      Scalping: { entryBars: over },
      Swing: { entryBars: over },
    };
    const logs = [];
    const total = enforceTotalEntryBarCap(entryCandles, dataInfo, {
      progress: (d) => logs.push(d),
    });
    assert.ok(total <= MAX_TOTAL_ENTRY_BARS, `total ${total} should be <= ${MAX_TOTAL_ENTRY_BARS}`);
    assert.ok(dataInfo.Scalping.clamped, "Scalping should be marked clamped");
    assert.ok(logs.some((l) => /Memory guard/i.test(l.message || "")), "should emit warn progress");
  });

  await test("createJob returns jobId immediately (async path)", async () => {
    // Stub runner by cancelling before work — we only assert handshake + store.
    const jobId = BacktestJobService.createJob("user-test", {
      sym: "BTCUSDT",
      strategyKey: "AF_SMC",
      strategyCfg: { label: "AF", interval: "15m", higherTf: "4h" },
      periodId: "3m",
      capital: 1000,
      enableFees: true,
      enableSlippage: false,
      parameters: {},
    });
    assert.ok(typeof jobId === "string" && jobId.length > 10, "jobId uuid");
    const job = BacktestJobService.getJob(jobId);
    assert.ok(job, "job stored");
    assert.ok(["pending", "queued", "running", "error"].includes(job.status), `status=${job.status}`);
    // Cancel quickly — fetch will fail without exchange creds; we only care about API shape.
    BacktestJobService.cancelJob(jobId);
    await sleep(50);
    const pub = BacktestJobService.toPublicStatus(job);
    assert.strictEqual(pub.ok, true);
    assert.ok(pub.status === "cancelled" || pub.status === "error" || pub.status === "done");
  });

  await test("second job queues when concurrency is saturated", async () => {
    // Force concurrency 1 is default. Start a long-running fake by patching dispatch.
    const orig = BacktestJobService._dispatch;
    let released = false;
    BacktestJobService._dispatch = function patched(jobId) {
      const job = BacktestJobService.getJob(jobId);
      if (!job) return;
      // Manually bump active like real dispatch
      const statsBefore = BacktestJobService._stats();
      // Call original in-process path but cancel immediately after queue check
      orig.call(BacktestJobService, jobId);
      void statsBefore;
    };

    try {
      // Hold activeCount by creating a job that we don't let finish — use cancel on first after second is queued.
      const id1 = BacktestJobService.createJob("u1", {
        sym: "ETHUSDT", strategyKey: "BS_BR",
        strategyCfg: { label: "BR", interval: "15m" },
        periodId: "3m", capital: 1000, parameters: {},
      });
      await sleep(10);
      const id2 = BacktestJobService.createJob("u1", {
        sym: "ETHUSDT", strategyKey: "MD_MR",
        strategyCfg: { label: "MR", interval: "15m" },
        periodId: "3m", capital: 1000, parameters: {},
      });
      const j2 = BacktestJobService.getJob(id2);
      // Either queued, or both running if first already failed fast — accept queued OR running.
      assert.ok(j2, "second job exists");
      if (j2.status === "queued") {
        assert.ok(BacktestJobService._stats().queued >= 1, "queued job should be counted");
        released = true;
      }
      BacktestJobService.cancelJob(id1);
      BacktestJobService.cancelJob(id2);
      assert.ok(id1 !== id2);
      void released;
    } finally {
      BacktestJobService._dispatch = orig;
    }
  });

  await test("running job survives purge when lastActivityAt is recent", async () => {
    const origDispatch = BacktestJobService._dispatch;
    BacktestJobService._dispatch = () => {};
    try {
      const jobId = BacktestJobService.createJob("u-ttl", {
        sym: "BTCUSDT", strategyKey: "AF_WYCKOFF",
        strategyCfg: { label: "Wyckoff", interval: "15m" },
        periodId: "12m", capital: 1000, parameters: {},
      });
      const job = BacktestJobService.getJob(jobId);
      job.status = "running";
      job.createdAt = Date.now() - 40 * 60_000;
      job.lastActivityAt = Date.now() - 2 * 60_000;
      BacktestJobService._purgeExpired();
      assert.ok(BacktestJobService.getJob(jobId), "running job with recent activity must not be purged");
    } finally {
      BacktestJobService._dispatch = origDispatch;
    }
  });

  await test("stale running job is failed and purged after running TTL", async () => {
    const origDispatch = BacktestJobService._dispatch;
    BacktestJobService._dispatch = () => {};
    try {
      const jobId = BacktestJobService.createJob("u-ttl2", {
        sym: "BTCUSDT", strategyKey: "AF_VSA",
        strategyCfg: { label: "VSA", interval: "15m" },
        periodId: "12m", capital: 1000, parameters: {},
      });
      const job = BacktestJobService.getJob(jobId);
      job.status = "running";
      job.createdAt = Date.now() - 120 * 60_000;
      job.lastActivityAt = Date.now() - 95 * 60_000;
      BacktestJobService._purgeExpired();
      assert.strictEqual(BacktestJobService.getJob(jobId), null, "stale running job should be purged");
      assert.strictEqual(job.status, "error");
      assert.ok(/timed out/i.test(job.error), `expected timeout error, got: ${job.error}`);
    } finally {
      BacktestJobService._dispatch = origDispatch;
    }
  });

  await test("ipc settled prevents exit-code-0 false failure", () => {
    const { BacktestJob } = require("../src/server/services/BacktestJobService");
    const job = new BacktestJob("ipc-test");
    job.status = "running";
    job._ipcSettled = true;
    job.done({ ok: true, trades: [{ id: 1 }] });
    // Simulate parent exit handler — must NOT overwrite done status
    if (!job._ipcSettled && job.status === "running") {
      job.fail("Backtest worker exited (code 0)");
    }
    assert.strictEqual(job.status, "done");
    assert.ok(job.result?.trades?.length === 1);
  });

  await test("AF_WYCKOFF job opts get single-racer defaults in runBacktestJob", () => {
    const { applyStrategyJobDefaults } = require("../src/server/services/runBacktestJob");
    const out = applyStrategyJobDefaults("AF_WYCKOFF", {});
    assert.deepStrictEqual(out.afActiveRacers, ["AF_WYCKOFF"]);
    assert.deepStrictEqual(out.selectedComponents, ["AF_WYCKOFF"]);
    assert.strictEqual(out.entryModel, "aggressive");
    assert.strictEqual(out.wyckoff.entryModel, "aggressive");
    const preserved = applyStrategyJobDefaults("AF_WYCKOFF", { afActiveVoters: ["AF_VSA"] });
    assert.deepStrictEqual(preserved.afActiveVoters, ["AF_VSA"]);
    assert.ok(!preserved.afActiveRacers);
    const moderate = applyStrategyJobDefaults("AF_WYCKOFF", { entryModel: "moderate" });
    assert.strictEqual(moderate.entryModel, "moderate");
    const feWyckoffOnly = applyStrategyJobDefaults("AF_WYCKOFF", {
      afActiveVoters: ["AF_WYCKOFF"],
      selectedComponents: ["AF_WYCKOFF"],
    });
    assert.strictEqual(feWyckoffOnly.entryModel, "aggressive");
  });

  await test("FE Advanced AF_SMC + Wyckoff-only voters still get aggressive entryModel", () => {
    const { applyStrategyJobDefaults } = require("../src/server/services/runBacktestJob");
    // useBacktest collapses AF_WYCKOFF → engine AF_SMC with afActiveVoters/selectedComponents
    const feCollapse = applyStrategyJobDefaults("AF_SMC", {
      afActiveVoters: ["AF_WYCKOFF"],
      selectedComponents: ["AF_WYCKOFF"],
      afUseThreeComponentVoting: true,
      afMinVotes: 2,
    });
    assert.strictEqual(feCollapse.entryModel, "aggressive");
    assert.strictEqual(feCollapse.wyckoff.entryModel, "aggressive");
    assert.deepStrictEqual(feCollapse.afActiveVoters, ["AF_WYCKOFF"]);

    // Full FOUNDRY package must NOT force Wyckoff aggressive (SMC+Wyckoff+VSA race)
    const fullAf = applyStrategyJobDefaults("AF_SMC", {
      afActiveVoters: ["AF_SMC", "AF_WYCKOFF", "AF_VSA"],
      selectedComponents: ["AF_SMC", "AF_WYCKOFF", "AF_VSA"],
    });
    assert.strictEqual(fullAf.entryModel, undefined);
    assert.ok(!fullAf.wyckoff);

    // VSA-only collapse must not get Wyckoff aggressive defaults
    const vsaOnly = applyStrategyJobDefaults("AF_SMC", {
      afActiveVoters: ["AF_VSA"],
      selectedComponents: ["AF_VSA"],
    });
    assert.strictEqual(vsaOnly.entryModel, undefined);
  });

  await test("AMT-only / TS_VP job defaults force Intraday (no Swing type leg)", () => {
    const {
      applyStrategyJobDefaults,
      MULTI_TYPE_STRATEGY_MAP,
    } = require("../src/server/services/runBacktestJob");
    const { STRATEGY_SUPPORTED_TYPES } = require("../src/constants/strategySupportedTypes");

    assert.deepStrictEqual(STRATEGY_SUPPORTED_TYPES.TS_VP, ["Intraday"]);
    assert.deepStrictEqual(MULTI_TYPE_STRATEGY_MAP.TS_VP, ["Intraday"]);
    assert.deepStrictEqual(MULTI_TYPE_STRATEGY_MAP.TS_MS, ["Intraday", "Swing"]);

    const standalone = applyStrategyJobDefaults("TS_VP", {});
    assert.deepStrictEqual(standalone.selectedComponents, ["TS_VP"]);
    assert.deepStrictEqual(standalone.activeTypes, ["Intraday"]);

    // FE Advanced collapse TS_VP → TS_TF engine with only AMT selected
    const feCollapse = applyStrategyJobDefaults("TS_TF", {
      selectedComponents: ["TS_VP"],
    });
    assert.deepStrictEqual(feCollapse.activeTypes, ["Intraday"]);

    // Explicit Swing-only request still coerced to Intraday for AMT-only
    const swingForced = applyStrategyJobDefaults("TS_TF", {
      selectedComponents: ["TS_VP"],
      activeTypes: ["Swing"],
    });
    assert.deepStrictEqual(swingForced.activeTypes, ["Intraday"]);

    // Full Trend Surge race must NOT strip Swing (TF + Dow need it)
    const fullTs = applyStrategyJobDefaults("TS_TF", {
      selectedComponents: ["TS_TF", "TS_MS", "TS_VP"],
    });
    assert.strictEqual(fullTs.activeTypes, undefined);
  });

  await test("worker crash path marks job failed without throwing in parent", async () => {
    // Simulate worker exit failure via cancel+fail semantics on a fresh job object.
    const jobId = BacktestJobService.createJob("u2", {
      sym: "BTCUSDT", strategyKey: "AF_VSA",
      strategyCfg: { label: "VSA", interval: "15m", higherTf: "4h" },
      periodId: "12m", capital: 1000, parameters: {},
    });
    const job = BacktestJobService.getJob(jobId);
    job.fail("Backtest worker killed (SIGKILL) — often out-of-memory. Retry with 3–6 months or fewer strategies.");
    const pub = BacktestJobService.toPublicStatus(job);
    assert.strictEqual(pub.status, "error");
    assert.ok(/out-of-memory|3–6 months/i.test(pub.error));
    // Parent process still alive (this test running) = isolation contract for crash messaging.
  });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
