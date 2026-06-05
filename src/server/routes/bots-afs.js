// Updated bots-afs.js to use passed-in helper functions and support userId filtering

module.exports = function createBotsRouter(helpers) {
  const { getBot, getAllBots, createBotInstance } = helpers;
  const express = require("express");
  const router = express.Router();
  const { asyncHandler } = require("../../middleware/errorHandler");
  const { validateBotStartInput, validateSymbolParam } = require("../../middleware/validation");
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const AuthService = require("../../services/AuthService");

  /**
   * GET /api/v1/bots
   * List all bots for current user
   */
  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      const bots = await prisma.bot.findMany({
        where: { userId },
        select: {
          id: true,
          symbol: true,
          capital: true,
          strategyKey: true,
          dryRun: true,
          running: true,
          startedAt: true,
          totalTrades: true,
          winningTrades: true,
          losingTrades: true,
        },
      });

      res.json({
        ok: true,
        count: bots.length,
        bots,
      });
    })
  );

  /**
   * GET /api/v1/bots/:symbol
   * Get bot status
   */
  router.get(
    "/:symbol",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      const bot = await prisma.bot.findUnique({
        where: {
          userId_symbol: { userId, symbol },
        },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      const instance = getBot(symbol);
      const state = instance ? instance.getState() : {};

      res.json({
        ok: true,
        symbol,
        config: bot,
        state,
        running: bot.running,
      });
    })
  );

  /**
   * POST /api/v1/bots/:symbol/start
   * Start a bot
   */
  router.post(
    "/:symbol/start",
    validateSymbolParam,
    validateBotStartInput,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const { strategyKey = "ADAPTIVE_FUSION", capital, dryRun } = req.body;

      // Check if bot exists for this user
      let bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      // Create if doesn't exist
      if (!bot) {
        bot = await prisma.bot.create({
          data: {
            userId,
            symbol,
            capital: capital || 500,
            strategyKey,
            dryRun: dryRun !== false,
          },
        });
      } else {
        // Update existing
        bot = await prisma.bot.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            capital: capital || bot.capital,
            strategyKey: strategyKey || bot.strategyKey,
            running: true,
            startedAt: new Date(),
          },
        });
      }

      // Create or get bot instance
      const instance = createBotInstance(symbol, {
        capital: bot.capital,
        strategyKey: bot.strategyKey,
        dryRun: bot.dryRun,
      });

      if (!instance.isRunning()) {
        instance.start();
      }

      // Log action
      await AuthService.logAction(
        userId,
        "BOT_START",
        "bot",
        bot.id,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        message: `Bot ${symbol} started`,
        symbol,
        config: bot,
      });
    })
  );

  /**
   * POST /api/v1/bots/:symbol/stop
   * Stop a bot
   */
  router.post(
    "/:symbol/stop",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      // Stop instance if running
      const instance = getBot(symbol);
      if (instance && instance.isRunning()) {
        instance.stop();
      }

      // Update DB
      await prisma.bot.update({
        where: { userId_symbol: { userId, symbol } },
        data: {
          running: false,
          stoppedAt: new Date(),
        },
      });

      // Log action
      await AuthService.logAction(
        userId,
        "BOT_STOP",
        "bot",
        bot.id,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        message: `Bot ${symbol} stopped`,
        symbol,
      });
    })
  );

  /**
   * POST /api/v1/bots/:symbol/strategy
   * Change bot strategy
   */
  router.post(
    "/:symbol/strategy",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const { strategyKey } = req.body;

      if (!strategyKey || typeof strategyKey !== "string") {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "strategyKey required",
        });
      }

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      // Update strategy in DB
      const updated = await prisma.bot.update({
        where: { userId_symbol: { userId, symbol } },
        data: { strategyKey },
      });

      // Update instance if running
      const instance = getBot(symbol);
      if (instance) {
        instance.config.strategyKey = strategyKey;
      }

      // Log action
      await AuthService.logAction(
        userId,
        "STRATEGY_CHANGE",
        "bot",
        bot.id,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        message: `Strategy changed to ${strategyKey}`,
        symbol,
        strategyKey,
      });
    })
  );

  /**
   * GET /api/v1/bots/:symbol/balance
   * Get balance for a bot
   */
  router.get(
    "/:symbol/balance",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      const instance = getBot(symbol);

      if (bot.dryRun || !instance) {
        return res.json({
          ok: true,
          symbol,
          balance: bot.capital,
          dryRun: true,
          available: bot.capital,
          equity: bot.capital,
        });
      }

      try {
        const balance = await instance.client.getBalance(instance.config.marginCoin);
        res.json({
          ok: true,
          symbol,
          ...balance,
        });
      } catch (err) {
        res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "Failed to fetch balance",
          error: err.message,
        });
      }
    })
  );

  /**
   * GET /api/v1/bots/:symbol/position-conflicts
   * Get position conflicts (FIXED - should not always warn)
   */
  router.get(
    "/:symbol/position-conflicts",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      const instance = getBot(symbol);
      if (!instance) {
        return res.json({
          ok: true,
          symbol,
          allowed: true,
          reason: "No conflicts detected",
          totalOpen: 0,
          maxTotal: 5,
          symbolPositions: 0,
          maxPerSymbol: 1,
        });
      }

      // Get actual conflicts from instance
      const conflicts = instance.getPositionConflicts?.() || {
        allowed: true,
        reason: "Position can be opened",
        totalOpen: 0,
        maxTotal: 5,
        symbolPositions: 0,
        maxPerSymbol: 1,
      };

      res.json({
        ok: true,
        symbol,
        ...conflicts,
      });
    })
  );

  /**
   * GET /api/v1/bots/:symbol/logs
   * Get bot logs
   */
  router.get(
    "/:symbol/logs",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 100, 1000);

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      if (!bot) {
        return res.status(404).json({
          ok: false,
          statusCode: 404,
          message: "Bot not found",
        });
      }

      // Get logs from DB (pagination coming in PHASE 2)
      const logs = await prisma.botLog.findMany({
        where: { botId: bot.id },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      res.json({
        ok: true,
        symbol,
        count: logs.length,
        logs,
      });
    })
  );

  /**
   * GET /api/v1/bots/strategies/available
   * List available strategies
   */
  router.get("/strategies/available", (req, res) => {
    res.json({
      ok: true,
      strategies: [
        {
          value: "ADAPTIVE_FUSION",
          label: "Adaptive Fusion Strategy",
          description: "Market-aware system combining 3 sub-strategies",
        },
        // Future strategies to add here
      ],
    });
  });

  /**
   * GET /api/v1/bots/strategies/info/:strategyKey
   * Get strategy info
   */
  router.get("/strategies/info/:key", (req, res) => {
    const { key } = req.params;

    const strategies = {
      ADAPTIVE_FUSION: {
        name: "ADAPTIVE_FUSION",
        label: "Adaptive Fusion Strategy",
        description: "Market-aware system combining Scalping (A), Day Trading (B), and Swing Trading (C)",
        components: [
          { key: "A", name: "Aggressive Scalping", minBalance: 500 },
          { key: "B", name: "Day Trading", minBalance: 50 },
          { key: "C", name: "Swing Trading", minBalance: 0 },
        ],
      },
    };

    if (!strategies[key]) {
      return res.status(404).json({
        ok: false,
        statusCode: 404,
        message: "Strategy not found",
      });
    }

    res.json({
      ok: true,
      strategy: strategies[key],
    });
  });

  return router;
};
