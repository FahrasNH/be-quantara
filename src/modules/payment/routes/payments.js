// ─── src/server/routes/payments.js ──────────────────────────────────────────
// Payment endpoints (Sprint 5: PAY-04 webhook + PAY-05 user endpoints).
//
// Exposes two routers:
//   • createPaymentWebhookRouter() — PUBLIC. POST /  (Midtrans → us). Auth is the
//     SHA512 signature, NOT a JWT. Mounted at /api/v1/payments/webhook BEFORE the
//     authed router so it is never gated by authMiddleware.
//   • createPaymentsRouter()       — AUTHED. initiate / status / history / config.
//     Mounted behind authMiddleware → all reads/writes are scoped to req.userId
//     (no IDOR).
// ─────────────────────────────────────────────────────────────────────────────

const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const { asyncHandler } = require("../../../shared/middleware/errorHandler");
const PaymentService = require("../services/PaymentService");
const midtrans = require("../../../infrastructure/payment/midtrans");
const pricing = require("../domain/pricing");
const { getTierConfig, TIER_ORDER } = require("../../../core/risk-engine/tierConfig");
const cfg = require("../../../config/env");

// Tighter limit on payment initiation (PAY-12) — abuse / card-testing guard.
// Keyed per-user (authMiddleware ran first), falls back to IP.
const initiateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ? `pay:${req.userId}` : `pay:ip:${ipKeyGenerator(req.ip)}`,
  message: { ok: false, statusCode: 429, message: "Terlalu banyak percobaan pembayaran. Coba lagi nanti." },
});

// ── PUBLIC webhook router ────────────────────────────────────────────────────
function createPaymentWebhookRouter() {
  const router = express.Router();

  // POST /api/v1/payments/webhook  (Midtrans HTTP notification)
  // Always 200 on a handled notification so Midtrans stops retrying; signature
  // failures return 403 (Midtrans treats non-2xx as retryable, which is correct
  // for transient errors but we deliberately reject forged ones).
  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const result = await PaymentService.handleWebhookNotification(req.body || {}, req.ip);
      res.json(result);
    })
  );

  return router;
}

// ── AUTHED user router ───────────────────────────────────────────────────────
function createPaymentsRouter() {
  const router = express.Router();

  function badRequest(res, message) {
    return res.status(400).json({ ok: false, statusCode: 400, message });
  }

  /**
   * GET /api/v1/payments/config
   * Public-ish Snap config for the frontend (client key + env). Behind auth so
   * only logged-in users fetch it; the client key is non-secret by design.
   */
  router.get("/config", (req, res) => {
    res.json({
      ok: true,
      clientKey: cfg.MIDTRANS_CLIENT_KEY,
      isProduction: cfg.MIDTRANS_IS_PRODUCTION,
      configured: midtrans.isConfigured(),
    });
  });

  /**
   * POST /api/v1/payments/voucher/preview
   * Body: { tier, billingCycle?, voucherCode }
   * Returns the server-side discount quote WITHOUT initiating a payment
   * (PAY-09 checkout shows discount before Snap). Does not reserve the voucher.
   */
  router.post(
    "/voucher/preview",
    asyncHandler(async (req, res) => {
      const { tier, billingCycle = "MONTHLY", voucherCode } = req.body || {};
      if (!tier || !getTierConfig(tier)) return badRequest(res, `tier harus salah satu dari: ${TIER_ORDER.join(", ")}`);
      if (!pricing.BILLING_CYCLES.includes(billingCycle)) return badRequest(res, "billingCycle harus MONTHLY atau YEARLY");
      if (!voucherCode) return badRequest(res, "voucherCode wajib diisi");

      const v = await PaymentService.validateAndApplyVoucher({ code: voucherCode, userId: req.userId, tier, billingCycle });
      res.json({
        ok: true,
        valid: v.valid,
        reason: v.reason,
        grossAmount: v.grossAmount,
        discountAmount: v.discountAmount,
        finalAmount: v.finalAmount,
      });
    })
  );

  /**
   * POST /api/v1/payments/initiate
   * Body: { tier, billingCycle?, voucherCode? }
   * Validates tier, applies+reserves voucher, opens Midtrans Snap. Price is
   * computed server-side — the client cannot send an amount.
   */
  router.post(
    "/initiate",
    initiateLimiter,
    asyncHandler(async (req, res) => {
      const { tier, billingCycle = "MONTHLY", voucherCode = null } = req.body || {};
      if (!tier || !getTierConfig(tier)) return badRequest(res, `tier harus salah satu dari: ${TIER_ORDER.join(", ")}`);
      if (!pricing.BILLING_CYCLES.includes(billingCycle)) return badRequest(res, "billingCycle harus MONTHLY atau YEARLY");

      // Respect the production tier allow-list (e.g. closed beta = FOUNDRY only).
      const allowed = cfg.allowedTiers;
      if (allowed && !allowed.includes(tier)) {
        return res.status(403).json({ ok: false, statusCode: 403, message: `Tier ${tier} tidak tersedia saat ini.` });
      }

      const result = await PaymentService.initiatePayment({
        userId: req.userId, tier, billingCycle, voucherCode, ip: req.ip,
      });
      res.json({ ok: true, ...result });
    })
  );

  /**
   * GET /api/v1/payments/history?page=&pageSize=
   */
  router.get(
    "/history",
    asyncHandler(async (req, res) => {
      const data = await PaymentService.listPayments({
        userId: req.userId, page: req.query.page, pageSize: req.query.pageSize,
      });
      res.json({ ok: true, ...data });
    })
  );

  /**
   * GET /api/v1/payments/:orderId/status
   * User-scoped — only the owner can read a payment's status.
   */
  router.get(
    "/:orderId/status",
    asyncHandler(async (req, res) => {
      const payment = await PaymentService.getPaymentStatus({ userId: req.userId, orderId: req.params.orderId });
      res.json({ ok: true, payment });
    })
  );

  return router;
}

module.exports = { createPaymentsRouter, createPaymentWebhookRouter };
