/**
 * payment-security.test.js — webhook signature, status mapping, tier-feature
 * gating (Sprint 5 / PAY-04, PAY-07, PAY-12). All PURE — no DB, no network.
 */
const assert = require("assert");
const crypto = require("crypto");
const midtrans = require("../src/infrastructure/payment/midtrans");
const { checkTierFeature } = require("../src/middleware/subscriptionGuard");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n     ${e.message}`); }
};

// Real Midtrans signature: sha512(order_id + status_code + gross_amount + serverKey)
const SERVER_KEY = "SB-Mid-server-TESTKEY";
const sign = (orderId, statusCode, grossAmount, key = SERVER_KEY) =>
  crypto.createHash("sha512").update(`${orderId}${statusCode}${grossAmount}${key}`).digest("hex");

console.log("\n🔒 Payment security: signature, status mapping, tier gating\n");

// ── verifySignature ──────────────────────────────────────────────────────────
t("valid signature → true", () => {
  const sig = sign("QTR-1", "200", "149000.00");
  assert.strictEqual(midtrans.verifySignature({
    orderId: "QTR-1", statusCode: "200", grossAmount: "149000.00", signatureKey: sig, serverKey: SERVER_KEY,
  }), true);
});
t("tampered amount → false", () => {
  const sig = sign("QTR-1", "200", "149000.00");
  assert.strictEqual(midtrans.verifySignature({
    orderId: "QTR-1", statusCode: "200", grossAmount: "1.00", signatureKey: sig, serverKey: SERVER_KEY,
  }), false);
});
t("wrong serverKey → false", () => {
  const sig = sign("QTR-1", "200", "149000.00", "SB-Mid-server-OTHER");
  assert.strictEqual(midtrans.verifySignature({
    orderId: "QTR-1", statusCode: "200", grossAmount: "149000.00", signatureKey: sig, serverKey: SERVER_KEY,
  }), false);
});
t("missing fields → false (no crash)", () => {
  assert.strictEqual(midtrans.verifySignature({ orderId: "QTR-1", serverKey: SERVER_KEY }), false);
});
t("missing serverKey → false", () => {
  assert.strictEqual(midtrans.verifySignature({
    orderId: "QTR-1", statusCode: "200", grossAmount: "149000.00", signatureKey: "x", serverKey: "",
  }), false);
});

// ── mapTransactionStatus ─────────────────────────────────────────────────────
const map = (transaction_status, fraud_status) => midtrans.mapTransactionStatus({ transaction_status, fraud_status });
t("settlement → PAID", () => assert.strictEqual(map("settlement"), "PAID"));
t("capture + accept → PAID", () => assert.strictEqual(map("capture", "accept"), "PAID"));
t("capture + challenge → CHALLENGE", () => assert.strictEqual(map("capture", "challenge"), "CHALLENGE"));
t("capture + deny → FAILED", () => assert.strictEqual(map("capture", "deny"), "FAILED"));
t("pending → PENDING", () => assert.strictEqual(map("pending"), "PENDING"));
t("deny → FAILED", () => assert.strictEqual(map("deny"), "FAILED"));
t("cancel → FAILED", () => assert.strictEqual(map("cancel"), "FAILED"));
t("expire → EXPIRED", () => assert.strictEqual(map("expire"), "EXPIRED"));
t("refund → REFUNDED", () => assert.strictEqual(map("refund"), "REFUNDED"));
t("chargeback → REFUNDED", () => assert.strictEqual(map("chargeback"), "REFUNDED"));
t("unknown status → PENDING (safe default)", () => assert.strictEqual(map("weird"), "PENDING"));

// ── isConfigured (env-independent shape) ─────────────────────────────────────
t("isConfigured returns boolean", () => assert.strictEqual(typeof midtrans.isConfigured(), "boolean"));

// ── checkTierFeature (PAY-07) ────────────────────────────────────────────────
t("FOUNDRY autoSelector → denied", () => {
  const r = checkTierFeature("FOUNDRY", "autoSelector");
  assert.strictEqual(r.allowed, false); assert.strictEqual(r.reason, "FEATURE_NOT_IN_TIER");
});
t("MINT autoSelector → allowed", () => assert.strictEqual(checkTierFeature("MINT", "autoSelector").allowed, true));
t("FOUNDRY ADAPTIVE_FUSION strategy → allowed", () => assert.strictEqual(checkTierFeature("FOUNDRY", "ADAPTIVE_FUSION").allowed, true));
t("FOUNDRY TREND_FOLLOWING → denied with requiredTier", () => {
  const r = checkTierFeature("FOUNDRY", "TREND_FOLLOWING");
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, "STRATEGY_NOT_IN_TIER");
  assert.strictEqual(r.requiredTier, "FORGE");
});
t("unknown tier → denied UNKNOWN_TIER", () => {
  const r = checkTierFeature("PLATINUM", "autoSelector");
  assert.strictEqual(r.allowed, false); assert.strictEqual(r.reason, "UNKNOWN_TIER");
});

console.log(`\n${fail === 0 ? "✅" : "❌"} payment-security: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
