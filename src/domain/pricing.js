// ─────────────────────────────────────────────────────────────────────────────
// pricing.js — Billing price table + PURE voucher/discount math (Sprint 5)
//
// This is the SERVER-SIDE source of truth for how much a tier costs and how much
// a voucher discounts. Every amount is computed here from trusted inputs — the
// client never sends a price or a discount. Keeping the math pure (no DB, no
// clock) makes it fully unit-testable; the PaymentService layer feeds it data
// fetched from the DB and the current time.
//
// Amounts are in IDR (rupiah, integer) because Midtrans charges in IDR.
// Entitlement (which strategies a tier unlocks) still lives in tierConfig.js;
// this file only owns money.
// ─────────────────────────────────────────────────────────────────────────────

const { TIER_ORDER } = require("./tierConfig");

// Monthly price per tier, IDR. Yearly = monthly × 10 (i.e. 2 months free).
// These feed both the SubscriptionTier seed and every Payment.grossAmount.
const TIER_PRICING_IDR = {
  FOUNDRY: 149_000,
  FORGE:   399_000,
  MINT:    899_000,
  VAULT:   1_599_000,
};

const YEARLY_MONTHS = 10; // pay for 10 months, get 12
const BILLING_CYCLES = ["MONTHLY", "YEARLY"];

const VOUCHER_TYPES = ["PERCENT", "FIXED"];

/**
 * Price (IDR) for a tier + billing cycle. Throws on unknown tier/cycle so a bad
 * request can never silently resolve to 0.
 * @param {string} tier
 * @param {"MONTHLY"|"YEARLY"} billingCycle
 * @returns {number} integer IDR
 */
function getTierPrice(tier, billingCycle = "MONTHLY") {
  const monthly = TIER_PRICING_IDR[tier];
  if (monthly == null) throw new Error(`Unknown tier: ${tier}`);
  if (!BILLING_CYCLES.includes(billingCycle)) {
    throw new Error(`Unknown billing cycle: ${billingCycle}`);
  }
  return billingCycle === "YEARLY" ? monthly * YEARLY_MONTHS : monthly;
}

/**
 * Subscription period length in days for a billing cycle.
 * @param {"MONTHLY"|"YEARLY"} billingCycle
 * @returns {number}
 */
function getPeriodDays(billingCycle = "MONTHLY") {
  return billingCycle === "YEARLY" ? 365 : 30;
}

/**
 * Compute endDate given a start date + billing cycle. Pure — start passed in.
 * @param {Date} start
 * @param {"MONTHLY"|"YEARLY"} billingCycle
 * @returns {Date}
 */
function computeEndDate(start, billingCycle = "MONTHLY") {
  const ms = getPeriodDays(billingCycle) * 24 * 60 * 60 * 1000;
  return new Date(start.getTime() + ms);
}

/**
 * PURE voucher validation + discount computation.
 *
 * All DB/clock-dependent inputs are passed in explicitly so this function stays
 * deterministic and testable:
 *   - voucher: the row as stored (or a plain object); null/undefined → invalid
 *   - grossAmount: tier price in IDR (integer)
 *   - tier: the tier being purchased (for applicableTiers check)
 *   - now: current Date (caller passes new Date())
 *   - userUsageCount: how many times THIS user already used this voucher
 *
 * @returns {{ valid: boolean, reason: string|null, discountAmount: number, finalAmount: number }}
 */
function validateVoucher({ voucher, grossAmount, tier, now, userUsageCount = 0 }) {
  const fail = (reason) => ({ valid: false, reason, discountAmount: 0, finalAmount: grossAmount });

  if (!voucher) return fail("VOUCHER_NOT_FOUND");
  if (voucher.deletedAt) return fail("VOUCHER_NOT_FOUND");
  if (voucher.isActive === false) return fail("VOUCHER_INACTIVE");

  const ts = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (voucher.validFrom && ts < new Date(voucher.validFrom).getTime()) return fail("VOUCHER_NOT_YET_VALID");
  if (voucher.validUntil && ts > new Date(voucher.validUntil).getTime()) return fail("VOUCHER_EXPIRED");

  // Global usage cap (null = unlimited).
  if (voucher.maxUses != null && voucher.currentUses >= voucher.maxUses) {
    return fail("VOUCHER_USAGE_LIMIT_REACHED");
  }
  // Per-user cap.
  if (voucher.maxUsesPerUser != null && userUsageCount >= voucher.maxUsesPerUser) {
    return fail("VOUCHER_ALREADY_USED");
  }

  // Tier restriction (empty array = all tiers).
  const applicable = Array.isArray(voucher.applicableTiers) ? voucher.applicableTiers : [];
  if (applicable.length > 0 && !applicable.includes(tier)) {
    return fail("VOUCHER_NOT_APPLICABLE_TO_TIER");
  }

  // Minimum purchase.
  if (voucher.minPurchase && grossAmount < voucher.minPurchase) {
    return fail("VOUCHER_MIN_PURCHASE_NOT_MET");
  }

  const discountAmount = computeDiscount(voucher, grossAmount);
  if (discountAmount <= 0) return fail("VOUCHER_NO_DISCOUNT");

  return {
    valid: true,
    reason: null,
    discountAmount,
    finalAmount: Math.max(0, grossAmount - discountAmount),
  };
}

/**
 * PURE discount amount (IDR, integer) for a voucher against a gross amount.
 * Caps a PERCENT voucher at maxDiscount, and never exceeds grossAmount.
 * @param {object} voucher
 * @param {number} grossAmount
 * @returns {number}
 */
function computeDiscount(voucher, grossAmount) {
  if (!voucher || !VOUCHER_TYPES.includes(voucher.type)) return 0;

  let discount;
  if (voucher.type === "PERCENT") {
    const pct = Math.max(0, Math.min(100, Number(voucher.value) || 0));
    discount = Math.floor((grossAmount * pct) / 100);
    if (voucher.maxDiscount != null) discount = Math.min(discount, voucher.maxDiscount);
  } else {
    // FIXED
    discount = Math.floor(Number(voucher.value) || 0);
  }

  // Never discount below zero / above the price.
  return Math.max(0, Math.min(discount, grossAmount));
}

/**
 * Full server-side price quote for a tier + cycle + optional pre-fetched voucher.
 * @returns {{ tier, billingCycle, grossAmount, discountAmount, finalAmount, voucher: {valid,reason}|null }}
 */
function quote({ tier, billingCycle = "MONTHLY", voucher = null, now = new Date(), userUsageCount = 0 }) {
  const grossAmount = getTierPrice(tier, billingCycle);

  if (!voucher) {
    return { tier, billingCycle, grossAmount, discountAmount: 0, finalAmount: grossAmount, voucher: null };
  }

  const v = validateVoucher({ voucher, grossAmount, tier, now, userUsageCount });
  return {
    tier,
    billingCycle,
    grossAmount,
    discountAmount: v.discountAmount,
    finalAmount: v.finalAmount,
    voucher: { valid: v.valid, reason: v.reason, code: voucher.code ?? null },
  };
}

module.exports = {
  TIER_PRICING_IDR,
  YEARLY_MONTHS,
  BILLING_CYCLES,
  VOUCHER_TYPES,
  TIER_ORDER,
  getTierPrice,
  getPeriodDays,
  computeEndDate,
  validateVoucher,
  computeDiscount,
  quote,
};
