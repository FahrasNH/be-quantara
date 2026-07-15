// ─── src/server/routes/subscription.js ──────────────────────────────────────
// User-facing tier (subscription) management.
// Mounted behind authMiddleware → operates on req.userId only (no IDOR).
//
// NOTE: payment gateway is stubbed. Subscribing simply sets the tier; in
// production an upgrade must go through billing before this is called. The
// billing webhook would hit POST /admin/users/:id/tier instead of this route.

module.exports = function createSubscriptionRouter() {
  const express = require("express");
  const router  = express.Router();
  const { asyncHandler } = require("../../../shared/middleware/errorHandler");
  const { listTiers, getTierConfig, TIER_ORDER } = require("../../../core/risk-engine/tierConfig");
  const { getUserTier } = require("../../users/services/entitlement");
  const AuthService = require("../../auth/services/AuthService");
  const cfg = require("../../../config/env");

  // PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
  const prisma = require("../../../infrastructure/db/prismaClient");

  const FREE_TIER = "FOUNDRY"; // lowest tier — unsubscribe drops here

  /**
   * GET /api/v1/subscription
   * Current tier + entitlements + all plans (for the pricing/upgrade UI).
   */
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const tier   = await getUserTier(req.userId);
      const config = getTierConfig(tier);

      // Filter plans to allowed tiers only (production: FOUNDRY only)
      const allowedTiers = cfg.allowedTiers;
      const plans = allowedTiers
        ? listTiers().filter(t => allowedTiers.includes(t.key))
        : listTiers();

      res.json({
        ok: true,
        current: {
          tier,
          label:        config?.label ?? tier,
          price:        config?.price ?? 0,
          strategies:   config?.strategies ?? [],
          maxPositions: config?.maxPositions ?? 1,
          autoSelector: config?.autoSelector ?? false,
          aiOptimizer:  config?.aiOptimizer ?? false,
          supportSLA:   config?.supportSLA ?? null,
        },
        plans,
      });
    })
  );

  /**
   * POST /api/v1/subscription/subscribe
   * Body: { tier }
   * Change to a paid tier. Stubbed — no payment processed here yet.
   */
  router.post(
    "/subscribe",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { tier } = req.body;

      if (!tier || !TIER_ORDER.includes(tier)) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: `tier harus salah satu dari: ${TIER_ORDER.join(", ")}`,
        });
      }

      // Block upgrade to tiers not available in this environment
      const allowedTiers = cfg.allowedTiers;
      if (allowedTiers && !allowedTiers.includes(tier)) {
        return res.status(403).json({
          ok: false,
          statusCode: 403,
          message: `Tier ${tier} tidak tersedia saat ini. Hubungi support untuk informasi lebih lanjut.`,
        });
      }

      const currentTier = await getUserTier(userId);
      if (currentTier === tier) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: `Kamu sudah berada di tier ${tier}.`,
        });
      }

      // TODO(billing): proses pembayaran sebelum baris ini saat gateway aktif.

      const updated = await prisma.userStrategy.upsert({
        where:  { userId },
        update: { tier },
        create: { userId, tier },
      });

      await AuthService.logAction(
        userId,
        "TIER_CHANGE",
        "subscription",
        tier,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        tier: updated.tier,
        previousTier: currentTier,
        message: `Berhasil pindah ke tier ${tier}.`,
      });
    })
  );

  /**
   * POST /api/v1/subscription/unsubscribe
   * Cancel paid plan → drop back to the free tier (FOUNDRY).
   */
  router.post(
    "/unsubscribe",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const currentTier = await getUserTier(userId);

      if (currentTier === FREE_TIER) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: `Kamu sudah di tier dasar (${FREE_TIER}), tidak ada langganan untuk dibatalkan.`,
        });
      }

      const updated = await prisma.userStrategy.upsert({
        where:  { userId },
        update: { tier: FREE_TIER },
        create: { userId, tier: FREE_TIER },
      });

      await AuthService.logAction(
        userId,
        "TIER_UNSUBSCRIBE",
        "subscription",
        currentTier,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        tier: updated.tier,
        previousTier: currentTier,
        message: `Langganan ${currentTier} dibatalkan. Sekarang di tier ${FREE_TIER}.`,
      });
    })
  );

  return router;
};
