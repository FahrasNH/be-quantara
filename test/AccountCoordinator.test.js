/**
 * AccountCoordinator unit tests (#5 — koordinasi margin lintas-bot).
 * Standalone runner: exit code != 0 bila ada yang gagal.
 */
const AC = require("../src/domain/AccountCoordinator");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🔗 AccountCoordinator Unit Tests\n");

// ── Budget margin lintas-bot ────────────────────────────────────────────────
{
  const c = new AC({ userId: "u1", maxAccountUtilization: 0.8 });
  c.setAccountEquity(100); // budget = 80

  let v = c.canOpen({ botKey: "u1:BTCUSDT", symbol: "BTCUSDT", requiredMargin: 40 });
  t("BTC margin 40 → boleh", v.ok);
  c.reserve("u1:BTCUSDT", { symbol: "BTCUSDT", margin: 40 });

  v = c.canOpen({ botKey: "u1:ETHUSDT", symbol: "ETHUSDT", requiredMargin: 40 });
  t("ETH margin 40 → boleh (pas budget 80)", v.ok);
  c.reserve("u1:ETHUSDT", { symbol: "ETHUSDT", margin: 40 });

  v = c.canOpen({ botKey: "u1:SOLUSDT", symbol: "SOLUSDT", requiredMargin: 10 });
  t("SOL margin 10 → DITOLAK (over budget, anti over-commit)", !v.ok);

  v = c.canOpen({ botKey: "u1:BTCUSDT-2", symbol: "BTCUSDT", requiredMargin: 1 });
  t("BTC kedua → DITOLAK (maks 1 posisi/simbol)", !v.ok);

  c.release("u1:ETHUSDT");
  v = c.canOpen({ botKey: "u1:SOLUSDT", symbol: "SOLUSDT", requiredMargin: 10 });
  t("Setelah ETH close, SOL 10 → boleh kembali", v.ok);

  c.reserve("u1:SOLUSDT", { symbol: "SOLUSDT", margin: 10 });
  t("committedMargin = 50 (BTC40 + SOL10)", c.committedMargin() === 50);
  t("committedMargin(except BTC) = 10", c.committedMargin("u1:BTCUSDT") === 10);
}

// ── Batas jumlah posisi serentak ────────────────────────────────────────────
{
  const c = new AC({ userId: "u2", maxConcurrentPositions: 1 });
  c.setAccountEquity(1000);
  c.reserve("u2:BTCUSDT", { symbol: "BTCUSDT", margin: 5 });
  const v = c.canOpen({ botKey: "u2:ETHUSDT", symbol: "ETHUSDT", requiredMargin: 5 });
  t("maxConcurrent=1 → posisi ke-2 DITOLAK", !v.ok);
}

// ── Re-reserve idempotent (restart restore) ────────────────────────────────
{
  const c = new AC({ userId: "u4", maxAccountUtilization: 0.8 });
  c.setAccountEquity(100);
  c.reserve("u4:BTCUSDT", { symbol: "BTCUSDT", margin: 30 });
  c.reserve("u4:BTCUSDT", { symbol: "BTCUSDT", margin: 30 }); // idempotent
  t("reserve idempotent per botKey → committed 30 (bukan 60)", c.committedMargin() === 30);
}

// ── Equity belum diketahui → gate budget di-skip ────────────────────────────
{
  const c = new AC({ userId: "u3" });
  const v = c.canOpen({ botKey: "u3:BTCUSDT", symbol: "BTCUSDT", requiredMargin: 999999 });
  t("equity unknown → budget di-skip (allow)", v.ok);
}

// ── Daily loss AGREGAT lintas-bot (#5 residual) ─────────────────────────────
{
  const c = new AC({ userId: "u5", maxAccountDailyLossPct: 0.06 }); // batas akun 6%
  // equity 1000 = equity KINI (sudah berkurang). Baseline awal-hari = 1000 + realized.
  c.setAccountEquity(1000);

  // Bot pertama rugi (di bawah batas per-bot 4%) — agregat masih aman.
  c.reportRisk("u5:BTCUSDT", { realizedLoss: 30, floatingLoss: 0 }); // 30/1030 ≈ 2.9%
  t("agregat ~2.9% → akun masih boleh trading", c.canTradeAccount().ok);

  // Bot kedua menambah loss → agregat menembus batas akun (cegah 3×4%=12%).
  c.reportRisk("u5:ETHUSDT", { realizedLoss: 40, floatingLoss: 0 }); // total 70/1070 ≈ 6.5%
  t("agregat ~6.5% → akun DIBLOK (cegah akumulasi lintas-bot)", !c.canTradeAccount().ok);
}

{
  const c = new AC({ userId: "u6", maxAccountDailyLossPct: 0.06 });
  c.setAccountEquity(1000);
  c.reportRisk("u6:BTCUSDT", { realizedLoss: 20, floatingLoss: 50 }); // 2% + 5% floating = 7%
  t("floating loss ikut dihitung di gate akun → DIBLOK", !c.canTradeAccount().ok);
}

{
  const c = new AC({ userId: "u7" }); // maxAccountDailyLossPct = 0 → nonaktif
  c.setAccountEquity(1000);
  c.reportRisk("u7:BTCUSDT", { realizedLoss: 999, floatingLoss: 0 });
  t("gate akun nonaktif (pct=0) → selalu allow", c.canTradeAccount().ok);
}

{
  const c = new AC({ userId: "u8", maxAccountDailyLossPct: 0.06 });
  // equity belum diketahui → jangan blokir (hindari false-positive saat start)
  c.reportRisk("u8:BTCUSDT", { realizedLoss: 999, floatingLoss: 0 });
  t("equity unknown → gate akun di-skip (allow)", c.canTradeAccount().ok);
}

