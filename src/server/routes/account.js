const { asyncHandler } = require("../../middleware/errorHandler");
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

module.exports = function createAccountRouter() {
  const express = require("express");
  const router = express.Router();

  /**
   * GET /api/v1/account/balance
   * Get total account balance
   */
  router.get(
    "/balance",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      const bots = await prisma.bot.findMany({
        where: { userId },
        select: { capital: true, dryRun: true, running: true },
      });

      let totalBalance = 0;
      for (const bot of bots) {
        totalBalance += bot.capital || 0;
      }

      res.json({
        ok: true,
        balance: totalBalance,
        currency: "USDT",
        activeBots: bots.filter(b => b.running).length,
        totalBots: bots.length,
      });
    })
  );

  /**
   * GET /api/v1/account/keys
   * Get API keys
   */
  router.get(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          apiKey: true,
          apiSecret: true,
        },
      });

      res.json({
        ok: true,
        apiKey: user?.apiKey || null,
        apiSecret: user?.apiSecret || null,
        configured: !!(user?.apiKey && user?.apiSecret),
      });
    })
  );

  /**
   * POST /api/v1/account/keys
   * Update API keys
   */
  router.post(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { apiKey, apiSecret } = req.body;

      if (!apiKey || !apiSecret) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "apiKey and apiSecret required",
        });
      }

      // TODO: Encrypt API keys before storing (use libsodium or similar)
      // For now, storing as-is (not secure for production)

      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          apiKey,
          apiSecret,
        },
        select: {
          id: true,
          email: true,
          username: true,
        },
      });

      res.json({
        ok: true,
        message: "API keys updated",
        user,
      });
    })
  );

  /**
   * GET /api/v1/account/strategy
   * Get user's active strategy
   */
  router.get(
    "/strategy",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      const strategy = await prisma.userStrategy.findUnique({
        where: { userId },
      });

      if (!strategy) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Strategy not configured",
        });
      }

      res.json({
        ok: true,
        strategy,
      });
    })
  );

  /**
   * POST /api/v1/account/strategy
   * Update user's active strategy
   */
  router.post(
    "/strategy",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { strategyKey, riskPerTrade, maxOpenPositions, leverage } = req.body;

      if (!strategyKey) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "strategyKey required",
        });
      }

      const strategy = await prisma.userStrategy.update({
        where: { userId },
        data: {
          strategyKey,
          ...(riskPerTrade && { riskPerTrade }),
          ...(maxOpenPositions && { maxOpenPositions }),
          ...(leverage && { leverage }),
        },
      });

      res.json({
        ok: true,
        message: "Strategy updated",
        strategy,
      });
    })
  );

  return router;
};
