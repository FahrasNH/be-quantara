#!/usr/bin/env node
/**
 * seed-payment.js — Seed the Payment & Voucher System (Sprint 5 / PAY-02).
 *
 * Idempotent (upserts by unique key):
 *   - 4 SubscriptionTier rows (FOUNDRY/FORGE/MINT/VAULT) mirrored from
 *     core/risk-engine/tierConfig.js + modules/payment/domain/pricing.js (IDR prices).
 *   - 2 sample vouchers: WELCOME10 (10% off, max Rp100k) and LAUNCH50K
 *     (Rp50k off, min purchase Rp149k).
 *
 * Usage:
 *   node scripts/seed-payment.js
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const prisma = require("../src/infrastructure/db/prismaClient");
const { TIER_ORDER, TIER_CONFIG } = require("#core/risk-engine/tierConfig.js");
const { TIER_PRICING_IDR, YEARLY_MONTHS } = require("#modules/payment/domain/pricing.js");

async function seedTiers() {
  let n = 0;
  for (let i = 0; i < TIER_ORDER.length; i++) {
    const key = TIER_ORDER[i];
    const c = TIER_CONFIG[key];
    const monthly = TIER_PRICING_IDR[key];
    const data = {
      label:        c.label,
      priceMonthly: monthly,
      priceYearly:  monthly * YEARLY_MONTHS,
      strategies:   c.strategies,
      maxPositions: c.maxPositions,
      features: {
        autoSelector: c.autoSelector,
        aiOptimizer:  c.aiOptimizer,
        supportSLA:   c.supportSLA,
        capitalRange: c.capitalRange,
      },
      badge:    c.badge ?? null,
      sortOrder: i,
      isActive: true,
    };
    await prisma.subscriptionTier.upsert({
      where:  { key },
      update: data,
      create: { key, ...data },
    });
    n++;
  }
  return n;
}

async function seedVouchers() {
  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  const vouchers = [
    {
      code: "WELCOME10",
      description: "10% off for new subscribers (max Rp100.000)",
      type: "PERCENT",
      value: 10,
      maxDiscount: 100_000,
      minPurchase: 0,
      maxUses: 1000,
      maxUsesPerUser: 1,
      applicableTiers: [],
      validFrom: now,
      validUntil: oneYear,
      isActive: true,
    },
    {
      code: "LAUNCH50K",
      description: "Rp50.000 off (min purchase Rp149.000)",
      type: "FIXED",
      value: 50_000,
      minPurchase: 149_000,
      maxUses: 500,
      maxUsesPerUser: 1,
      applicableTiers: [],
      validFrom: now,
      validUntil: oneYear,
      isActive: true,
    },
  ];

  let n = 0;
  for (const v of vouchers) {
    await prisma.voucher.upsert({
      where:  { code: v.code },
      update: { ...v },
      create: { ...v },
    });
    n++;
  }
  return n;
}

async function main() {
  const tiers = await seedTiers();
  const vouchers = await seedVouchers();
  console.log(`✓ Seeded ${tiers} subscription tiers and ${vouchers} sample vouchers.`);
}

main()
  .catch((err) => { console.error("✗ seed-payment failed:", err.message); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
