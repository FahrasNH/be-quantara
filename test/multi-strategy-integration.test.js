/**
 * Multi-Strategy per Coin — integration test (TASK 2.2 wiring).
 *
 * Memverifikasi kontrak antara MultiStrategyCoordinator ↔ AccountCoordinator ↔
 * protokol BotEngine (canOpen/reserve dengan groupKey + direction), tanpa exchange/DB.
 * Engine palsu di sini MENIRU persis interaksi BotEngine._handleSignal dengan
 * koordinator margin, sehingga test ini menangkap regresi pada wiring nyata.
 *
 * Mencakup: AC-05 (direction lock), AC-06 (group margin), spawn per-strategi,
 * lifecycle start/stop, dan Scenario 1-3 dari TASK 4.2 (versi unit).
 */
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const AccountCoordinator = require("../src/domain/AccountCoordinator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

// Engine yang meniru BotEngine: saat tryEnter(direction) ia konsultasi koordinator
// (groupKey + direction) lalu reserve — persis seperti _handleSignal di engine asli.
function makeReservingEngineFactory(ac) {
  const engines = {};
  const factory = (strategyKey, cfg) => {
    const engine = {
      strategyKey, cfg,
      state: { running: false, openPositions: [], trades: [], lastSignal: null },
      async start() { this.state.running = true; },
      async stop() { this.state.running = false; ac.release(cfg.botKey); },
      getState() { return this.state; },
      tryEnter(direction) {
        const verdict = ac.canOpen({
          botKey: cfg.botKey, symbol: cfg.symbol, requiredMargin: 5,
          groupKey: cfg.groupKey, direction,
        });
        if (!verdict.ok) return verdict;
        ac.reserve(cfg.botKey, { symbol: cfg.symbol, margin: 5, groupKey: cfg.groupKey, strategyKey, direction });
        this.state.openPositions.push({ id: `${strategyKey}-1`, side: direction, entry: 100 });
        this.state.lastSignal = direction;
        return { ok: true };
      },
    };
    engines[strategyKey] = engine;
    return engine;
  };
  return { factory, engines };
}

console.log("\n🔗 Multi-Strategy Integration Tests\n");

// ── Scenario: MINT (AF+TM+MR) — start, group margin, direction lock ─────────
(async () => {
  {
    const ac = new AccountCoordinator({ userId: "u1", maxAccountUtilization: 0.8 });
    const { factory, engines } = makeReservingEngineFactory(ac);

    const coord = new MultiStrategyCoordinator({
      userId: "u1", symbol: "BTCUSDT",
      strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION"],
      totalCapital: 90, engineFactory: factory, accountCoordinator: ac, dryRun: true,
    });

    await coord.start();
    t("spawn 3 engine", Object.keys(engines).length === 3);
    t("AC-06: group margin reserved saat start (= 90)", ac.committedMargin() === 90);

    // AF LONG → boleh
    t("AF LONG → diizinkan", engines.ADAPTIVE_FUSION.tryEnter("LONG").ok === true);
    // TM LONG (searah) → boleh (diversified)
    t("TM LONG (searah) → diizinkan", engines.TREND_MOMENTUM.tryEnter("LONG").ok === true);
    // MR SHORT (berlawanan) → DITOLAK (AC-05)
    const mr = engines.MEAN_REVERSION.tryEnter("SHORT");
    t("AC-05: MR SHORT ditolak (grup sudah LONG)", mr.ok === false);

    // State teragregasi: 2 posisi terbuka (AF + TM), MR tidak ada
    const st = coord.getState();
    t("agregasi openPositions = 2 (AF+TM)", st.openPositions.length === 2);
    t("openPositions diberi tag strategyKey",
      st.openPositions.every((p) => p.strategyKey));

    await coord.stop();
    t("stop → semua engine berhenti", Object.values(engines).every((e) => !e.state.running));
    t("stop → releaseGroup → committed 0", ac.committedMargin() === 0);
  }

  // ── Scenario: FOUNDRY (AF only) — 1 engine, perilaku setara single-bot ─────
  {
    const ac = new AccountCoordinator({ userId: "u2", maxAccountUtilization: 0.8 });
    const { factory, engines } = makeReservingEngineFactory(ac);
    const coord = new MultiStrategyCoordinator({
      userId: "u2", symbol: "SOLUSDT",
      strategies: ["ADAPTIVE_FUSION"], totalCapital: 50, engineFactory: factory,
      accountCoordinator: ac, dryRun: true,
    });
    await coord.start();
    t("FOUNDRY: 1 engine spawned", Object.keys(engines).length === 1);
    t("AF LONG → diizinkan", engines.ADAPTIVE_FUSION.tryEnter("LONG").ok === true);
    await coord.stop();
    t("FOUNDRY stop bersih", ac.committedMargin() === 0);
  }

  // ── Scenario: semua SHORT → semua boleh (entry terdiversifikasi) ──────────
  {
    const ac = new AccountCoordinator({ userId: "u3", maxAccountUtilization: 0.8 });
    const { factory, engines } = makeReservingEngineFactory(ac);
    const coord = new MultiStrategyCoordinator({
      userId: "u3", symbol: "ETHUSDT",
      strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM"], totalCapital: 40,
      engineFactory: factory, accountCoordinator: ac, dryRun: true,
    });
    await coord.start();
    t("AF SHORT → boleh", engines.ADAPTIVE_FUSION.tryEnter("SHORT").ok === true);
    t("TM SHORT → boleh (searah)", engines.TREND_MOMENTUM.tryEnter("SHORT").ok === true);
    await coord.stop();
  }

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
})();
