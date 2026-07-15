// ─────────────────────────────────────────────────────────────────────────────
// PaymentService.js — Midtrans payment orchestration (Sprint 5: PAY-03/04/05)
//
// Responsibilities:
//   • initiatePayment()      — validate tier+voucher, RESERVE voucher slot,
//                              create pending Payment, open Midtrans Snap
//   • getPaymentStatus()     — user-scoped status read (no IDOR)
//   • listPayments()         — paginated history (user-scoped)
//   • handleWebhookNotification() — verify SHA512 signature, idempotent status
//                              update, grant Subscription, commit/release voucher
//
// Voucher fraud model (PAY-12): a voucher slot is RESERVED at initiate time via
// an atomic conditional increment (UPDATE ... WHERE currentUses < maxUses). If
// the payment later fails/expires the slot is RELEASED (decrement + delete the
// VoucherUsage). This prevents both over-redemption races and reuse.
//
// Money is always computed server-side (domain/pricing.js). The client cannot
// influence the charged amount or the discount.
// ─────────────────────────────────────────────────────────────────────────────

const prisma = require("../../../infrastructure/db/prismaClient");
const cfg = require("../../../config/env");
const pricing = require("../domain/pricing");
const midtrans = require("../../../infrastructure/payment/midtrans");
const { getTierConfig } = require("../../../core/risk-engine/tierConfig");

const TERMINAL_FAIL = ["FAILED", "EXPIRED"];

// ── Small helpers ────────────────────────────────────────────────────────────

// Generate a unique, human-traceable order id used as Midtrans order_id and as
// our idempotency key. No randomness source that breaks determinism in tests is
// needed here (runtime only).
function generateOrderId(tier) {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `QTR-${tier}-${ts}-${rand}`;
}

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

// Best-effort payment-lifecycle audit trail (never throws into the caller).
async function paymentAudit({ paymentId = null, userId = null, orderId = null, event, detail = null, ip = null }) {
  try {
    await prisma.paymentAuditLog.create({
      data: {
        paymentId, userId, orderId, event,
        detail: detail ? JSON.stringify(detail) : null,
        ipAddress: ip || null,
      },
    });
  } catch (_e) { /* swallow — audit is best-effort */ }
}

// ── Voucher lookup + per-user usage count ────────────────────────────────────

async function findActiveVoucherByCode(code) {
  const norm = normalizeCode(code);
  if (!norm) return null;
  return prisma.voucher.findFirst({
    where: { code: norm, deletedAt: null },
  });
}

async function countUserVoucherUsage(voucherId, userId) {
  return prisma.voucherUsage.count({ where: { voucherId, userId } });
}

/**
 * Validate a voucher for a user against a tier price. Pure math runs in
 * domain/pricing; this layer only supplies DB + clock inputs. Used by the
 * "preview discount before paying" path (PAY-09 checkout) and by initiate.
 *
 * @returns {Promise<{ valid, reason, discountAmount, finalAmount, grossAmount, voucher }>}
 */
async function validateAndApplyVoucher({ code, userId, tier, billingCycle = "MONTHLY" }) {
  const grossAmount = pricing.getTierPrice(tier, billingCycle);
  const voucher = await findActiveVoucherByCode(code);

  if (!voucher) {
    return { valid: false, reason: "VOUCHER_NOT_FOUND", discountAmount: 0, finalAmount: grossAmount, grossAmount, voucher: null };
  }

  const userUsageCount = await countUserVoucherUsage(voucher.id, userId);
  const result = pricing.validateVoucher({
    voucher, grossAmount, tier, now: new Date(), userUsageCount,
  });

  return { ...result, grossAmount, voucher };
}

// ── PAY-03/05: initiate ──────────────────────────────────────────────────────

/**
 * Initiate a payment: validate, reserve voucher, create pending Payment, open
 * a Midtrans Snap transaction. Returns the snapToken for the frontend.
 *
 * @param {{ userId, tier, billingCycle?, voucherCode?, ip? }} args
 * @returns {Promise<{ orderId, snapToken, snapRedirectUrl, grossAmount, discountAmount, finalAmount, voucherApplied }>}
 */
