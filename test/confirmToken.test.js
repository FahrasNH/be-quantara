/**
 * confirmToken unit tests (TASK 3.5 — Security).
 * HMAC token konfirmasi force-close: non-predictable, short-lived, constant-time.
 */
process.env.CONFIRM_SECRET = "test-secret-abc";
const { issueConfirmToken, verifyConfirmToken } = require("../src/infrastructure/security/confirmToken");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🔐 confirmToken Unit Tests\n");

const ctx = { symbol: "BTCUSDT", userId: "user_12345" };

// ── Happy path ──────────────────────────────────────────────────────────────
{
  const token = issueConfirmToken(ctx);
  t("token berformat <ts>.<sig>", /^\d+\.[a-f0-9]{32}$/.test(token));
  t("token valid untuk (symbol,userId) yang sama", verifyConfirmToken(token, ctx) === true);
}

// ── Tidak bisa ditebak / dipalsukan ─────────────────────────────────────────
{
  const token = issueConfirmToken(ctx);
  t("token salah userId → ditolak", verifyConfirmToken(token, { ...ctx, userId: "user_99999" }) === false);
  t("token salah symbol → ditolak", verifyConfirmToken(token, { ...ctx, symbol: "ETHUSDT" }) === false);
  t("legacy predictable token → ditolak", verifyConfirmToken("STOP_BTCUSDT_2345", ctx) === false);
  t("token sampah → ditolak", verifyConfirmToken("garbage", ctx) === false);
  t("token kosong/null → ditolak", verifyConfirmToken(null, ctx) === false);
  t("sig dipalsukan → ditolak", verifyConfirmToken(`${Date.now()}.${"0".repeat(32)}`, ctx) === false);
}

// ── Kedaluwarsa ─────────────────────────────────────────────────────────────
{
  const oldTs = Date.now() - 6 * 60 * 1000; // 6 menit lalu (> 5 menit)
  const expired = issueConfirmToken({ ...ctx, ts: oldTs });
  t("token kedaluwarsa (>5 menit) → ditolak", verifyConfirmToken(expired, ctx) === false);

  const fresh = issueConfirmToken({ ...ctx, ts: Date.now() - 60 * 1000 }); // 1 menit lalu
  t("token masih segar (1 menit) → diterima", verifyConfirmToken(fresh, ctx) === true);
}

// ── Timestamp masa depan di luar skew → ditolak ─────────────────────────────
{
  const future = issueConfirmToken({ ...ctx, ts: Date.now() + 5 * 60 * 1000 });
  t("token ts masa depan (>skew) → ditolak", verifyConfirmToken(future, ctx) === false);
}

// ── maxAgeMs custom (deterministik, ts di masa lalu) ────────────────────────
{
  const token = issueConfirmToken({ ...ctx, ts: Date.now() - 1000 }); // 1 detik lalu
  t("maxAgeMs 500ms vs token 1s → expired", verifyConfirmToken(token, { ...ctx, maxAgeMs: 500 }) === false);
  t("maxAgeMs 5000ms vs token 1s → valid", verifyConfirmToken(token, { ...ctx, maxAgeMs: 5000 }) === true);
}

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
