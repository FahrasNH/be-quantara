/**
 * HOTFIX — Idempotent close + side-effect gating (anti double-book / log ganda).
 *
 * Reproduksi insiden SOL 16-Jun-2026: posisi yang sama diproses lebih dari sekali
 * (akun ber-netting dibaca banyak engine / resume race lintas restart) → PnL & stats
 * ter-booking ganda, log "POSISI DITUTUP" muncul dobel.
 *
 * Kontrak yang diuji: BotEngine MENUTUP record di DB DULU; semua efek samping
 * (push ke state.trades, _updateRiskAfterClose) HANYA berjalan bila db.closeTrade
 * mengembalikan { applied: true }. applied:false / error → di-skip (no-op).
 *
 * Standalone runner (tanpa jest) — selaras gaya test repo lain.
 */
"use strict";

const BotEngine = require("../src/application/BotEngine");
const db        = require("../src/infrastructure/db/database");

let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (err) { fail++; failures.push({ name, message: err.message }); console.log(`  ❌ ${name}\n       ${err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// Bot LIVE minimal dengan satu posisi terbuka yang sudah lenyap dari exchange.
function makeLiveBotWithClosedPosition() {
  const bot = new BotEngine({ symbol: "SOLUSDT", dryRun: false, strategyKey: "ADAPTIVE_FUSION" });
  bot.sessionId = 123;
  // Exchange melaporkan TIDAK ada posisi → engine menganggap SL/TP hit.
  bot.client = { getPositions: async () => [] };
  // Stub agar tidak menyentuh exchange/DB nyata.
  bot._resolveFee          = async () => 0.04;
  bot._syncSessionStats    = () => {};
  bot._releaseMarginIfFlat = () => {};
  // Spy: berapa kali risk di-update (harus tepat 1x bila applied, 0x bila skip).
  bot._riskCalls = 0;
  bot._updateRiskAfterClose = () => { bot._riskCalls += 1; };
  bot.config.slPlusEnabled = false;
  bot.state.capital = 100;
  bot.state.openPositions = [{
    id: "sol1", dbId: 999, side: "LONG",
    entry: 67.076, sl: 66.67, tp: 67.88,
    size: 0.5, remainingSize: 0.5, openTime: Date.now(),
    m1: false, m2: false, m3: false,
  }];
  return bot;
}

(async () => {
  console.log("\n🔁 HOTFIX — close idempotent + gating efek samping\n");

  const origClose = db.closeTrade;

  // ── 1. applied:true → trade dibukukan TEPAT sekali ───────────────────────────
  await t("applied:true → state.trades +1 & risk di-update 1x", async () => {
    db.closeTrade = async () => ({ applied: true });
    const bot = makeLiveBotWithClosedPosition();
    await bot._checkOpenPositions(66.67, 5, 66.67, 66.67);
    assert(bot.state.trades.length === 1, `trades harus 1, dapat ${bot.state.trades.length}`);
    assert(bot._riskCalls === 1, `risk harus 1x, dapat ${bot._riskCalls}`);
    assert(bot.state.openPositions.length === 0, "posisi harus dibersihkan dari state");
  });

  // ── 2. applied:false (sudah dibukukan engine/proses lain) → SKIP total ───────
  await t("applied:false → tidak ada double-book (trades 0, risk 0)", async () => {
    db.closeTrade = async () => ({ applied: false });
    const bot = makeLiveBotWithClosedPosition();
    await bot._checkOpenPositions(66.67, 5, 66.67, 66.67);
    assert(bot.state.trades.length === 0, `trades harus 0 (skip duplikat), dapat ${bot.state.trades.length}`);
    assert(bot._riskCalls === 0, `risk harus 0x, dapat ${bot._riskCalls}`);
    // Posisi tetap dibersihkan dari state (sudah tidak ada di exchange).
    assert(bot.state.openPositions.length === 0, "posisi harus tetap dibersihkan dari state");
  });

  // ── 3. closeTrade error → surfaced, tidak dibukukan ─────────────────────────
  await t("closeTrade throw → tidak dibukukan (trades 0, risk 0)", async () => {
    db.closeTrade = async () => { throw new Error("db down"); };
    const bot = makeLiveBotWithClosedPosition();
    await bot._checkOpenPositions(66.67, 5, 66.67, 66.67);
    assert(bot.state.trades.length === 0, `trades harus 0 saat DB error, dapat ${bot.state.trades.length}`);
    assert(bot._riskCalls === 0, `risk harus 0x saat DB error, dapat ${bot._riskCalls}`);
  });

  db.closeTrade = origClose;

  console.log(`\n${fail === 0 ? "✅" : "❌"} CLOSE-IDEMPOTENCY: ${pass} lulus, ${fail} gagal\n`);
  if (fail > 0) { failures.forEach(f => console.log(`   - ${f.name}: ${f.message}`)); process.exit(1); }
})();