async function initiatePayment({ userId, tier, billingCycle = "MONTHLY", voucherCode = null, ip = null }) {
  // ── Validate tier + cycle (throws 400 on bad input) ──
  if (!getTierConfig(tier)) {
    const err = new Error(`Unknown tier: ${tier}`); err.statusCode = 400; throw err;
  }
  if (!pricing.BILLING_CYCLES.includes(billingCycle)) {
    const err = new Error(`Unknown billing cycle: ${billingCycle}`); err.statusCode = 400; throw err;
  }

  const grossAmount = pricing.getTierPrice(tier, billingCycle);

  // ── Validate + RESERVE voucher (atomic) ──
  let voucher = null;
  let discountAmount = 0;
  if (voucherCode) {
    const v = await validateAndApplyVoucher({ code: voucherCode, userId, tier, billingCycle });
    if (!v.valid) {
      const err = new Error(`Voucher tidak valid: ${v.reason}`);
      err.statusCode = 422; err.code = v.reason;
      throw err;
    }
    voucher = v.voucher;
    discountAmount = v.discountAmount;

    // Atomic reservation: only succeed if there is still a slot left.
    if (voucher.maxUses != null) {
      const reserved = await prisma.voucher.updateMany({
        where: { id: voucher.id, isActive: true, deletedAt: null, currentUses: { lt: voucher.maxUses } },
        data:  { currentUses: { increment: 1 } },
      });
      if (reserved.count !== 1) {
        const err = new Error("Voucher sudah habis terpakai.");
        err.statusCode = 422; err.code = "VOUCHER_USAGE_LIMIT_REACHED";
        throw err;
      }
    } else {
      await prisma.voucher.update({ where: { id: voucher.id }, data: { currentUses: { increment: 1 } } });
    }
  }

  const finalAmount = Math.max(0, grossAmount - discountAmount);
  const orderId = generateOrderId(tier);

  // ── Create pending Payment + reserve the VoucherUsage row ──
  let payment;
  try {
    payment = await prisma.$transaction(async (tx) => {
      const p = await tx.payment.create({
        data: {
          userId, orderId, tier, billingCycle,
          grossAmount, discountAmount, finalAmount,
          voucherId: voucher?.id ?? null,
          voucherCode: voucher?.code ?? null,
          status: "PENDING",
        },
      });
      if (voucher) {
        await tx.voucherUsage.create({
          data: { voucherId: voucher.id, userId, paymentId: p.id, discountApplied: discountAmount },
        });
      }
      return p;
    });
  } catch (e) {
    // Roll back the voucher reservation if Payment creation failed.
    if (voucher) await releaseVoucher(voucher.id).catch(() => {});
    throw e;
  }

  await paymentAudit({ paymentId: payment.id, userId, orderId, event: "INITIATED", ip,
    detail: { tier, billingCycle, grossAmount, discountAmount, finalAmount, voucher: voucher?.code ?? null } });

  // ── Open Midtrans Snap (network) — outside the DB transaction ──
  try {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, username: true } });
    const snap = await midtrans.createSnapTransaction({
      transaction_details: { order_id: orderId, gross_amount: finalAmount },
      item_details: [{
        id: `${tier}-${billingCycle}`,
        price: finalAmount,
        quantity: 1,
        name: `Quantara ${getTierConfig(tier)?.label ?? tier} (${billingCycle.toLowerCase()})`,
      }],
      customer_details: { first_name: user?.username || "User", email: user?.email },
      credit_card: { secure: true },
    });

    const updated = await prisma.payment.update({
      where: { id: payment.id },
      data: { snapToken: snap.token, snapRedirectUrl: snap.redirect_url },
    });

    return {
      orderId,
      snapToken: updated.snapToken,
      snapRedirectUrl: updated.snapRedirectUrl,
      clientKey: cfg.MIDTRANS_CLIENT_KEY,
      grossAmount, discountAmount, finalAmount,
      voucherApplied: voucher?.code ?? null,
    };
  } catch (e) {
    // Snap failed → mark payment FAILED and release the voucher slot.
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED" } }).catch(() => {});
    if (voucher) await releaseVoucherForPayment(payment.id, voucher.id).catch(() => {});
    await paymentAudit({ paymentId: payment.id, userId, orderId, event: "SNAP_FAILED", detail: { message: e.message } });
    if (!e.statusCode) e.statusCode = 502;
    throw e;
  }
}

