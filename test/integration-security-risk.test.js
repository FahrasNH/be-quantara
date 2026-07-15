/**
 * ─────────────────────────────────────────────────────────────────────────────
 * integration-security-risk.test.js
 *
 * Integration test untuk fix audit QA (SEV1–SEV3). Berjalan TANPA Postgres/
 * jaringan: `db._pool.query` di-mock (referensi yang sama dipakai fungsi internal
 * database.js) dan exchange client di-inject palsu ke BotEngine.
 *
 * Cakupan:
 *   SEC   — #1  IDOR: semua query history menyertakan filter kepemilikan user_id
 *   RISK  — #3  getTodayRiskStats menghitung daily/consec loss dengan benar
 *   RISK  — #3  _checkRiskGates menegakkan cooldown/consec/max-trade/daily(+floating #8)
 *   RISK  — #2  _handleSignal LIVE meng-ABORT entry bila balance gagal dibaca
 *   RISK  — #4  _handleSignal LIVE meng-emergency-close bila SL gagal (anti naked)
 *   CONC  — #6  _tick re-entrancy guard mencegah tick paralel
 *
 * Run: node test/integration-security-risk.test.js   (npm run test:integration)
 * ─────────────────────────────────────────────────────────────────────────────
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
// Nonaktifkan notifier Telegram SEBELUM require (hindari HTTP nyata saat test).
process.env.TELEGRAM_BOT_TOKEN = "";
process.env.TELEGRAM_CHAT_ID   = "";

const db = require("../src/infrastructure/db/database");

// ── Mock pool: tangkap SQL+params, kembalikan rows yang bisa dikonfigurasi ────
let lastQuery = { sql: "", params: [] };
let nextRows  = [{}];
db._pool.query = async (sql, params = []) => {
  lastQuery = { sql: String(sql), params };
  return { rows: nextRows };
};

const BotEngine = require("../src/modules/trading/application/BotEngine");

// ── Mini async-aware runner (jest-lite tidak meng-await test async) ───────────
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, message: err.message });
    console.log(`  ❌ ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertContains(haystack, needle, label) {
  assert(typeof haystack === "string" && haystack.includes(needle),
    `${label || "string"} harus mengandung "${needle}"`);
}

// ── Fake exchange client builder ─────────────────────────────────────────────
function makeFakeClient(overrides = {}) {
  const calls = { openPosition: 0, closePosition: 0, setTPSL: 0 };
  const client = {
    _calls: calls,
    getBalance:        async () => ({ available: 1000, equity: 1000, unrealizedPL: 0 }),
    getTicker:         async () => ({ last: 100, bestBid: 100, bestAsk: 100 }),
    getCandles:        async () => [],
    getPositions:      async () => [],
    setLeverage:       async () => ({}),
    setMarginMode:     async () => ({ success: true, mode: "cross" }),
    cancelAllPlanOrders: async () => ({ success: true }),
    getRecentFillPrice: async () => null,
    getRecentFillFee:   async () => null,
    openPosition:      async () => { calls.openPosition++; return { orderId: "ord_1", presetSLTP: true }; },
    closePosition:     async () => { calls.closePosition++; return { orderId: "close_1" }; },
    setTPSL:           async () => { calls.setTPSL++;  return { success: true, method: "test" }; },
    ...overrides,
  };
  return client;
}

// BotEngine LIVE siap-pakai dengan client palsu (tanpa sesi DB → tanpa insertTrade).
function makeLiveBot(clientOverrides = {}) {
  const bot = new BotEngine({ symbol: "BTCUSDT", dryRun: false, strategyKey: "ADAPTIVE_FUSION" });
  bot.client    = makeFakeClient(clientOverrides);
  bot.sessionId = null;                 // skip db.insertTrade
  bot.config.coordinator = null;        // koordinator diuji terpisah
  bot.config.riskPerTrade    = 0.01;
  bot.config.maxRiskPerTrade = 0.05;
  bot.config.atrMultiplier   = 2;       // slDist = atr*2
  bot.config.riskReward      = 2;
  bot.config.leverage        = 5;
  bot.config.slPlusEnabled   = false;
  return bot;
}

(async () => {
  console.log("\n🛡️  INTEGRATION — Security & Risk Fixes\n");

  // ───────────────────────────────────────────────────────────────────────────
  console.log("SEC #1 — IDOR: filter kepemilikan user_id di query history");
  // ───────────────────────────────────────────────────────────────────────────
  await t("getSession(id, userId) → query memfilter user_id + param userId", async () => {
    nextRows = [{ id: 7, config: null }];
    await db.getSession(7, "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getSession");
    assert(lastQuery.params.includes("userA"), "param userId harus diteruskan");
  });

  await t("getTradeStats(sessionId, userId) → EXISTS user_id + param", async () => {
    nextRows = [{ total: 0 }];
    await db.getTradeStats(7, "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getTradeStats");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getEquity(sessionId, userId) → EXISTS user_id + param", async () => {
    nextRows = [];
    await db.getEquity(7, "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getEquity");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getLogs(sessionId, limit, userId) → EXISTS user_id + param", async () => {
    nextRows = [];
    await db.getLogs(7, 200, "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getLogs");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getInsights({userId}) → filter user_id + param", async () => {
    nextRows = [];
    await db.getInsights({ userId: "userA" });
    assertContains(lastQuery.sql, "user_id", "SQL getInsights");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getAllEquity(mode, userId) → filter user_id + param", async () => {
    nextRows = [];
    await db.getAllEquity("live", "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getAllEquity");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getSessions(limit, symbol, userId) → filter user_id + param", async () => {
    nextRows = [];
    await db.getSessions(20, null, "userA");
    assertContains(lastQuery.sql, "user_id", "SQL getSessions");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  await t("getTrades({userId}) → JOIN bot_sessions + filter user_id + param", async () => {
    nextRows = [];
    await db.getTrades({ userId: "userA" });
    assertContains(lastQuery.sql, "user_id", "SQL getTrades");
    assert(lastQuery.params.includes("userA"), "param userId");
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nRISK #3 — getTodayRiskStats: agregasi daily/consec loss");
  // ───────────────────────────────────────────────────────────────────────────
  await t("hitung dailyLoss(net), dailyTradeCount, consecLoss (reset saat win)", async () => {
    // net: -11 (loss), +4 (win→reset), -20 (loss) → dailyLoss 31, count 3, consec 1
    nextRows = [
      { pnl: -10, fee: 1, funding: 0 },
      { pnl:   5, fee: 1, funding: 0 },
      { pnl: -20, fee: 0, funding: 0 },
    ];
    const r = await db.getTodayRiskStats({ userId: "userA", symbol: "BTCUSDT", dryRun: false });
    assert(Math.abs(r.dailyLoss - 31) < 1e-9, `dailyLoss=${r.dailyLoss} (harusnya 31)`);
    assert(r.dailyTradeCount === 3, `dailyTradeCount=${r.dailyTradeCount} (harusnya 3)`);
    assert(r.consecLoss === 1, `consecLoss=${r.consecLoss} (harusnya 1)`);
    assertContains(lastQuery.sql, "user_id", "SQL getTodayRiskStats (isolasi user)");
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nRISK #3/#8 — _checkRiskGates menegakkan batas");
  // ───────────────────────────────────────────────────────────────────────────
  await t("state bersih → gate OK", async () => {
    const bot = makeLiveBot();
    bot.config.maxConsecLoss = 3; bot.config.maxTradesPerDay = 10; bot.config.maxDailyLossPct = 0.04;
    bot.state.consecLoss = 0; bot.state.dailyTradeCount = 0; bot.state.dailyLoss = 0;
    bot.state.dailyStartCapital = 1000; bot.state.capital = 1000; bot.state.openPositions = [];
    bot.config.atrMinMult = 0; // isolate ATR gate; this test is about other gates
    const g = bot._checkRiskGates(1, 100);
    assert(g.ok === true, `gate harus OK, dapat: ${g.reason}`);
  });

  await t("consecLoss ≥ max → gate BLOK", async () => {
    const bot = makeLiveBot();
    bot.config.maxConsecLoss = 3; bot.state.consecLoss = 3;
    const g = bot._checkRiskGates(10, 100);
    assert(g.ok === false, "harus diblok karena loss beruntun");
  });

  await t("dailyTradeCount ≥ max → gate BLOK", async () => {
    const bot = makeLiveBot();
    bot.config.maxConsecLoss = 3; bot.config.maxTradesPerDay = 5;
    bot.state.consecLoss = 0; bot.state.dailyTradeCount = 5;
    const g = bot._checkRiskGates(10, 100);
    assert(g.ok === false, "harus diblok karena max trade harian");
  });

  await t("cooldown aktif → gate BLOK", async () => {
    const bot = makeLiveBot();
    bot.state.cooldownUntil = Date.now() + 60_000;
    const g = bot._checkRiskGates(10, 100);
    assert(g.ok === false, "harus diblok karena cooldown");
  });

  await t("#8 floating loss besar → gate BLOK (walau realized 0)", async () => {
    const bot = makeLiveBot();
    bot.config.maxConsecLoss = 3; bot.config.maxTradesPerDay = 10; bot.config.maxDailyLossPct = 0.04;
    bot.state.consecLoss = 0; bot.state.dailyTradeCount = 0; bot.state.dailyLoss = 0;
    bot.state.dailyStartCapital = 1000; bot.state.capital = 1000;
    bot.state.openPositions = [{ unrealizedPL: -100 }]; // 10% floating DD > 4%
    const g = bot._checkRiskGates(10, 100);
    assert(g.ok === false, "floating loss harus ikut men-trigger stop");
  });

  await t("#5 account gate: per-bot OK tapi agregat akun lewat batas → _checkRiskGates BLOK", async () => {
    const AccountCoordinator = require("../src/domain/AccountCoordinator");
    const coord = new AccountCoordinator({ userId: "uX", maxAccountDailyLossPct: 0.06 });
    coord.setAccountEquity(1000);
    coord.reportRisk("uX:ETHUSDT", { realizedLoss: 70, floatingLoss: 0 }); // bot lain rugi 7%

    const bot = makeLiveBot();
    bot.config.coordinator = coord;
    bot.config.botKey = "uX:BTCUSDT";
    bot.config.maxConsecLoss = 3; bot.config.maxTradesPerDay = 10; bot.config.maxDailyLossPct = 0.04;
    bot.state.consecLoss = 0; bot.state.dailyTradeCount = 0; bot.state.dailyLoss = 0; // bot INI bersih
    bot.state.dailyStartCapital = 1000; bot.state.capital = 1000; bot.state.openPositions = [];

    const g = bot._checkRiskGates(1, 100);
    assert(g.ok === false, "harus diblok oleh gate akun agregat");
    assertContains(g.reason, "AKUN", "alasan harus menyebut gate akun");
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nRISK #2 — sizing: LIVE abort entry bila balance gagal dibaca");
  // ───────────────────────────────────────────────────────────────────────────
  await t("getBalance throw → tidak ada order, openPositions kosong", async () => {
    const bot = makeLiveBot({ getBalance: async () => { throw new Error("rate limit 429"); } });
    await bot._handleSignal("LONG", 100, 10, null, {});
    assert(bot.client._calls.openPosition === 0, "openPosition TIDAK boleh dipanggil");
    assert(bot.state.openPositions.length === 0, "tidak boleh ada posisi terbuka");
  });

  await t("balance 0/invalid → abort entry", async () => {
    const bot = makeLiveBot({ getBalance: async () => ({ available: 0, equity: 0 }) });
    await bot._handleSignal("LONG", 100, 10, null, {});
    assert(bot.client._calls.openPosition === 0, "openPosition tidak dipanggil saat balance 0");
    assert(bot.state.openPositions.length === 0, "tidak ada posisi");
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nRISK #4 — naked position: SL gagal → emergency close");
  // ───────────────────────────────────────────────────────────────────────────
  await t("preset SL/TP gagal & setTPSL gagal → closePosition dipanggil, posisi tidak ditrack (~8s retry)", async () => {
    let closed = 0;
    const bot = makeLiveBot({
      getBalance:    async () => ({ available: 1000, equity: 1000 }),
      openPosition:  async () => ({ orderId: "ord_x", presetSLTP: false }), // preset gagal
      setTPSL:       async () => ({ success: false, message: "exchange reject" }), // SL gagal
      closePosition: async () => { closed++; return { orderId: "emg" }; },
    });
    await bot._handleSignal("LONG", 100, 10, null, {});
    assert(closed >= 1, "closePosition (emergency) HARUS dipanggil saat SL gagal");
    assert(bot.state.openPositions.length === 0, "posisi telanjang TIDAK boleh ditrack sebagai sehat");
  });

  await t("SL berhasil (preset embed) → posisi normal ditrack, tanpa emergency close", async () => {
    const bot = makeLiveBot({
      getBalance:   async () => ({ available: 1000, equity: 1000 }),
      openPosition: async () => ({ orderId: "ord_ok", presetSLTP: true }),
    });
    await bot._handleSignal("LONG", 100, 10, null, {});
    assert(bot.client._calls.closePosition === 0, "tidak ada emergency close saat SL OK");
    assert(bot.state.openPositions.length === 1, "posisi sehat harus ditrack");
  });

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\nCONC #6 — _tick re-entrancy guard");
  // ───────────────────────────────────────────────────────────────────────────
  await t("_ticking=true → tick berikutnya dilewati (no-op)", async () => {
    const bot = makeLiveBot();
    bot._ticking = true;
    const before = bot.state.checkCount;
    await bot._tick();
    assert(bot.state.checkCount === before, "checkCount tidak boleh bertambah saat guard aktif");
  });

  // ── Ringkasan ──────────────────────────────────────────────────────────────
  const total = pass + fail;
  console.log(`\n${"═".repeat(52)}`);
  console.log(`  TESTS: ${pass} passed, ${fail} failed (${total} total)`);
  if (fail > 0) {
    console.log("\n  ❌ FAILURES:");
    for (const f of failures) console.log(`   - ${f.name}: ${f.message}`);
    console.log("");
  } else {
    console.log("\n  ✅ ALL INTEGRATION TESTS PASSED\n");
  }
  process.exit(fail === 0 ? 0 : 1);
})();
