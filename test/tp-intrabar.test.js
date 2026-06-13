/**
 * BUG-TP-INTRABAR — TP/SL harus terdeteksi secara INTRABAR (high/low candle),
 * bukan hanya dari close/last (yang melewatkan wick).
 *
 * Reproduksi insiden BNB/USDT 12-Jun-2026 (dry-run):
 *   LONG entry 606.88, SL 604.09, TP 612.46. Candle wick menyentuh 612.46
 *   lalu close balik ke 611.92 → TP TIDAK ter-trigger (bug), posisi lanjut ke SL.
 *
 * Standalone runner (tanpa jest) — selaras gaya test repo lain.
 */
"use strict";

const BotEngine = require("../src/application/BotEngine");

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (err) { fail++; failures.push({ name, message: err.message }); console.log(`  ❌ ${name}\n       ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Bot DRY-RUN minimal dengan satu posisi terbuka.
function makeDryBotWithPosition(pos) {
  const bot = new BotEngine({ symbol: "BNBUSDT", dryRun: true, strategyKey: "ADAPTIVE_FUSION" });
  bot.client    = null;             // dry-run tidak menyentuh exchange di _checkOpenPositions
  bot.sessionId = null;             // skip db.closeTrade
  bot.config.slPlusEnabled = false; // matikan SL+ milestone
  bot.config.tpMode        = "full";
  bot.config.riskPerTrade  = 0.01;
  bot.state.capital        = 1000;
  bot.state.openPositions  = [pos];
  return bot;
}

function basePos(overrides = {}) {
  return {
    id: "p1", side: "LONG", entry: 606.88, sl: 604.09, tp: 612.46,
    size: 1, remainingSize: 1, marginReserved: 6.07, R: 2.79,
    m1: false, m2: false, m3: false, openTime: Date.now(),
    ...overrides,
  };
}

(async () => {
  console.log("\n🎯 BUG-TP-INTRABAR — deteksi TP/SL via high/low candle\n");

  // ── 1. Repro persis: wick menembus TP, close di bawah TP → harus TP ──────────
  await t("LONG: wick high menembus TP walau close < TP → posisi ditutup TP", async () => {
    const bot = makeDryBotWithPosition(basePos());
    // close/last = 611.92 (< TP 612.46), tapi HIGH candle = 612.50 (menembus TP)
    await bot._checkOpenPositions(611.92, 5, /*barHigh*/ 612.50, /*barLow*/ 611.00);
    assert(bot.state.openPositions.length === 0, "posisi harus tertutup");
    const trade = bot.state.trades[bot.state.trades.length - 1];
    assert(trade && trade.reason === "TP", `reason harus TP, dapat: ${trade?.reason}`);
    assert(trade.exit === 612.46, `exit harus di TP 612.46, dapat: ${trade.exit}`);
  });

  // ── 2. Tanpa fix (point-sample) close 611.92 tidak akan kena TP — pastikan
  //       posisi TETAP terbuka bila high belum mencapai TP ───────────────────────
  await t("LONG: high belum capai TP & low belum capai SL → posisi tetap terbuka", async () => {
    const bot = makeDryBotWithPosition(basePos());
    await bot._checkOpenPositions(611.92, 5, /*barHigh*/ 612.00, /*barLow*/ 611.00);
    assert(bot.state.openPositions.length === 1, "posisi harus tetap terbuka");
  });

  // ── 3. LONG: wick low menembus SL → ditutup SL ───────────────────────────────
  await t("LONG: wick low menembus SL walau close > SL → ditutup SL", async () => {
    const bot = makeDryBotWithPosition(basePos());
    await bot._checkOpenPositions(605.00, 5, /*barHigh*/ 606.00, /*barLow*/ 604.00);
    const trade = bot.state.trades[bot.state.trades.length - 1];
    assert(trade && trade.reason === "SL", `reason harus SL, dapat: ${trade?.reason}`);
    assert(trade.exit === 604.09, `exit harus di SL 604.09, dapat: ${trade.exit}`);
  });

  // ── 4. Tie-break: satu bar menyentuh SL & TP → SL menang (konservatif) ────────
  await t("LONG: bar menyentuh SL & TP sekaligus → tutup di SL (konservatif)", async () => {
    const bot = makeDryBotWithPosition(basePos());
    await bot._checkOpenPositions(608.00, 5, /*barHigh*/ 613.00, /*barLow*/ 603.50);
    const trade = bot.state.trades[bot.state.trades.length - 1];
    assert(trade && trade.reason === "SL", `tie-break harus SL, dapat: ${trade?.reason}`);
  });

  // ── 5. SHORT: wick low menembus TP → ditutup TP ──────────────────────────────
  await t("SHORT: wick low menembus TP walau close > TP → ditutup TP", async () => {
    const pos = basePos({ side: "SHORT", entry: 612.00, sl: 614.79, tp: 606.42 });
    const bot = makeDryBotWithPosition(pos);
    await bot._checkOpenPositions(607.00, 5, /*barHigh*/ 608.00, /*barLow*/ 606.30);
    const trade = bot.state.trades[bot.state.trades.length - 1];
    assert(trade && trade.reason === "TP", `reason harus TP, dapat: ${trade?.reason}`);
    assert(trade.exit === 606.42, `exit harus di TP, dapat: ${trade.exit}`);
  });

  // ── 6. Backward-compat: tanpa barHigh/barLow, fallback ke price ───────────────
  await t("Fallback: tanpa high/low, price >= TP tetap menutup TP", async () => {
    const bot = makeDryBotWithPosition(basePos());
    await bot._checkOpenPositions(612.50, 5); // barHigh/barLow default = price
    const trade = bot.state.trades[bot.state.trades.length - 1];
    assert(trade && trade.reason === "TP", `reason harus TP, dapat: ${trade?.reason}`);
  });

  console.log(`\n${fail === 0 ? "✅" : "❌"} TP-INTRABAR: ${pass} lulus, ${fail} gagal\n`);
  if (fail > 0) { failures.forEach(f => console.log(`   - ${f.name}: ${f.message}`)); process.exit(1); }
})();