// Release a reserved voucher slot (decrement, floor 0).
async function releaseVoucher(voucherId) {
  await prisma.voucher.updateMany({
    where: { id: voucherId, currentUses: { gt: 0 } },
    data:  { currentUses: { decrement: 1 } },
  });
}

// Release voucher slot tied to a specific (failed) payment: delete the usage row
// + decrement. Safe to call multiple times (delete is a no-op the 2nd time).
async function releaseVoucherForPayment(paymentId, voucherId) {
  const deleted = await prisma.voucherUsage.deleteMany({ where: { paymentId } });
  if (deleted.count > 0) await releaseVoucher(voucherId);
}

// ── PAY-05: status + history (user-scoped, no IDOR) ──────────────────────────

async function getPaymentStatus({ userId, orderId }) {
  const p = await prisma.payment.findFirst({
    where: { orderId, userId },
    select: {
      orderId: true, tier: true, billingCycle: true, status: true,
      grossAmount: true, discountAmount: true, finalAmount: true,
      voucherCode: true, paymentType: true, paidAt: true, createdAt: true,
    },
  });
  if (!p) { const err = new Error("Payment not found"); err.statusCode = 404; throw err; }
  return p;
}

async function listPayments({ userId, page = 1, pageSize = 20 }) {
  const take = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * take;

  const [total, items] = await Promise.all([
    prisma.payment.count({ where: { userId } }),
    prisma.payment.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip, take,
      select: {
        orderId: true, tier: true, billingCycle: true, status: true,
        grossAmount: true, discountAmount: true, finalAmount: true,
        voucherCode: true, paymentType: true, paidAt: true, createdAt: true,
      },
    }),
  ]);

  return { items, page: Math.max(parseInt(page, 10) || 1, 1), pageSize: take, total, totalPages: Math.ceil(total / take) };
}

// ── PAY-04: webhook ──────────────────────────────────────────────────────────

/**
 * Process a Midtrans webhook notification.
 *
 * Steps (in order — each is a security gate):
 *   1. Verify SHA512 signature → reject (403) if invalid.
 *   2. Load the Payment by order_id → 404 if unknown.
 *   3. Idempotency: if already in the same terminal state, no-op.
 *   4. Update Payment status from the notification.
 *   5. On first transition to PAID → grant Subscription (idempotent).
 *      On FAILED/EXPIRED → release any reserved voucher slot.
 *
 * @returns {Promise<{ ok: boolean, status: string, idempotent?: boolean }>}
 */
async function handleWebhookNotification(notification, ip = null) {
  const orderId = notification?.order_id;
  const statusCode = notification?.status_code;
  const grossAmount = notification?.gross_amount;
  const signatureKey = notification?.signature_key;

  // 1. Signature verification (PAY-12). Trust nothing before this passes.
  const sigOk = midtrans.verifySignature({ orderId, statusCode, grossAmount, signatureKey });
  if (!sigOk) {
    await paymentAudit({ orderId, event: "SIGNATURE_INVALID", ip, detail: { statusCode } });
    const err = new Error("Invalid signature"); err.statusCode = 403; throw err;
  }

  // 2. Load payment.
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment) {
    await paymentAudit({ orderId, event: "WEBHOOK_UNKNOWN_ORDER", ip });
    const err = new Error("Payment not found"); err.statusCode = 404; throw err;
  }

  const newStatus = midtrans.mapTransactionStatus(notification);
  await paymentAudit({ paymentId: payment.id, userId: payment.userId, orderId, event: "WEBHOOK_RECEIVED", ip,
    detail: { transaction_status: notification.transaction_status, fraud_status: notification.fraud_status, mapped: newStatus } });

  // 3. Idempotency: already settled to PAID, or already in this terminal state.
  if (payment.status === "PAID" && newStatus === "PAID") {
    await paymentAudit({ paymentId: payment.id, userId: payment.userId, orderId, event: "DUPLICATE_WEBHOOK", ip });
    return { ok: true, status: "PAID", idempotent: true };
  }
  if (payment.status === newStatus) {
    return { ok: true, status: newStatus, idempotent: true };
  }

  // 4. Persist the new payment status + Midtrans metadata (no card data).
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: newStatus,
      midtransTransactionId: notification.transaction_id || payment.midtransTransactionId,
      paymentType: notification.payment_type || payment.paymentType,
      fraudStatus: notification.fraud_status || payment.fraudStatus,
      paidAt: newStatus === "PAID" ? new Date() : payment.paidAt,
      rawNotification: JSON.stringify(redactNotification(notification)),
    },
  });

  // 5. Side effects by outcome.
  if (newStatus === "PAID") {
    await grantSubscription(payment, ip);
  } else if (TERMINAL_FAIL.includes(newStatus) && payment.voucherId) {
    await releaseVoucherForPayment(payment.id, payment.voucherId);
    await paymentAudit({ paymentId: payment.id, userId: payment.userId, orderId, event: "VOUCHER_RELEASED", ip });
  }

  return { ok: true, status: newStatus };
}

