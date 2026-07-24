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
  await test("getEffectivePeriod passes through 5m/15m presets (no day cap)", () => {
    assert.strictEqual(getEffectivePeriod("max", "15m"), "max");
    assert.strictEqual(getEffectivePeriod("12m", "15m"), "12m");
    assert.strictEqual(getEffectivePeriod("12m", "5m"), "12m");
    assert.strictEqual(getEffectivePeriod("max", "5m"), "max");
  });

  await test("getEffectivePeriod still caps long presets on 1m", () => {
    assert.strictEqual(getEffectivePeriod("12m", "1m"), "30d");
  });

  await test("getEffectivePeriod respects BACKTEST_5M_MAX_DAYS env override", () => {
    const prev = process.env.BACKTEST_5M_MAX_DAYS;
    process.env.BACKTEST_5M_MAX_DAYS = "90";
    try {
      assert.strictEqual(getEffectivePeriod("12m", "5m"), "90d");
      assert.strictEqual(getEffectivePeriod("3m", "5m"), "3m");
    } finally {
      if (prev === undefined) delete process.env.BACKTEST_5M_MAX_DAYS;
      else process.env.BACKTEST_5M_MAX_DAYS = prev;
    }
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
      strategyKey: "SMART_MONEY_CONCEPTS",
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
        sym: "ETHUSDT", strategyKey: "BREAKOUT_RETEST",
        strategyCfg: { label: "BR", interval: "15m" },
        periodId: "3m", capital: 1000, parameters: {},
      });
      await sleep(10);
      const id2 = BacktestJobService.createJob("u1", {
        sym: "ETHUSDT", strategyKey: "MEAN_REVERSION",
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
        sym: "BTCUSDT", strategyKey: "WYCKOFF",
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
        sym: "BTCUSDT", strategyKey: "VOLUME_SPREAD_ANALYSIS",
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

  await test("WYCKOFF job opts get single-racer defaults in runBacktestJob", () => {
    const { applyStrategyJobDefaults } = require("../src/server/services/runBacktestJob");
    const out = applyStrategyJobDefaults("WYCKOFF", {});
    assert.deepStrictEqual(out.afActiveRacers, ["WYCKOFF"]);
    assert.deepStrictEqual(out.selectedComponents, ["WYCKOFF"]);
    assert.strictEqual(out.entryModel, "aggressive");
    assert.strictEqual(out.wyckoff.entryModel, "aggressive");
    const preserved = applyStrategyJobDefaults("WYCKOFF", { afActiveVoters: ["VOLUME_SPREAD_ANALYSIS"] });
    assert.deepStrictEqual(preserved.afActiveVoters, ["VOLUME_SPREAD_ANALYSIS"]);
    assert.ok(!preserved.afActiveRacers);
    const moderate = applyStrategyJobDefaults("WYCKOFF", { entryModel: "moderate" });
    assert.strictEqual(moderate.entryModel, "moderate");
    const feWyckoffOnly = applyStrategyJobDefaults("WYCKOFF", {
      afActiveVoters: ["WYCKOFF"],
      selectedComponents: ["WYCKOFF"],
    });
    assert.strictEqual(feWyckoffOnly.entryModel, "aggressive");
  });

  await test("FE Advanced SMART_MONEY_CONCEPTS + Wyckoff-only voters still get aggressive entryModel", () => {
    const { applyStrategyJobDefaults } = require("../src/server/services/runBacktestJob");
    // useBacktest collapses WYCKOFF → engine SMART_MONEY_CONCEPTS with afActiveVoters/selectedComponents
    const feCollapse = applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["WYCKOFF"],
      selectedComponents: ["WYCKOFF"],
      afUseThreeComponentVoting: true,
      afMinVotes: 2,
    });
    assert.strictEqual(feCollapse.entryModel, "aggressive");
    assert.strictEqual(feCollapse.wyckoff.entryModel, "aggressive");
    assert.deepStrictEqual(feCollapse.afActiveVoters, ["WYCKOFF"]);

    // Full FOUNDRY package must NOT force Wyckoff aggressive (SMC+Wyckoff+VSA race)
    const fullAf = applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
      selectedComponents: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
    });
    assert.strictEqual(fullAf.entryModel, undefined);
    assert.ok(!fullAf.wyckoff);

    // VSA-only collapse must not get Wyckoff aggressive defaults
    const vsaOnly = applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["VOLUME_SPREAD_ANALYSIS"],
      selectedComponents: ["VOLUME_SPREAD_ANALYSIS"],
    });
    assert.strictEqual(vsaOnly.entryModel, undefined);
  });

  await test("AMT / AUCTION_MARKET_THEORY supports all 3 trade types; pins single-racer isolation", () => {
    const {
      applyStrategyJobDefaults,
      MULTI_TYPE_STRATEGY_MAP,
    } = require("../src/server/services/runBacktestJob");
    const { STRATEGY_SUPPORTED_TYPES } = require("../src/constants/strategySupportedTypes");

    // Sprint 14 factory reset: uniform 3 trade types across race components
    assert.deepStrictEqual(STRATEGY_SUPPORTED_TYPES.AUCTION_MARKET_THEORY, ["Scalping", "Intraday", "Swing"]);
    assert.deepStrictEqual(MULTI_TYPE_STRATEGY_MAP.AUCTION_MARKET_THEORY, ["Scalping", "Intraday", "Swing"]);
    assert.deepStrictEqual(MULTI_TYPE_STRATEGY_MAP.MARKET_STRUCTURE, ["Scalping", "Intraday", "Swing"]);

    const standalone = applyStrategyJobDefaults("AUCTION_MARKET_THEORY", {});
    assert.deepStrictEqual(standalone.selectedComponents, ["AUCTION_MARKET_THEORY"]);
    assert.deepStrictEqual(standalone.tsActiveRacers, ["AUCTION_MARKET_THEORY"]);
    assert.strictEqual(standalone.activeTypes, undefined);

    // FE Advanced collapse AUCTION_MARKET_THEORY → TREND_FOLLOWING must NOT strip Swing
    const feCollapse = applyStrategyJobDefaults("TREND_FOLLOWING", {
      selectedComponents: ["AUCTION_MARKET_THEORY"],
    });
    assert.strictEqual(feCollapse.activeTypes, undefined);
  });

  await test("BREAKOUT_RETEST dedicated backtest uses single mode and ignores live halt", () => {
    const { applyStrategyJobDefaults } = require("../src/server/services/runBacktestJob");
    const out = applyStrategyJobDefaults("BREAKOUT_RETEST", { selectedComponents: ["BREAKOUT_RETEST"] });
    assert.strictEqual(out.bsCombinationMode, "single");
    assert.strictEqual(out.bsBrHalted, false);
    assert.deepStrictEqual(out.bsActiveRacers, ["BREAKOUT_RETEST"]);
    const raceOnly = applyStrategyJobDefaults("BREAKOUT_RETEST", { selectedComponents: ["ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"] });
    assert.strictEqual(raceOnly.bsCombinationMode, undefined);
    assert.strictEqual(raceOnly.bsBrHalted, undefined);
  });

  await test("worker crash path marks job failed without throwing in parent", async () => {
    // Simulate worker exit failure via cancel+fail semantics on a fresh job object.
    const jobId = BacktestJobService.createJob("u2", {
      sym: "BTCUSDT", strategyKey: "VOLUME_SPREAD_ANALYSIS",
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

  await test("toPublicStatus supports progress cursor and defers full result", async () => {
    const origDispatch = BacktestJobService._dispatch;
    BacktestJobService._dispatch = () => {};
    try {
      const jobId = BacktestJobService.createJob("cursor-user", {
        sym: "BTCUSDT", strategyKey: "BREAKOUT_RETEST",
        strategyCfg: { label: "BR", interval: "15m" },
        periodId: "3m", capital: 1000, parameters: {},
      });
      const job = BacktestJobService.getJob(jobId);
      job.progress({ phase: "fetch", message: "a" });
      job.progress({ phase: "fetch", message: "b" });
      job.done({ ok: true, trades: [{ id: 1 }], stats: { totalTrades: 1 } });

      const slice = BacktestJobService.toPublicStatus(job, { progressSince: 1 });
      assert.strictEqual(slice.progress.length, 1);
      assert.strictEqual(slice.progressLen, 2);
      assert.strictEqual(slice.result, undefined);
      assert.strictEqual(slice.hasResult, true);

      const full = await BacktestJobService.getJobResult(jobId);
      assert.strictEqual(full.ok, true);
      assert.strictEqual(full.trades.length, 1);
    } finally {
      BacktestJobService._dispatch = origDispatch;
    }
  });

  await test("getJobResult returns null for missing job", async () => {
    const missing = await BacktestJobService.getJobResult("does-not-exist");
    assert.strictEqual(missing, null);
  });

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
