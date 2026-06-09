/**
 * MultiStrategyCoordinator unit tests (Multi-Strategy per Coin — TASK 1.2).
 * Standalone runner: exit code != 0 bila ada yang gagal.
 *
 * Memakai engine PALSU (dependency injection) agar koordinator teruji terisolasi
 * tanpa exchange / DB. Mencakup AC-02, AC-03, AC-05, AC-06, TC-002, TC-003.
 */
const MultiStrategyCoordinator = require("../src/application/MultiStrategyCoordinator");
const AccountCoordinator = require("../src/domain/AccountCoordinator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

// ── Engine palsu: merekam start/stop, mengembalikan signal & state terkontrol ──
function makeFakeEngine(strategyKey, cfg) {
  return {
    strategyKey,
    cfg,
    started: false,
    stopped: false,
    pending: null,             // { direction, slPrice, ... }
    lastDecision: null,        // hasil applyConflictDecision
    state: { running: false, openPositions: [], trades: [], lastSignal: null, capital: cfg.capital },
    async start() { this.started = true; this.state.running = true; },
    async stop() { this.stopped = true; this.state.running = false; },
    getState() { return this.state; },
    getPendingSignal() { return this.pending; },
    applyConflictDecision(allowed) { this.lastDecision = allowed; },
  };
}

console.log("\n🎛️  MultiStrategyCoordinator Unit Tests\n");

// ── Spawn + capital split (AC-06 / TC-003) ──────────────────────────────────
{
  const created = [];
  const factory = (key, cfg) => { const e = makeFakeEngine(key, cfg); created.push(e); return e; };
  const ac = new AccountCoordinator({ userId: "u1", maxAccountUtilization: 0.8 });
  ac.setAccountEquity(1000);

  const c = new MultiStrategyCoordinator({
    userId: "u1", symbol: "ETHUSDT",
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION", "BREAKOUT_RETEST"],
    totalCapital: 1000, engineFactory: factory, accountCoordinator: ac,
  });

  t("capitalPerStrategy = 250 (1000/4)", c.capitalPerStrategy === 250);

  return c.start().then(() => {
    t("AC-02/AC-03: spawn 4 engine (1/strategi)", created.length === 4);
    t("semua engine di-start", created.every((e) => e.started));
    t("tiap engine dapat capital 250", created.every((e) => e.cfg.capital === 250));
    t("tiap engine punya botKey unik per strategi",
      new Set(created.map((e) => e.cfg.botKey)).size === 4);
    t("AC-06: reserveGroup → grup committed 1000",
      ac.committedMargin() === 1000);
    t("coordinator running", c.getState().running === true);

    return c.stop();
  }).then(() => {
    t("stop → semua engine stopped", created.every((e) => e.stopped));
    t("stop → releaseGroup melepas margin grup", ac.committedMargin() === 0);
    t("coordinator not running setelah stop", c.getState().running === false);
    runConflictTests();
  });
}

function runConflictTests() {
  // ── Conflict gating (AC-05 / TC-001) — LONG + SHORT → no entry ─────────────
  {
    const engines = {};
    const factory = (key, cfg) => { const e = makeFakeEngine(key, cfg); engines[key] = e; return e; };
    const c = new MultiStrategyCoordinator({
      userId: "u2", symbol: "BTCUSDT",
      strategies: ["AF", "TM"], totalCapital: 100, engineFactory: factory,
    });

    c.start().then(() => {
      engines.AF.pending = { direction: "LONG" };
      engines.TM.pending = { direction: "SHORT" };
      const decision = c.evaluate();

      t("AC-05: LONG+SHORT → execute 0", decision.execute.length === 0);
      t("AC-05: conflict flagged", decision.conflict === true);
      t("AC-05: kedua engine diberi tahu TIDAK boleh entry",
        engines.AF.lastDecision === false && engines.TM.lastDecision === false);
      t("getState().signals merefleksikan keputusan terakhir",
        c.getState().signals && c.getState().signals.conflict === true);

      runAllLongTest();
    });
  }
}

function runAllLongTest() {
  // ── TC-002: semua LONG → semua engine boleh entry ─────────────────────────
  {
    const engines = {};
    const factory = (key, cfg) => { const e = makeFakeEngine(key, cfg); engines[key] = e; return e; };
    const c = new MultiStrategyCoordinator({
      userId: "u3", symbol: "SOLUSDT",
      strategies: ["AF", "TM", "MR"], totalCapital: 90, engineFactory: factory,
    });

    c.start().then(() => {
      engines.AF.pending = { direction: "LONG", slPrice: 10, tpPrice: 12 };
      engines.TM.pending = { direction: "LONG" };
      engines.MR.pending = { direction: "LONG" };
      const decision = c.evaluate();

      t("TC-002: semua LONG → execute 3", decision.execute.length === 3);
      t("TC-002: tidak ada konflik", decision.conflict === false);
      t("TC-002: semua engine diberi izin entry",
        Object.values(engines).every((e) => e.lastDecision === true));
      t("collectSignals meneruskan slPrice/tpPrice",
        c.collectSignals().find((s) => s.strategyKey === "AF").slPrice === 10);

      runStateAggTest();
    });
  }
}

function runStateAggTest() {
  // ── State aggregation lintas-engine ───────────────────────────────────────
  {
    const engines = {};
    const factory = (key, cfg) => { const e = makeFakeEngine(key, cfg); engines[key] = e; return e; };
    const c = new MultiStrategyCoordinator({
      userId: "u4", symbol: "ETHUSDT",
      strategies: ["AF", "TM"], totalCapital: 200, engineFactory: factory,
    });

    c.start().then(() => {
      engines.AF.state.openPositions = [{ id: "p1", side: "LONG", entry: 100 }];
      engines.AF.state.trades = [{ id: "t1", pnl: 25 }];
      engines.TM.state.trades = [{ id: "t2", pnl: -10 }];

      const st = c.getState();
      t("agregasi openPositions lintas-engine (1)", st.openPositions.length === 1);
      t("openPosition diberi tag strategyKey", st.openPositions[0].strategyKey === "AF");
      t("agregasi closedTrades lintas-engine (2)", st.closedTrades === 2);
      t("agregasi totalPnL = 15 (25-10)", st.totalPnL === 15);
      t("engines summary berisi 2 entri", st.engines.length === 2);
      t("multiStrategy flag = true", st.multiStrategy === true);

      runCanEnterTests();
    });
  }
}

function runCanEnterTests() {
  // ── canEnter gate: cap per-koin + proteksi hedge (anti penumpukan) ──────────
  {
    const engines = {};
    const factory = (key, cfg) => { const e = makeFakeEngine(key, cfg); engines[key] = e; return e; };
    const c = new MultiStrategyCoordinator({
      userId: "u5", symbol: "BNBUSDT",
      strategies: ["A", "B", "C", "D"], totalCapital: 1000, engineFactory: factory,
      maxPositionsPerCoin: 2,
    });

    c.start().then(async () => {
      t("maxPositionsPerCoin = 2 tersimpan", c.maxPositionsPerCoin === 2);

      // Tanpa DB injected → fallback ke state engine live (async)
      // Belum ada posisi → boleh entry
      t("gate: kosong → SHORT diizinkan", (await c.canEnter("A", "SHORT")).allowed === true);

      // 1 SHORT terbuka → SHORT ke-2 masih boleh (cap 2)
      engines.A.state.openPositions = [{ side: "SHORT" }];
      t("gate: 1 SHORT → SHORT ke-2 diizinkan", (await c.canEnter("B", "SHORT")).allowed === true);

      // Hedge: ada SHORT → LONG ditolak
      const hedge = await c.canEnter("B", "LONG");
      t("gate: hedge LONG ditolak saat ada SHORT", hedge.allowed === false);
      t("gate: alasan hedge benar", /Hedge/.test(hedge.reason));

      // 2 SHORT terbuka → SHORT ke-3 ditolak (cap tercapai)
      engines.B.state.openPositions = [{ side: "SHORT" }];
      const capped = await c.canEnter("C", "SHORT");
      t("gate: cap 2 tercapai → SHORT ke-3 ditolak", capped.allowed === false);
      t("gate: alasan cap benar", /Cap per-koin/.test(capped.reason));

      // DB-authoritative: DB injected → cap hitung dari DB (orphan ikut terhitung)
      const fakeDb = { getOpenPositionsForGate: async () => [{ side: "SHORT" }, { side: "SHORT" }] };
      const c2 = new MultiStrategyCoordinator({
        userId: "u6", symbol: "ETHUSDT", strategies: ["A"], totalCapital: 100,
        engineFactory: (k, cfg) => makeFakeEngine(k, cfg), maxPositionsPerCoin: 2, db: fakeDb,
      });
      await c2.start();
      const dbCap = await c2.canEnter("A", "SHORT");
      t("gate DB: 2 orphan di DB → entry ke-3 ditolak (cap dari DB)", dbCap.allowed === false && dbCap.open === 2);

      runGuardTests();
    });
  }
}

function runGuardTests() {
  // ── Guard konstruktor ─────────────────────────────────────────────────────
  {
    let threw = false;
    try {
      // eslint-disable-next-line no-new
      new MultiStrategyCoordinator({ userId: "x", symbol: "BTCUSDT", strategies: [], totalCapital: 10, engineFactory: () => {} });
    } catch { threw = true; }
    t("tanpa strategi → throw", threw);

    let threw2 = false;
    try {
      // eslint-disable-next-line no-new
      new MultiStrategyCoordinator({ userId: "x", symbol: "BTCUSDT", strategies: ["AF"], totalCapital: 10 });
    } catch { threw2 = true; }
    t("tanpa engineFactory → throw", threw2);
  }

  console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
  console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
  process.exit(fail === 0 ? 0 : 1);
}
