const { asyncHandler } = require("../../middleware/errorHandler");
const { PrismaClient } = require("@prisma/client");
const BitgetClient = require("../../infrastructure/exchange/BitgetClient");
const { encrypt, decrypt, isEncrypted, fingerprint } = require("../../infrastructure/security/crypto");
const prisma = new PrismaClient();

// Decrypt kredensial tersimpan. Toleran terhadap data lama yang masih plaintext
// (isEncrypted=false) supaya tidak crash bila ada sisa data sebelum enkripsi.
function safeDecrypt(value) {
  if (!value) return null;
  return isEncrypted(value) ? decrypt(value) : value;
}

// Cache balance per-user untuk hindari rate-limit Bitget (TTL 60s)
// Bitget rate limit: 10 req/s per user. Cache 60s = aman ~2 concurrent user.
const balanceCache = new Map(); // userId -> { ts, data }
const BALANCE_TTL = 60_000;

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
   * GET /api/v1/account/exchange-balance
   * Real balance dari exchange milik user (pakai API key tersimpan).
   * Di-cache 20 detik per user untuk hindari rate-limit.
   */
  router.get(
    "/exchange-balance",
    asyncHandler(async (req, res) => {
      const userId = req.userId;

      const cached = balanceCache.get(userId);
      if (cached && Date.now() - cached.ts < BALANCE_TTL) {
        return res.json(cached.data);
      }

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { apiKey: true, apiSecret: true, apiPassphrase: true, exchangeType: true },
      });

      const notConnected = {
        ok: false,
        configured: false,
        message: "Exchange belum terhubung",
        currency: "USDT",
        available: 0,
        equity: 0,
        unrealizedPL: 0,
      };

      if (!user?.apiKey || !user?.apiSecret) {
        return res.json(notConnected);
      }

      const exchangeType = user.exchangeType || "bitget";

      // Fokus Bitget dulu; exchange lain disiapkan untuk kedepannya
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
        const client = new BitgetClient(
          safeDecrypt(user.apiKey),
          safeDecrypt(user.apiSecret),
          safeDecrypt(user.apiPassphrase)
        );
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
        balanceCache.set(userId, { ts: Date.now(), data });
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

  /**
   * GET /api/v1/account/paper-balance
   * Saldo virtual (paper wallet) untuk mode Dry Run. Independen dari exchange.
   *
   * equity = saldo awal virtual + realized PnL (trade dry-run yang CLOSED)
   *                              + unrealized PnL (trade dry-run yang OPEN)
   *
   * Saldo awal dikonfigurasi via env DRY_RUN_VIRTUAL_BALANCE (default 1000 USDT).
   */
  router.get(
    "/paper-balance",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const startingBalance = parseFloat(process.env.DRY_RUN_VIRTUAL_BALANCE) || 1000;

      // Ambil semua trade dari bot dry-run milik user ini.
      const trades = await prisma.trade.findMany({
        where: { bot: { userId, dryRun: true } },
        select: { pnl: true, status: true },
      });

      let realizedPnL = 0;
      let unrealizedPnL = 0;
      for (const t of trades) {
        if (t.status === "CLOSED") realizedPnL += t.pnl || 0;
        else unrealizedPnL += t.pnl || 0; // OPEN → mark-to-market bila tersedia
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
        available: startingBalance + realizedPnL, // dana bebas = awal + realized
        equity,
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

      const plainApiKey = safeDecrypt(user?.apiKey);
      const plainApiSecret = safeDecrypt(user?.apiSecret);

      res.json({
        ok: true,
        exchangeType: user?.exchangeType || "bitget",
        apiKey: plainApiKey ? mask(plainApiKey) : null,
        apiSecret: plainApiSecret ? mask(plainApiSecret) : null,
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

      // Cegah exchange account yang sama dipakai >1 user (hindari konflik bot).
      const apiKeyHash = fingerprint(apiKey);
      const existing = await prisma.user.findUnique({
        where:  { apiKeyHash },
        select: { id: true },
      });
      if (existing && existing.id !== userId) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: "API key exchange ini sudah terhubung ke akun lain. Satu exchange account hanya boleh dipakai satu user.",
        });
      }

      try {
        await prisma.user.update({
          where: { id: userId },
          data: {
            apiKey: encrypt(apiKey),
            apiSecret: encrypt(apiSecret),
            apiPassphrase: apiPassphrase ? encrypt(apiPassphrase) : null,
            apiKeyHash,
            exchangeType,
          },
        });
      } catch (e) {
        // Jaring pengaman race condition: dua request paralel lolos cek findUnique
        // di atas, lalu unique constraint apiKeyHash menolak yang kedua (P2002).
        if (e.code === "P2002") {
          return res.status(409).json({
            ok: false,
            statusCode: 409,
            message: "API key exchange ini sudah terhubung ke akun lain. Satu exchange account hanya boleh dipakai satu user.",
          });
        }
        throw e;
      }

      balanceCache.delete(userId); // kredensial berubah → buang cache lama

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
          apiKeyHash: null,
          exchangeType: null,
        },
      });

      balanceCache.delete(userId); // exchange diputus → buang cache

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
