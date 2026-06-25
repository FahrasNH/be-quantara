// ─────────────────────────────────────────────────────────────────────────────
// midtrans.js — Midtrans Snap client wrapper + webhook security (Sprint 5)
//
// Two concerns live here:
//   1. Talking to Midtrans (create Snap transaction)         → needs keys + network
//   2. Verifying webhook notifications (SHA512 signature)    → PURE crypto, testable
//
// SECURITY (PAY-12): the webhook is the only thing that turns "pending" into a
// granted subscription. We MUST verify Midtrans's SHA512 signature before
// trusting any notification:
//     signature = sha512(order_id + status_code + gross_amount + ServerKey)
// The ServerKey is the shared secret and never leaves the backend.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require("crypto");
const cfg = require("../../config/env");

/**
 * Is Midtrans configured (keys present)? When false, payment initiation throws a
 * clear 503 instead of crashing — lets the rest of the app boot on staging
 * before keys are provisioned (PAY-01).
 */
function isConfigured() {
  return Boolean(cfg.MIDTRANS_SERVER_KEY && cfg.MIDTRANS_CLIENT_KEY);
}

// Lazy Snap client — only constructed when actually initiating a payment, so a
// missing SDK / missing keys never breaks module load or unrelated routes.
let _snap = null;
function getSnapClient() {
  if (!isConfigured()) {
    const err = new Error("Payment gateway not configured (MIDTRANS_SERVER_KEY/CLIENT_KEY missing).");
    err.statusCode = 503;
    throw err;
  }
  if (_snap) return _snap;
  const midtransClient = require("midtrans-client");
  _snap = new midtransClient.Snap({
    isProduction: cfg.MIDTRANS_IS_PRODUCTION,
    serverKey:    cfg.MIDTRANS_SERVER_KEY,
    clientKey:    cfg.MIDTRANS_CLIENT_KEY,
  });
  return _snap;
}

/**
 * Create a Snap transaction and return { token, redirect_url }.
 * @param {object} params Midtrans Snap transaction params (transaction_details, etc.)
 * @returns {Promise<{token: string, redirect_url: string}>}
 */
async function createSnapTransaction(params) {
  const snap = getSnapClient();
  return snap.createTransaction(params);
}

/**
 * PURE SHA512 signature verification.
 *
 * Recomputes sha512(order_id + status_code + gross_amount + serverKey) and
 * compares it (timing-safe) against the signature_key Midtrans sent.
 *
 * serverKey is injectable for testing; defaults to the configured one.
 * gross_amount must be passed EXACTLY as Midtrans sends it in the notification
 * (a string like "149000.00") — do not reformat it.
 *
 * @returns {boolean}
 */
function verifySignature({ orderId, statusCode, grossAmount, signatureKey, serverKey = cfg.MIDTRANS_SERVER_KEY }) {
  if (!orderId || !statusCode || grossAmount == null || !signatureKey || !serverKey) return false;
  const payload = `${orderId}${statusCode}${grossAmount}${serverKey}`;
  const expected = crypto.createHash("sha512").update(payload).digest("hex");

  // Timing-safe compare (both hex strings of equal length).
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signatureKey), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * PURE mapping of a Midtrans notification → our internal Payment.status.
 *
 * Midtrans semantics:
 *   - capture + fraud_status=accept           → PAID (card)
 *   - capture + fraud_status=challenge        → CHALLENGE (manual review)
 *   - settlement                              → PAID
 *   - pending                                 → PENDING
 *   - deny / cancel / expire                  → FAILED / EXPIRED
 *   - refund / partial_refund / chargeback    → REFUNDED
 *
 * @param {object} n notification ({ transaction_status, fraud_status })
 * @returns {"PAID"|"PENDING"|"FAILED"|"EXPIRED"|"REFUNDED"|"CHALLENGE"}
 */
function mapTransactionStatus(n) {
  const status = n?.transaction_status;
  const fraud = n?.fraud_status;

  switch (status) {
    case "capture":
      if (fraud === "challenge") return "CHALLENGE";
      if (fraud === "deny") return "FAILED";
      return "PAID"; // accept (or unset)
    case "settlement":
      return "PAID";
    case "pending":
      return "PENDING";
    case "deny":
    case "cancel":
      return "FAILED";
    case "expire":
      return "EXPIRED";
    case "refund":
    case "partial_refund":
    case "chargeback":
      return "REFUNDED";
    default:
      return "PENDING";
  }
}

module.exports = {
  isConfigured,
  getSnapClient,
  createSnapTransaction,
  verifySignature,
  mapTransactionStatus,
};
