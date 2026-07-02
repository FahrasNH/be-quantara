/**
 * Multi-Strategy per Coin — ACCEPTANCE test (TASK 4.1).
 * Pemetaan eksplisit TC-001..TC-008 dari plan ke implementasi, tanpa exchange/DB.
 */
const { resolveConflicts } = require("../src/domain/SignalConflictResolver");
const { buildTradeAttribution } = require("../src/domain/tradeAttribution");
const { filterStrategiesByMode, isStrategyLiveReady } = require("../src/services/entitlement");
const { strategyGuard, DRY_RUN_ONLY_STRATEGIES } = require("../src/middleware/strategyGuard");
const AccountCoordinator = require("../src/domain/AccountCoordinator");
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

// Mock express req/res untuk menguji middleware strategyGuard (TC-006).
function runGuard(body) {
  let statusCode = 200, payload = null, nexted = false;
  const req = { body, params: {} };
  const res = {
    status(c) { statusCode = c; return this; },
    json(p) { payload = p; return this; },
  };
  strategyGuard(req, res, () => { nexted = true; });
  return { statusCode, payload, nexted };
}

function makeFakeEngine(strategyKey, cfg, ac) {
  return {
    strategyKey, cfg,
    state: { running: false, openPositions: [], trades: [], lastSignal: null },
    async start() { this.state.running = true; },
    async stop() { this.state.running = false; ac && ac.release(cfg.botKey); },
    getState() { return this.state; },
  };
}

console.log("\n📋 Multi-Strategy Acceptance Tests (TC-001..TC-008)\n");

// ── TC-001: Direction conflict LONG+SHORT → no entry ────────────────────────
{
  const r = resolveConflicts([
    { strategyKey: "AF", direction: "LONG" },
    { strategyKey: "TM", direction: "SHORT" },
  ]);
  t("TC-001: LONG+SHORT → execute 0 (no entry)", r.execute.length === 0 && r.conflict === true);
}

// ── TC-002: All LONG → 4 entries ────────────────────────────────────────────
{
  const sigs = ["AF", "TM", "MR", "BR"].map((k) => ({ strategyKey: k, direction: "LONG" }));
  const r = resolveConflicts(sigs);
  t("TC-002: semua LONG → 4 entry, no conflict", r.execute.length === 4 && !r.conflict);
}

// ── TC-003: Capital split 4×25% = 100% ──────────────────────────────────────
{
  const ac = new AccountCoordinator({ userId: "tc3", maxAccountUtilization: 0.8 });
  ac.setAccountEquity(100);
  const g = ac.reserveGroup("tc3", "ETHUSDT", ["AF", "TM", "MR", "BR"], 80);
  t("TC-003: 4 strategi → margin/strategi = 25% (20 dari 80)", g.perStrategyMargin === 20);
  t("TC-003: total grup = 100% budget (80)", ac.getGroupUtilization("tc3", "ETHUSDT").reserved === 80);
}

// ── TC-004: firedByStrategy terisi setiap trade ─────────────────────────────
{
  const a = buildTradeAttribution({ strategyKey: "TREND_FOLLOWING", sl: 97, tp: 106, slDist: 3, tpDist: 6, atr: 2 });
  t("TC-004: firedByStrategy terisi", a.firedByStrategy === "TREND_FOLLOWING");
}

// ── TC-005: SL/TP match config strategi yang fire (bukan default) ───────────
{
  // BR override: slDist 2.5, tpDist 7.5 (atr 2) → multiplier 1.25 / 3.75 (bukan default 1.5/3)
  const a = buildTradeAttribution({ strategyKey: "BREAKOUT_RETEST", sl: 97.5, tp: 107.5, slDist: 2.5, tpDist: 7.5, atr: 2 });
  t("TC-005: SL/TP multiplier ikut config strategi (1.25/3.75)", a.slMultiplier === 1.25 && a.tpMultiplier === 3.75);
}

// ── TC-006: BR tidak bisa live (strategyGuard + entitlement) ────────────────
{
  t("TC-006: BR ada di DRY_RUN_ONLY_STRATEGIES", DRY_RUN_ONLY_STRATEGIES.has("BREAKOUT_RETEST"));
  t("TC-006: isStrategyLiveReady(BR) = false", isStrategyLiveReady("BREAKOUT_RETEST") === false);

  const live = runGuard({ strategyKey: "BREAKOUT_RETEST", dryRun: false });
  t("TC-006: strategyGuard blokir BR live (403)", live.statusCode === 403 && !live.nexted);

  const dry = runGuard({ strategyKey: "BREAKOUT_RETEST", dryRun: true });
  t("TC-006: strategyGuard izinkan BR dry-run", dry.nexted === true);

  const liveSet = filterStrategiesByMode(["ADAPTIVE_FUSION", "BREAKOUT_RETEST"], "live");
  t("TC-006: filter live mode exclude BR", !liveSet.includes("BREAKOUT_RETEST"));
}

// ── TC-007: Tier downgrade → koordinator stop strategi tak diizinkan ────────
(async () => {
  {
    const ac = new AccountCoordinator({ userId: "tc7" });
    const engines = {};
    const factory = (k, cfg) => { const e = makeFakeEngine(k, cfg, ac); engines[k] = e; return e; };
    const coord = new MultiStrategyCoordinator({
      userId: "tc7", symbol: "BTCUSDT",
      strategies: ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION"],
      totalCapital: 90, engineFactory: factory, accountCoordinator: ac, dryRun: true,
    });
    await coord.start();
    t("TC-007: awal 3 engine (MINT)", coord.engines.size === 3);

    // Simulasi downgrade ke FORGE (AF+TM) → MR harus dihentikan.
    const stopped = await coord.reconcileStrategies(["ADAPTIVE_FUSION", "TREND_FOLLOWING"]);
    t("TC-007: reconcile menghentikan MEAN_REVERSION", stopped.includes("MEAN_REVERSION"));
    t("TC-007: tersisa 2 engine setelah downgrade", coord.engines.size === 2);
    t("TC-007: engine MR benar-benar stop", engines.MEAN_REVERSION.state.running === false);
    t("TC-007: strategyGroup ter-update", coord.strategies.length === 2 && !coord.strategies.includes("MEAN_REVERSION"));

    await coord.stop();
  }

  // ── TC-008: reserveGroup tidak melebihi maxUtilization ────────────────────
  {
    const ac = new AccountCoordinator({ userId: "tc8", maxAccountUtilization: 0.8 });
    ac.setAccountEquity(100); // budget 80
    ac.reserveGroup("tc8", "BTCUSDT", ["AF", "TM", "MR", "BR"], 80); // pas budget
    const extra = ac.canOpen({ botKey: "tc8:SOLUSDT#AF", symbol: "SOLUSDT", requiredMargin: 5, groupKey: "tc8:SOLUSDT" });
    t("TC-008: grup penuh budget → koin lain DITOLAK (anti over-allocate)", !extra.ok);
  }

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
})();
