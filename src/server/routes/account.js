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
   * Get API keys (masked for security)
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
          apiPassphrase: true,
          exchangeType: true,
        },
      });

      const mask = (val) => val ? `${val.substring(0, 4)}****${val.substring(val.length - 4)}` : null;

      res.json({
        ok: true,
        exchangeType: user?.exchangeType || "bitget",
        apiKey: user?.apiKey ? mask(user.apiKey) : null,
        apiSecret: user?.apiSecret ? mask(user.apiSecret) : null,
        apiPassphrase: user?.apiPassphrase ? "****" : null,
        configured: !!(user?.apiKey && user?.apiSecret),
      });
    })
  );

  /**
   * POST /api/v1/account/keys
   * Update API keys — supports Bitget (3 fields) and Binance (2 fields)
   */
  router.post(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { apiKey, apiSecret, apiPassphrase, exchangeType = "bitget" } = req.body;

      if (!apiKey || !apiSecret) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "apiKey and apiSecret are required",
        });
      }

      if (exchangeType === "bitget" && !apiPassphrase) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "Passphrase is required for Bitget",
        });
      }

      await prisma.user.update({
        where: { id: userId },
        data: {
          apiKey,
          apiSecret,
          apiPassphrase: apiPassphrase || null,
          exchangeType,
        },
      });

      res.json({
        ok: true,
        message: `${exchangeType.charAt(0).toUpperCase() + exchangeType.slice(1)} API keys saved`,
        exchangeType,
        configured: true,
      });
    })
  );

  /**
   * DELETE /api/v1/account/keys
   * Remove API keys / disconnect exchange
   */
  router.delete(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      await prisma.user.update({
        where: { id: userId },
        data: {
          apiKey: null,
          apiSecret: null,
          apiPassphrase: null,
          exchangeType: null,
        },
      });

      res.json({
        ok: true,
        message: "Exchange disconnected",
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
