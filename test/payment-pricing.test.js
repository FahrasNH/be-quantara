/**
 * payment-pricing.test.js — PURE pricing + voucher math (Sprint 5 / PAY-03).
 * No DB, no network. Covers getTierPrice, computeDiscount, validateVoucher,
 * quote, computeEndDate — the server-side money logic the client cannot forge.
 */
const assert = require("assert");
const pricing = require("#modules/payment/domain/pricing.js");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

console.log("\n💳 Payment pricing & voucher math\n");

// ── getTierPrice ─────────────────────────────────────────────────────────────
t("FOUNDRY monthly = 149_000", () => assert.strictEqual(pricing.getTierPrice("FOUNDRY", "MONTHLY"), 149_000));
t("VAULT monthly = 1_599_000", () => assert.strictEqual(pricing.getTierPrice("VAULT", "MONTHLY"), 1_599_000));
t("FOUNDRY yearly = monthly × 10", () => assert.strictEqual(pricing.getTierPrice("FOUNDRY", "YEARLY"), 1_490_000));
t("default cycle is MONTHLY", () => assert.strictEqual(pricing.getTierPrice("MINT"), pricing.getTierPrice("MINT", "MONTHLY")));
t("unknown tier throws", () => assert.throws(() => pricing.getTierPrice("BOGUS")));
t("unknown cycle throws", () => assert.throws(() => pricing.getTierPrice("MINT", "WEEKLY")));

// ── computeDiscount ──────────────────────────────────────────────────────────
t("PERCENT 10% of 1_000_000 = 100_000", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "PERCENT", value: 10 }, 1_000_000), 100_000));
t("PERCENT capped by maxDiscount", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "PERCENT", value: 50, maxDiscount: 100_000 }, 1_000_000), 100_000));
t("PERCENT > 100 clamped to 100%", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "PERCENT", value: 999 }, 500_000), 500_000));
t("FIXED 50_000 off", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "FIXED", value: 50_000 }, 149_000), 50_000));
t("discount never exceeds gross", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "FIXED", value: 999_999 }, 149_000), 149_000));
t("unknown voucher type → 0", () =>
  assert.strictEqual(pricing.computeDiscount({ type: "WAT", value: 10 }, 149_000), 0));

// ── validateVoucher ──────────────────────────────────────────────────────────
const now = new Date("2026-06-25T00:00:00Z");
const base = {
  code: "X", type: "PERCENT", value: 10, isActive: true, deletedAt: null,
  validFrom: new Date("2026-06-01"), validUntil: new Date("2026-12-31"),
  maxUses: 100, currentUses: 5, maxUsesPerUser: 1, applicableTiers: [], minPurchase: 0,
};
const V = (over) => ({ ...base, ...over });

t("valid voucher → valid + correct discount", () => {
  const r = pricing.validateVoucher({ voucher: V(), grossAmount: 1_000_000, tier: "MINT", now, userUsageCount: 0 });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.discountAmount, 100_000);
  assert.strictEqual(r.finalAmount, 900_000);
});
t("null voucher → VOUCHER_NOT_FOUND", () => {
  const r = pricing.validateVoucher({ voucher: null, grossAmount: 100, tier: "MINT", now });
  assert.strictEqual(r.valid, false); assert.strictEqual(r.reason, "VOUCHER_NOT_FOUND");
});
t("soft-deleted → VOUCHER_NOT_FOUND", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ deletedAt: new Date() }), grossAmount: 100, tier: "MINT", now }).reason, "VOUCHER_NOT_FOUND"));
t("inactive → VOUCHER_INACTIVE", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ isActive: false }), grossAmount: 100, tier: "MINT", now }).reason, "VOUCHER_INACTIVE"));
t("before validFrom → VOUCHER_NOT_YET_VALID", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ validFrom: new Date("2026-07-01") }), grossAmount: 100, tier: "MINT", now }).reason, "VOUCHER_NOT_YET_VALID"));
t("after validUntil → VOUCHER_EXPIRED", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ validUntil: new Date("2026-06-10") }), grossAmount: 100, tier: "MINT", now }).reason, "VOUCHER_EXPIRED"));
t("global cap reached → VOUCHER_USAGE_LIMIT_REACHED", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ currentUses: 100, maxUses: 100 }), grossAmount: 100, tier: "MINT", now }).reason, "VOUCHER_USAGE_LIMIT_REACHED"));
t("per-user cap reached → VOUCHER_ALREADY_USED", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V(), grossAmount: 100, tier: "MINT", now, userUsageCount: 1 }).reason, "VOUCHER_ALREADY_USED"));
t("tier not applicable → VOUCHER_NOT_APPLICABLE_TO_TIER", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ applicableTiers: ["VAULT"] }), grossAmount: 1_000_000, tier: "MINT", now }).reason, "VOUCHER_NOT_APPLICABLE_TO_TIER"));
t("min purchase not met → VOUCHER_MIN_PURCHASE_NOT_MET", () =>
  assert.strictEqual(pricing.validateVoucher({ voucher: V({ minPurchase: 500_000 }), grossAmount: 149_000, tier: "MINT", now }).reason, "VOUCHER_MIN_PURCHASE_NOT_MET"));
t("unlimited maxUses (null) allowed", () => {
  const r = pricing.validateVoucher({ voucher: V({ maxUses: null, currentUses: 9999 }), grossAmount: 1_000_000, tier: "MINT", now });
  assert.strictEqual(r.valid, true);
});

// ── quote ────────────────────────────────────────────────────────────────────
t("quote without voucher → full price", () => {
  const q = pricing.quote({ tier: "FORGE", billingCycle: "MONTHLY" });
  assert.strictEqual(q.grossAmount, 399_000);
  assert.strictEqual(q.finalAmount, 399_000);
  assert.strictEqual(q.discountAmount, 0);
});
t("quote with valid voucher applies discount", () => {
  const q = pricing.quote({ tier: "FORGE", voucher: V(), now });
  assert.strictEqual(q.discountAmount, 39_900);
  assert.strictEqual(q.finalAmount, 359_100);
  assert.strictEqual(q.voucher.valid, true);
});

// ── computeEndDate ───────────────────────────────────────────────────────────
t("monthly adds 30 days", () => {
  const end = pricing.computeEndDate(new Date("2026-06-25T00:00:00Z"), "MONTHLY");
  assert.strictEqual(end.toISOString().slice(0, 10), "2026-07-25");
});
t("yearly adds 365 days", () => {
  const end = pricing.computeEndDate(new Date("2026-06-25T00:00:00Z"), "YEARLY");
  assert.strictEqual(end.toISOString().slice(0, 10), "2027-06-25");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} payment-pricing: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