/**
 * Grant (or extend) the subscription for a paid payment. Idempotent: a second
 * call for the same payment finds the existing Subscription and does nothing.
 */
async function grantSubscription(payment, ip = null) {
  const existing = await prisma.subscription.findFirst({ where: { paymentId: payment.id } });
  if (existing) {
    await paymentAudit({ paymentId: payment.id, userId: payment.userId, orderId: payment.orderId, event: "SUBSCRIPTION_ALREADY_GRANTED", ip });
    return existing;
  }

  const start = new Date();
  const end = pricing.computeEndDate(start, payment.billingCycle);

  const sub = await prisma.$transaction(async (tx) => {
    // Expire any currently-active subscription before activating the new tier.
    await tx.subscription.updateMany({
      where: { userId: payment.userId, status: "ACTIVE" },
      data:  { status: "EXPIRED" },
    });
    const created = await tx.subscription.create({
      data: {
        userId: payment.userId, tier: payment.tier, status: "ACTIVE",
        billingCycle: payment.billingCycle, startDate: start, endDate: end,
        paymentId: payment.id,
      },
    });
    // Keep the legacy UserStrategy.tier in sync so existing entitlement reads
    // (bot gating, strategy selector) stay correct during the transition.
    await tx.userStrategy.upsert({
      where: { userId: payment.userId },
      update: { tier: payment.tier },
      create: { userId: payment.userId, tier: payment.tier },
    });
    return created;
  });

  await paymentAudit({ paymentId: payment.id, userId: payment.userId, orderId: payment.orderId,
    event: "SUBSCRIPTION_CREATED", ip, detail: { tier: payment.tier, endDate: end.toISOString() } });

  // Best-effort receipt email — never blocks the webhook ack.
  try {
    const EmailService = require("../../auth/services/EmailService");
    if (typeof EmailService.sendSubscriptionActivated === "function") {
      const user = await prisma.user.findUnique({ where: { id: payment.userId }, select: { email: true, username: true } });
      if (user?.email) {
        await EmailService.sendSubscriptionActivated(user.email, {
          username: user.username, tier: payment.tier,
          billingCycle: payment.billingCycle, endDate: end, finalAmount: payment.finalAmount,
        });
      }
    }
  } catch (_e) { /* email best-effort */ }

  return sub;
}

// Strip any potentially sensitive / bulky fields before persisting the raw
// notification. Midtrans Snap never sends PAN, but be defensive (PAY-12: no card
// data logged).
function redactNotification(n) {
  if (!n || typeof n !== "object") return {};
  const { signature_key, ...rest } = n; // drop the signature secret-derived value
  return rest;
}

module.exports = {
  initiatePayment,
  getPaymentStatus,
  listPayments,
  handleWebhookNotification,
  validateAndApplyVoucher,
  grantSubscription,
  // exported for tests / admin tooling
  generateOrderId,
  normalizeCode,
  releaseVoucherForPayment,
};
