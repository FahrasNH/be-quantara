// ─── src/server/routes/admin.js ─────────────────────────────────────────────
// Admin-only endpoints for manual tier management.
// BILLING STUB — replaces payment gateway until billing system is built.
// Protect this router with an admin secret header check, not just authMiddleware.

module.exports = function createAdminRouter() {
  const express    = require("express");
  const router     = express.Router();
  const { PrismaClient } = require("@prisma/client");
  const { asyncHandler }  = require("../../middleware/errorHandler");
  const { TIER_ORDER }    = require("../../domain/tierConfig");

  const prisma = new PrismaClient();

  // Simple admin secret check (set ADMIN_SECRET in .env)
  function requireAdminSecret(req, res, next) {
    const secret = process.env.ADMIN_SECRET;
    if (!secret || req.headers["x-admin-secret"] !== secret) {
      return res.status(403).json({ ok: false, statusCode: 403, message: "Forbidden" });
    }
    next();
  }

  /**
   * PUT /api/v1/admin/users/:userId/tier
   * Assign a tier to a user (billing stub — call this after payment confirmed).
   *
   * Body: { tier: "FOUNDRY" | "FORGE" | "MINT" | "VAULT" }
   */
  router.put(
    "/users/:userId/tier",
    requireAdminSecret,
    asyncHandler(async (req, res) => {
      const { userId } = req.params;
      const { tier }   = req.body;

      if (!tier || !TIER_ORDER.includes(tier)) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: `tier harus salah satu dari: ${TIER_ORDER.join(", ")}`,
        });
      }

      const updated = await prisma.userStrategy.upsert({
        where:  { userId },
        update: { tier },
        create: { userId, tier },
      });

      res.json({
        ok:     true,
        userId: updated.userId,
        tier:   updated.tier,
        message: `Tier updated to ${tier}`,
      });
    })
  );

  /**
   * GET /api/v1/admin/users/:userId/tier
   * Get current tier for a user.
   */
  router.get(
    "/users/:userId/tier",
    requireAdminSecret,
    asyncHandler(async (req, res) => {
      const { userId } = req.params;

      const record = await prisma.userStrategy.findUnique({
        where:  { userId },
        select: { tier: true, balanceTier: true, updatedAt: true },
      });

      if (!record) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "User not found" });
      }

      res.json({ ok: true, userId, tier: record.tier, balanceTier: record.balanceTier, updatedAt: record.updatedAt });
    })
  );

  return router;
};
