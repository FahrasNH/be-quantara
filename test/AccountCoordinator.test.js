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

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
