/**
 * Multi-Strategy per Coin — Integration Scenarios (TASK 4.2).
 * Scenario 1-3 dari plan, dengan engine palsu yang meniru BotEngine:
 *  - konsultasi AccountCoordinator (groupKey + direction lock),
 *  - hitung atribusi trade (buildTradeAttribution) → firedByStrategy + SL/TP.
 */
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const AccountCoordinator = require("#modules/trading/domain/AccountCoordinator.js");
const { buildTradeAttribution } = require("#modules/analytics/domain/tradeAttribution.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

// SL/TP "config" per strategi (meniru atrMultiplier/RR berbeda tiap strategi).
const STRAT_CFG = {
  ADAPTIVE_FUSION: { slMult: 1.5, rr: 2.0 },
  TREND_FOLLOWING:  { slMult: 1.2, rr: 1.92 },
  MEAN_REVERSION:  { slMult: 2.0, rr: 3.0 },
  BREAKOUT_RETEST: { slMult: 1.0, rr: 2.0 },
};

function makeEngine(strategyKey, cfg, ac) {
  const sc = STRAT_CFG[strategyKey] || { slMult: 1.5, rr: 2.0 };
  return {
    strategyKey, cfg,
    state: { running: false, openPositions: [], trades: [], lastSignal: null },
    async start() { this.state.running = true; },
    async stop() { this.state.running = false; ac && ac.release(cfg.botKey); },
    getState() { return this.state; },
    // Meniru _handleSignal: cek koordinator → reserve → catat trade + atribusi.
    fire(direction, price = 100, atr = 2) {
      const slDist = atr * sc.slMult;
      const tpDist = slDist * sc.rr;
      const sl = direction === "LONG" ? price - slDist : price + slDist;
      const tp = direction === "LONG" ? price + tpDist : price - tpDist;
      const verdict = ac.canOpen({
        botKey: cfg.botKey, symbol: cfg.symbol, requiredMargin: 5,
        groupKey: cfg.groupKey, direction,
      });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      ac.reserve(cfg.botKey, { symbol: cfg.symbol, margin: 5, groupKey: cfg.groupKey, strategyKey, direction });
      const attribution = buildTradeAttribution({ strategyKey, sl, tp, slDist, tpDist, atr });
      this.state.openPositions.push({ id: `${strategyKey}-1`, side: direction, entry: price, ...attribution });
      this.state.trades.push({ id: `${strategyKey}-1`, pnl: 0, ...attribution });
      this.state.lastSignal = direction;
      return { ok: true, attribution };
    },
  };
}

function buildCoord(userId, symbol, strategies, capital) {
  const ac = new AccountCoordinator({ userId, maxAccountUtilization: 0.8 });
  const engines = {};
  const factory = (k, cfg) => { const e = makeEngine(k, cfg, ac); engines[k] = e; return e; };
  const coord = new MultiStrategyCoordinator({
    userId, symbol, strategies, totalCapital: capital,
    engineFactory: factory, accountCoordinator: ac, dryRun: true,
  });
  return { ac, engines, coord };
}

console.log("\n🎬 Multi-Strategy Integration Scenarios (1-3)\n");

(async () => {
  // ── Scenario 1: VAULT, ETH — hanya TM fire → trade pakai SL/TP TM ─────────
  {
    const { engines, coord } = buildCoord(
      "vault1", "ETHUSDT",
      ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"], 100
    );
    await coord.start();
    t("S1: 4 engine berjalan (VAULT)", coord.engines.size === 4);

    const res = engines.TREND_FOLLOWING.fire("LONG", 100, 2);
    t("S1: TM entry berhasil", res.ok === true);
    t("S1: firedByStrategy = TREND_FOLLOWING", res.attribution.firedByStrategy === "TREND_FOLLOWING");
    // TM config: slMult 1.2 → slPrice 100-2.4=97.6 ; tpMult = 1.2*1.92=2.304 → tp 100+4.608=104.608
    t("S1: SL pakai config TM (97.6)", res.attribution.slPrice === 97.6);
    t("S1: slMultiplier = 1.2 (TM, bukan default)", res.attribution.slMultiplier === 1.2);

    const st = coord.getState();
    t("S1: hanya 1 posisi terbuka (TM)", st.openPositions.length === 1);
    t("S1: posisi ter-atribusi ke TM", st.openPositions[0].firedByStrategy === "TREND_FOLLOWING");
    await coord.stop();
  }

  // ── Scenario 2: MINT, BTC — AF LONG + TM SHORT → conflict → no entry ──────
  {
    const { engines, coord } = buildCoord(
      "mint1", "BTCUSDT",
      ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION"], 90
    );
    await coord.start();
    t("S2: 3 engine berjalan (MINT)", coord.engines.size === 3);

    const af = engines.ADAPTIVE_FUSION.fire("LONG");
    t("S2: AF LONG masuk lebih dulu", af.ok === true);
    const tm = engines.TREND_FOLLOWING.fire("SHORT");
    t("S2: TM SHORT DITOLAK (conflict direction lock)", tm.ok === false);

    // resolveConflicts batch juga menandai konflik (skip-all semantik).
    const decision = coord.resolveConflicts([
      { strategyKey: "ADAPTIVE_FUSION", direction: "LONG" },
      { strategyKey: "TREND_FOLLOWING", direction: "SHORT" },
    ]);
    t("S2: resolver menandai conflict", decision.conflict === true);
    await coord.stop();
  }

  // ── Scenario 3: FOUNDRY, SOL — 1 engine → entry normal ────────────────────
  {
    const { engines, coord } = buildCoord("foundry1", "SOLUSDT", ["ADAPTIVE_FUSION"], 50);
    await coord.start();
    t("S3: 1 engine (FOUNDRY)", coord.engines.size === 1);
    const res = engines.ADAPTIVE_FUSION.fire("LONG");
    t("S3: AF entry normal", res.ok === true);
    t("S3: firedByStrategy = ADAPTIVE_FUSION", res.attribution.firedByStrategy === "ADAPTIVE_FUSION");
    await coord.stop();
  }

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
})();
