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
  const { decrypt, isEncrypted } = require("../../infrastructure/security/crypto");
  const { getUserBotLogs } = require("../../infrastructure/db/botLogRepository");
  const { assertStrategyAllowed, getStrategyEntitlements } = require("../../services/entitlement");

  // Decrypt value dari DB (toleran terhadap plaintext lama)
  function safeDecrypt(value) {
    if (!value) return null;
    return isEncrypted(value) ? decrypt(value) : value;
  }

  /** Gabungkan record DB dengan state live BotEngine (jika instance ada). */
  function mergeBotWithLiveState(userId, botRecord) {
    const instance = getBot(userId, botRecord.symbol);
    if (instance) {
      const live = instance.getState();
      return {
        ...botRecord,
        ...live,
        id:          botRecord.id,
        botId:       botRecord.symbol,
        running:     live.running,
        strategyKey: botRecord.strategyKey,
      };
    }
    return {
      ...botRecord,
      botId:          botRecord.symbol,
      startCapital:   botRecord.capital,
      openPositions:  [],
      openTradeCount: 0,
      closedTrades:   botRecord.totalTrades ?? 0,
      totalPnL:       0,
      unrealizedPnL:  0,
    };
  }

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
        bots: bots.map(b => mergeBotWithLiveState(userId, b)),
      });
    })
  );

  /**
   * GET /api/v1/bots/logs
   * Semua log bot user (gabungan, kronologis) — untuk hydrate FE setelah refresh
   */
  router.get(
    "/logs",
    asyncHandler(async (req, res) => {
      const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
      const logs  = await getUserBotLogs(req.userId, limit);

      res.json({ ok: true, count: logs.length, logs });
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

      const instance = getBot(userId, symbol);
      const merged   = mergeBotWithLiveState(userId, bot);

      res.json({
        ok: true,
        symbol,
        ...merged,
        config: bot,
        state:  instance ? instance.getState() : {},
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

      // Entitlement check — block strategy not allowed by user's tier
      try {
        await assertStrategyAllowed(userId, strategyKey);
      } catch (e) {
        return res.status(e.status).json(e.body);
      }

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
        // Update existing — simpan dryRun terbaru jika dikirim dari FE
        bot = await prisma.bot.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            capital:     capital     || bot.capital,
            strategyKey: strategyKey || bot.strategyKey,
            dryRun:      dryRun !== undefined ? dryRun !== false : bot.dryRun,
            running:     true,
            startedAt:   new Date(),
          },
        });
      }

      // Ambil API key user dari DB dan decrypt sebelum dikirim ke BotEngine
      const userRecord = await prisma.user.findUnique({
        where:  { id: userId },
        select: { apiKey: true, apiSecret: true, apiPassphrase: true, exchangeType: true },
      });

      const decryptedApiKey     = safeDecrypt(userRecord?.apiKey);
      const decryptedApiSecret  = safeDecrypt(userRecord?.apiSecret);
      const decryptedPassphrase = safeDecrypt(userRecord?.apiPassphrase);

      if (!decryptedApiKey || !decryptedApiSecret) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "API Key exchange belum dikonfigurasi. Tambahkan di Settings → API Keys.",
        });
      }

      // Create or get bot instance — sertakan kredensial user agar BotEngine
      // bisa fetch balance & OHLCV nyata dari exchange
      const instance = createBotInstance(userId, symbol, {
        capital:     bot.capital,
        strategyKey: bot.strategyKey,
        dryRun:      bot.dryRun,
        botId:       bot.id,
        userId,                // diteruskan ke openSession → user_id di bot_sessions
        apiKey:      decryptedApiKey,
        apiSecret:   decryptedApiSecret,
        passphrase:  decryptedPassphrase,
      });

      if (!instance.getState().running) {
        await instance.start();
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
      const instance = getBot(userId, symbol);
      if (instance && instance.getState().running) {
        await instance.stop();
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

      // Entitlement check
      try {
        await assertStrategyAllowed(userId, strategyKey);
      } catch (e) {
        return res.status(e.status).json(e.body);
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
      const instance = getBot(userId, symbol);
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

      const instance = getBot(userId, symbol);

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

      const instance = getBot(userId, symbol);
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
      const rows = await prisma.botLog.findMany({
        where:   { botId: bot.id },
        orderBy: { createdAt: "desc" },
        take:    limit,
      });

      const logs = rows.reverse().map(row => ({
        time:   row.createdAt,
        level:  row.level,
        msg:    row.message,
        symbol,
      }));

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
   * List strategies filtered by user's tier.
   * Returns allowed strategies + locked list with required tier.
   */
  router.get("/strategies/available", asyncHandler(async (req, res) => {
    const { strategyRegistry } = require("../../domain/strategy");
    const { listTiers } = require("../../domain/tierConfig");

    const { tier, allowed, locked } = await getStrategyEntitlements(req.userId);

    const toStrategyInfo = (key) => {
      const s = strategyRegistry.get(key);
      if (!s) return { key, label: key, description: "" };
      return {
        key,
        label:       s.config.label,
        description: s.config.description,
        version:     s.config.version,
      };
    };

    res.json({
      ok: true,
      tier,
      strategies: allowed.map(toStrategyInfo),
      locked: locked.map(({ key, requiredTier }) => ({
        ...toStrategyInfo(key),
        requiredTier,
      })),
      tiers: listTiers().map(({ key, label, price, strategies }) => ({
        key, label, price, strategies,
      })),
    });
  }));

  /**
   * GET /api/v1/bots/strategies/info/:strategyKey
   * Get strategy info
   */
  router.get("/strategies/info/:key", (req, res) => {
    const { key } = req.params;
    const { STRATEGIES } = require("../../domain/strategies");

    const strategyConfig = STRATEGIES[key];

    if (!strategyConfig) {
      return res.status(404).json({
        ok: false,
        statusCode: 404,
        message: "Strategy not found",
      });
    }

    const riskConfig = {
      riskPerTrade: strategyConfig.riskPerTrade || 0.01,
      maxDailyLossPct: strategyConfig.maxDailyLossPct || 0.05,
      maxTradesPerDay: strategyConfig.maxTradesPerDay || 10,
    };

    const response = {
      name: strategyConfig.name,
      label: strategyConfig.label,
      description: strategyConfig.description,
      interval: strategyConfig.interval,
      leverage: strategyConfig.leverage || 1,
      riskConfig,
    };

    // Add component info for ADAPTIVE_FUSION
    if (key === "ADAPTIVE_FUSION") {
      response.components = [
        { key: "A", name: "Aggressive Scalping", minBalance: 500 },
        { key: "B", name: "Day Trading", minBalance: 50 },
        { key: "C", name: "Swing Trading", minBalance: 0 },
      ];
    }

    res.json({
      ok: true,
      strategy: response,
    });
  });

  return router;
};
