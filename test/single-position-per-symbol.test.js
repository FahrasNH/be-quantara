/**
 * Regression: CRITICAL GRASS/USDT bug — 2 open SHORT on same symbol.
 * Invariant: race-to-confirm → max 1 open position per symbol across strategies.
 */
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const AccountCoordinator = require("#modules/trading/domain/AccountCoordinator.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

function makeReservingEngineFactory(ac) {
  const engines = {};
  const factory = (strategyKey, cfg) => {
    const engine = {
      strategyKey, cfg,
      state: { running: false, openPositions: [], trades: [], lastSignal: null },
      async start() { this.state.running = true; },
      async stop() { this.state.running = false; ac.release(cfg.botKey); },
      getState() { return this.state; },
      async tryEnter(direction) {
        const gate = await this.cfg.groupCoordinator?.canEnter?.(strategyKey, direction);
        if (gate && !gate.allowed) return { ok: false, reason: gate.reason, via: "canEnter" };
        const verdict = ac.canOpen({
          botKey: cfg.botKey, symbol: cfg.symbol, requiredMargin: 5,
          groupKey: cfg.groupKey, direction,
        });
        if (!verdict.ok) return { ok: false, reason: verdict.reason, via: "canOpen" };
        ac.reserve(cfg.botKey, {
          symbol: cfg.symbol, margin: 5, groupKey: cfg.groupKey, strategyKey, direction,
        });
        this.state.openPositions.push({ id: `${strategyKey}-1`, side: direction, entry: 0.4 });
        this.state.lastSignal = direction;
        return { ok: true };
      },
    };
    engines[strategyKey] = engine;
    return engine;
  };
  return { factory, engines };
}

console.log("\n🔒 Single-Position-Per-Symbol Regression (GRASS/USDT)\n");

(async () => {
  const strategies = ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];
  const ac = new AccountCoordinator({ userId: "grass", maxAccountUtilization: 0.8 });
  ac.setAccountEquity(1000);
  const { factory, engines } = makeReservingEngineFactory(ac);
  const coord = new MultiStrategyCoordinator({
    userId: "grass", symbol: "GRASSUSDT",
    strategies, totalCapital: 100,
    engineFactory: factory, accountCoordinator: ac, dryRun: true,
    maxPositionsPerCoin: 1,
  });
  await coord.start();

  t("default maxPositionsPerCoin = 1", coord.maxPositionsPerCoin === 1);
  t("4 engines spawned (VAULT-like)", Object.keys(engines).length === 4);

  // Simulate GRASS: first strategy confirms SHORT
  const first = await engines.ADAPTIVE_FUSION.tryEnter("SHORT");
  t("first SHORT entry allowed", first.ok === true);

  // Other 3 strategies confirm SHORT on same tick → all blocked
  const results = [];
  for (const key of ["TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"]) {
    results.push(await engines[key].tryEnter("SHORT"));
  }
  t("2nd strategy SHORT blocked", results[0].ok === false);
  t("3rd strategy SHORT blocked", results[1].ok === false);
  t("4th strategy SHORT blocked", results[2].ok === false);

  const st = coord.getState();
  t("exactly 1 open position on GRASSUSDT", st.openPositions.length === 1);
  t("open side is SHORT", st.openPositions[0].side === "SHORT");

  // Opposite direction also blocked
  const longAttempt = await engines.TREND_FOLLOWING.tryEnter("LONG");
  t("LONG blocked while SHORT open", longAttempt.ok === false);

  // After flat, another strategy may enter
  engines.ADAPTIVE_FUSION.state.openPositions = [];
  ac.release(`grass:GRASSUSDT#ADAPTIVE_FUSION`);
  // Re-arm undirected slot so margin footprint remains (mirrors reserveGroup leftover)
  ac.reserve(`grass:GRASSUSDT#ADAPTIVE_FUSION`, {
    symbol: "GRASSUSDT", margin: 25, groupKey: "grass:GRASSUSDT", strategyKey: "ADAPTIVE_FUSION",
  });
  const afterFlat = await engines.TREND_FOLLOWING.tryEnter("SHORT");
  t("after flat → TM SHORT allowed again", afterFlat.ok === true);

  await coord.stop();

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