// ── Multi-Strategy group (TASK 1.4 / TC-008) ────────────────────────────────
{
  // 4 strategi × 25% capital pada SATU koin → total = capital, ≤ budget.
  const c = new AC({ userId: "g1", maxAccountUtilization: 0.8 });
  c.setAccountEquity(100); // budget = 80
  const strategies = ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];

  const g = c.reserveGroup("g1", "ETHUSDT", strategies, 80); // total 80 (= budget)
  t("reserveGroup → 4 reservasi (1/strategi)", g.count === 4);
  t("reserveGroup → margin/strategi = 20 (80/4)", g.perStrategyMargin === 20);
  t("group total committed = 80", c.committedMargin() === 80);

  const util = c.getGroupUtilization("g1", "ETHUSDT");
  t("getGroupUtilization reserved = 80", util.reserved === 80);
  t("getGroupUtilization count = 4", util.count === 4);
  t("getGroupUtilization util% = 100% (80/80 budget)", Math.abs(util.utilizationPct - 1) < 1e-9);

  // Strategi segrup boleh berbagi simbol yang sama (bukan 1-posisi/simbol).
  const sameGroup = c.canOpen({
    botKey: "g1:ETHUSDT#TREND_FOLLOWING",
    symbol: "ETHUSDT",
    requiredMargin: 1,
    groupKey: "g1:ETHUSDT",
  });
  t("strategi segrup → boleh berbagi simbol (bypass 1/simbol)", sameGroup.ok === true);

  // Tapi strategi dari grup LAIN tetap diblok pada simbol yang sama.
  const otherGroup = c.canOpen({
    botKey: "g1:ETHUSDT#OUTSIDER",
    symbol: "ETHUSDT",
    requiredMargin: 1,
    groupKey: "g1:OTHER", // groupKey berbeda
  });
  t("strategi grup LAIN pada simbol sama → tetap DITOLAK", !otherGroup.ok);
}

{
  // Over-allocate: grup margin melebihi budget → strategi tambahan DITOLAK.
  const c = new AC({ userId: "g2", maxAccountUtilization: 0.8 });
  c.setAccountEquity(100); // budget 80
  c.reserveGroup("g2", "BTCUSDT", ["AF", "TM", "MR", "BR"], 80); // sudah pas budget
  const extra = c.canOpen({
    botKey: "g2:SOLUSDT#AF",
    symbol: "SOLUSDT",
    requiredMargin: 5,
    groupKey: "g2:SOLUSDT",
  });
  t("TC-008: grup penuh budget → koin lain DITOLAK (anti over-allocate)", !extra.ok);
}

{
  // releaseGroup melepas semua reservasi grup, tidak menyentuh grup lain.
  const c = new AC({ userId: "g3", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);
  c.reserveGroup("g3", "ETHUSDT", ["AF", "TM"], 40);
  c.reserveGroup("g3", "BTCUSDT", ["AF", "TM"], 60);
  t("dua grup → committed 100", c.committedMargin() === 100);
  const removed = c.releaseGroup("g3", "ETHUSDT");
  t("releaseGroup ETH → lepas 2 reservasi", removed === 2);
  t("setelah release ETH → committed 60 (BTC tetap)", c.committedMargin() === 60);
  t("getGroupUtilization ETH setelah release → 0", c.getGroupUtilization("g3", "ETHUSDT").reserved === 0);
}

{
  // Direction lock (AC-05): grup tidak boleh LONG + SHORT serentak pada simbol sama.
  const c = new AC({ userId: "gd", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);
  const groupKey = "gd:ETHUSDT";

  // Strategi AF buka LONG pada ETH.
  c.reserve("gd:ETHUSDT#AF", { symbol: "ETHUSDT", margin: 10, groupKey, strategyKey: "AF", direction: "LONG" });

  // Strategi MR mau SHORT pada ETH (segrup) → DITOLAK (arah berlawanan).
  const conflict = c.canOpen({
    botKey: "gd:ETHUSDT#MR", symbol: "ETHUSDT", requiredMargin: 10,
    groupKey, direction: "SHORT",
  });
  t("AC-05: SHORT ditolak saat grup sudah LONG (direction lock)", !conflict.ok);

  // Strategi TM mau LONG juga (searah) → BOLEH (entry terdiversifikasi).
  const sameDir = c.canOpen({
    botKey: "gd:ETHUSDT#TM", symbol: "ETHUSDT", requiredMargin: 10,
    groupKey, direction: "LONG",
  });
  t("AC-05: LONG searah tetap diizinkan (diversified)", sameDir.ok);

  // Setelah grup flat (release), arah berlawanan boleh lagi.
  c.releaseGroup("gd", "ETHUSDT");
  const afterFlat = c.canOpen({
    botKey: "gd:ETHUSDT#MR", symbol: "ETHUSDT", requiredMargin: 10,
    groupKey, direction: "SHORT",
  });
  t("AC-05: setelah grup flat → SHORT boleh lagi", afterFlat.ok);
}

{
  // Backward-compat: legacy single-bot (tanpa groupKey) tetap 1-posisi/simbol.
  const c = new AC({ userId: "g4", maxAccountUtilization: 0.8 });
  c.setAccountEquity(1000);
  c.reserve("g4:BTCUSDT", { symbol: "BTCUSDT", margin: 10 }); // groupKey default null
  const dup = c.canOpen({ botKey: "g4:BTCUSDT-2", symbol: "BTCUSDT", requiredMargin: 1 });
  t("legacy (tanpa groupKey) → tetap maks 1 posisi/simbol", !dup.ok);
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
