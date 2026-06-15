const { asyncHandler } = require("../../middleware/errorHandler");
const { PrismaClient } = require("@prisma/client");
const BitgetClient = require("../../infrastructure/exchange/BitgetClient");
const {
  listExchangesMasked,
  getExchangeCredentials,
  upsertExchange,
  deleteExchange,
} = require("../../services/userExchange");
const cfg = require("../../config/env");

const prisma = new PrismaClient();

// Cache balance per-user untuk hindari rate-limit Bitget (TTL 60s)
const balanceCache = new Map(); // userId -> { ts, data }
const BALANCE_TTL = 60_000;

module.exports = function createAccountRouter() {
  const express = require("express");
  const router = express.Router();

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
        activeBots: bots.filter((b) => b.running).length,
        totalBots: bots.length,
      });
    })
  );

  router.get(
    "/exchange-balance",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const exchangeType = req.query.exchangeType || "bitget";

      const cached = balanceCache.get(`${userId}:${exchangeType}`);
      if (cached && Date.now() - cached.ts < BALANCE_TTL) {
        return res.json(cached.data);
      }

      const creds = await getExchangeCredentials(userId, exchangeType);

      const notConnected = {
        ok: false,
        configured: false,
        message: "Exchange belum terhubung",
        currency: "USDT",
        available: 0,
        equity: 0,
        unrealizedPL: 0,
      };

      if (!creds?.apiKey || !creds?.apiSecret) {
        return res.json(notConnected);
      }

      if (exchangeType !== "bitget") {
        return res.json({
          ok: false,
          configured: true,
          exchangeType,
          message: `Balance untuk ${exchangeType} belum didukung`,
          currency: "USDT",
          available: 0,
          equity: 0,
          unrealizedPL: 0,
        });
      }

      try {
        const client = new BitgetClient(creds.apiKey, creds.apiSecret, creds.apiPassphrase);
        const balance = await client.getBalance("USDT");
        const data = {
          ok: true,
          configured: true,
          exchangeType,
          currency: "USDT",
          available: balance.available || 0,
          equity: balance.equity || 0,
          unrealizedPL: balance.unrealizedPL || 0,
        };
        balanceCache.set(`${userId}:${exchangeType}`, { ts: Date.now(), data });
        res.json(data);
      } catch (err) {
        res.status(400).json({
          ok: false,
          configured: true,
          exchangeType,
          message: "Gagal mengambil balance dari exchange. Periksa kembali API key Anda.",
          error: err.message,
          currency: "USDT",
          available: 0,
          equity: 0,
          unrealizedPL: 0,
        });
      }
    })
  );

  router.get(
    "/paper-balance",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const startingBalance = parseFloat(process.env.DRY_RUN_VIRTUAL_BALANCE) || 1000;

      const trades = await prisma.trade.findMany({
        where: { bot: { userId, dryRun: true } },
        select: { pnl: true, status: true },
      });

      let realizedPnL = 0;
      let unrealizedPnL = 0;
      for (const t of trades) {
        if (t.status === "CLOSED") realizedPnL += t.pnl || 0;
        else unrealizedPnL += t.pnl || 0;
      }

      const equity = startingBalance + realizedPnL + unrealizedPnL;

      res.json({
        ok: true,
        configured: true,
        paper: true,
        currency: "USDT",
        startingBalance,
        realizedPnL,
        unrealizedPL: unrealizedPnL,
        available: startingBalance + realizedPnL,
        equity,
      });
    })
  );

  router.get(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const exchanges = await listExchangesMasked(userId);

      res.json({
        ok: true,
        exchanges,
        configured: exchanges.length > 0,
        // backward compat — exchange pertama
        exchangeType: exchanges[0]?.exchangeType || "bitget",
        apiKey: exchanges[0]?.apiKey || null,
        apiSecret: exchanges[0]?.apiSecret || null,
        apiPassphrase: exchanges[0]?.apiPassphrase || null,
      });
    })
  );

  router.post(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { apiKey, apiSecret, apiPassphrase, exchangeType = "bitget" } = req.body;

      // Validate exchange against allowed list (production: bitget only)
      const allowedExchanges = cfg.allowedExchanges;
      if (allowedExchanges && !allowedExchanges.includes(exchangeType?.toLowerCase())) {
        return res.status(403).json({
          ok: false,
          statusCode: 403,
          message: `Exchange "${exchangeType}" tidak didukung. Hanya ${allowedExchanges.join(", ")} yang tersedia saat ini.`,
        });
      }

      // ── Task C: Binance API key permission validation ────────────────────
      // Reject keys with withdrawal permission or without futures permission.
      // Validation runs BEFORE storage — a failing key is never persisted (AC-3).
      // Outcome is written to the audit log either way (AC-4).
      if (exchangeType?.toLowerCase() === "binance") {
        const ExchangeService = require("../../services/ExchangeService");
        try {
          const detail = await ExchangeService.validateExchangeKey("binance", {
            apiKey,
            apiSecret,
          });
          await prisma.auditLog.create({
            data: {
              userId,
              action: "EXCHANGE_KEY_VALIDATED",
              resource: "UserExchange",
              details: JSON.stringify({ exchange: "binance", result: "passed", ...detail.detail }),
              ipAddress: req.ip ?? null,
              userAgent: req.headers["user-agent"] ?? null,
            },
          });
        } catch (err) {
          await prisma.auditLog.create({
            data: {
              userId,
              action: "EXCHANGE_KEY_REJECTED",
              resource: "UserExchange",
              details: JSON.stringify({ exchange: "binance", code: err.code, reason: err.message }),
              ipAddress: req.ip ?? null,
              userAgent: req.headers["user-agent"] ?? null,
            },
          }).catch(() => {});
          return res.status(err.statusCode || 400).json({
            ok: false,
            statusCode: err.statusCode || 400,
            code: err.code || "BINANCE_VALIDATION_FAILED",
            message: err.message,
          });
        }
      }

      try {
        const result = await upsertExchange(userId, {
          apiKey,
          apiSecret,
          apiPassphrase,
          exchangeType,
        });

        balanceCache.delete(`${userId}:${exchangeType}`);

        res.json({
          ok: true,
          message: `${exchangeType.charAt(0).toUpperCase() + exchangeType.slice(1)} API keys saved`,
          exchangeType: result.exchangeType,
          configured: true,
        });
      } catch (err) {
        res.status(err.statusCode || 500).json({
          ok: false,
          statusCode: err.statusCode || 500,
          message: err.message,
        });
      }
    })
  );

  router.delete(
    "/keys",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const exchangeType = req.query.exchangeType || req.body?.exchangeType;

      if (!exchangeType) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "exchangeType is required",
        });
      }

      try {
        await deleteExchange(userId, exchangeType);
        balanceCache.delete(`${userId}:${exchangeType}`);

        res.json({
          ok: true,
          message: `${exchangeType} disconnected`,
        });
      } catch (err) {
        res.status(err.statusCode || 500).json({
          ok: false,
          statusCode: err.statusCode || 500,
          message: err.message,
        });
      }
    })
  );

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

      res.json({ ok: true, strategy });
    })
  );

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

  // ── Exchange Switch: GET /account/exchange/status ────────────────────────
  router.get(
    "/exchange/status",
    asyncHandler(async (req, res) => {
      const { getExchangeStatus } = require("../../services/exchangeSwitch");
      const status = await getExchangeStatus(req.userId);
      res.json({ ok: true, ...status });
    })
  );

  // ── Exchange Switch: POST /account/exchange/switch ────────────────────────
  router.post(
    "/exchange/switch",
    asyncHandler(async (req, res) => {
      const { switchExchange } = require("../../services/exchangeSwitch");
      const { newExchange, apiKey, secretKey, passphrase } = req.body;
      if (!newExchange || !apiKey || !secretKey) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "newExchange, apiKey, dan secretKey wajib diisi.",
        });
      }
      const result = await switchExchange(req.userId, {
        newExchange,
        apiKey,
        secretKey,
        passphrase,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
      });
      res.json(result);
    })
  );

  return router;
};
