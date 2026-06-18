// Updated bots-afs.js to use passed-in helper functions and support userId filtering

module.exports = function createBotsRouter(helpers) {
  const { getBot, getAllBots, createBotInstance, createMultiStrategyInstance, removeBotInstance, sharedClient, getCoordinator } = helpers;
  const express = require("express");
  const router = express.Router();
  const { asyncHandler } = require("../../middleware/errorHandler");
  const { validateBotStartInput, validateSymbolParam } = require("../../middleware/validation");
  // PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
  const prisma = require("../../infrastructure/db/prismaClient");
  const AuthService = require("../../services/AuthService");
  const { decrypt, isEncrypted } = require("../../infrastructure/security/crypto");
  const { getUserBotLogs, deleteUserBotLogs } = require("../../infrastructure/db/botLogRepository");
  const { assertStrategyAllowed, getStrategyEntitlements, getTierStrategies } = require("../../services/entitlement");
  const db = require("../../infrastructure/db/database");

  // Feature flag: Auto Multi-Strategy Execution per Coin. Default ON untuk staging
  // dry-run (TASK 4.3), OFF di production via MULTI_STRATEGY_ENABLED=false.
  const MULTI_STRATEGY_ENABLED = process.env.MULTI_STRATEGY_ENABLED !== "false";

  // ── Patch middleware/domain (Quantara Patch v1.0) ──────────────────────────
  const { strategyGuard } = require("../../middleware/strategyGuard");
  const { strategyChangeLimiter, emergencyStopConfirmGuard } = require("../../middleware/strategyRateLimiter");
  const { analyzeStrategyFit } = require("../../domain/strategyAnalysis");
  const { getMarketSnapshot } = require("../services/MarketSnapshotService");
  const { issueConfirmToken, DEFAULT_MAX_AGE_MS } = require("../../infrastructure/security/confirmToken");
  const { createBotOpLock } = require("../../middleware/botOpLock");
  // SEC-002 GAP1: satu lock dibagi start+stop agar start & stop untuk bot yang
  // sama juga saling-eksklusif, bukan hanya start vs start.
  const botOpLock = createBotOpLock();

  // Decrypt value dari DB (toleran terhadap plaintext lama)
  function safeDecrypt(value) {
    if (!value) return null;
    return isEncrypted(value) ? decrypt(value) : value;
  }

  /**
   * Gabungkan record DB dengan state live (BotEngine ATAU MultiStrategyCoordinator).
   * `openTradesMap` (opsional): Map symbol→trades hasil 1 query getOpenTradesByUser,
   * agar GET /bots tidak fan-out N query ke pool (1 per bot). Bila tidak diberikan,
   * fallback query per-symbol (dipakai endpoint single-bot).
   */
  async function mergeBotWithLiveState(userId, botRecord, openTradesMap = null) {
    const instance = getBot(userId, botRecord.symbol);
    if (instance) {
      const live = instance.getState();
      return {
        ...botRecord,
        ...live,
        id:          botRecord.id,
        botId:       botRecord.symbol,
        // DB adalah sumber kebenaran setelah exchange switch / graceful stop.
        running:     botRecord.running ? live.running : false,
        strategyKey: botRecord.strategyKey,
        params: {
          leverage:     instance.config?.leverage ?? null,
          riskPerTrade: instance.config?.riskPerTrade ?? null,
        },
        // Multi-Strategy per Coin: jika instance adalah koordinator, live.multiStrategy
        // + live.strategyGroup + live.engines ikut tersurfacing ke FE (badge per-strategi).
        strategyGroup: live.strategyGroup ?? botRecord.strategyGroup ?? [],
      };
    }
    // BUG-01: stopped bot may still have open trades in DB — surface them so
    // Recent Trades and Bot Card stay in sync.
    let openPositions = [];
    try {
      const dbTrades = openTradesMap
        ? (openTradesMap.get(botRecord.symbol) || [])
        : await db.getOpenTradesBySymbol(botRecord.symbol, userId);
      openPositions = dbTrades.map(t => ({
        id:          t.order_id || `db_${t.id}`,
        dbId:        t.id,
        side:        t.side,
        entry:       t.entry_price,
        sl:          t.sl,
        tp:          t.tp,
        size:        t.size ?? 0,
        openTime:    new Date(t.open_time).getTime(),
        atr:         t.atr,
        restoredFrom: t.session_id,
      }));
    } catch { /* non-critical — fall back to empty */ }
    return {
      ...botRecord,
      botId:          botRecord.symbol,
      startCapital:   botRecord.capital,
      openPositions,
      openTradeCount: openPositions.length,
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
          tpMode: true,
          running: true,
          startedAt: true,
          totalTrades: true,
          winningTrades: true,
          losingTrades: true,
        },
      });

      // Satu query untuk SEMUA posisi terbuka user → hindari N query (1 per bot)
      // yang bisa menyedot pool koneksi saat banyak bot & start serentak.
      let openTradesMap = new Map();
      try { openTradesMap = await db.getOpenTradesByUser(userId); }
      catch { /* non-critical — mergeBot fallback ke array kosong */ }

      res.json({
        ok: true,
        count: bots.length,
        bots: await Promise.all(bots.map(b => mergeBotWithLiveState(userId, b, openTradesMap))),
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
   * DELETE /api/v1/bots/logs
   * Hapus semua log bot milik user dari DB — dipanggil saat user klik "Clear Logs".
   */
  router.delete(
    "/logs",
    asyncHandler(async (req, res) => {
      const count = await deleteUserBotLogs(req.userId);
      res.json({ ok: true, deleted: count });
    })
  );

  /**
   * GET /api/v1/bots/margin-budget
   * Real-time account budget info untuk FE form. Menampilkan equity dari exchange,
   * anggaran aman (80%), margin yang sudah terpakai bot lain, dan sisa tersedia.
   * Dipakai untuk warning user + validasi sebelum klik "START BOT".
   *
   * Response:
   * {
   *   accountEquity: 58.28,
   *   maxUtilization: 0.8,
   *   totalBudget: 46.63,
   *   committed: { BTCUSDT: 0, ETHUSDT: 0, SOLUSDT: 0 },
   *   remaining: 46.63,
   *   minimumForLeverage2x: { BTCUSDT: 47.47, ETHUSDT: 23.50, SOLUSDT: 4.73 }
   * }
   */
  router.get(
    "/margin-budget",
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const coordinator = getCoordinator(userId);
      const snap = coordinator.snapshot();

      // Hitung minimum margin per pair (leverage 2x, SL=1.5×ATR, asumsi ATR% pasar)
      // Diperhitungkan dari: margin = (notional) / leverage = (price × size) / 2
      // Untuk user, kami estimasi dengan asumsi size minimum per pair + ATR% rata-rata
      const minMarginEstimate = {
        BTCUSDT: 47.47,  // ~0.001 BTC × $47,000 / 2x leverage
        ETHUSDT: 23.50,  // ~0.01 ETH × $2,350 / 2x
        SOLUSDT: 4.73,   // ~0.1 SOL × $94.60 / 2x
        BNBUSDT: 11.75,  // ~0.05 BNB × $470 / 2x
      };

      // Breakdown committed per symbol dari reservations
      const committedBySymbol = {};
      for (const [, r] of coordinator.reservations) {
        if (r.symbol && r.margin) {
          committedBySymbol[r.symbol] = (committedBySymbol[r.symbol] || 0) + r.margin;
        }
      }

      res.json({
        ok: true,
        accountEquity: snap.accountEquity,
        maxUtilization: snap.maxAccountUtilization,
        totalBudget: snap.budget,
        committed: committedBySymbol,
        remaining: snap.budget - snap.committedMargin,
        minimumForLeverage2x: minMarginEstimate,
      });
    })
  );

  /**
   * GET /api/v1/bots/:symbol/strategy-analysis  (FIX-2)
   * Analisis kondisi market + rekomendasi strategi.
   * Ditaruh SEBELUM "/:symbol" agar tidak tertangkap route generik.
   *
   * Auth: required (authMiddleware di app.js). IDOR-safe: bot di-query dengan
   * filter userId; market data sendiri bersifat publik sehingga analisis tetap
   * bisa berjalan walau user belum membuat bot untuk simbol ini.
   */
  router.get(
    "/:symbol/strategy-analysis",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      // IDOR check: hanya bot milik user ini yang dipakai untuk currentStrategy
      const bot = await prisma.bot.findFirst({
        where:  { symbol, userId },
        select: { id: true, strategyKey: true, symbol: true },
      });
      const currentStrategy = bot?.strategyKey ?? "NONE";

      const snapshot = await getMarketSnapshot(sharedClient, symbol, {
        emaFast: 9, emaSlow: 21,
        rsiPeriod: 14, atrPeriod: 14,
        bbPeriod: 20, bbStdDev: 2,
        htfInterval: "1h",
      });

      if (!snapshot) {
        return res.status(500).json({
          ok: false,
          statusCode: 500,
          message: "Gagal mengambil data market untuk analisis.",
        });
      }

      const analysis = analyzeStrategyFit({ ...snapshot, symbol }, currentStrategy);
      return res.json(analysis);
    })
  );

  /**
   * GET /api/v1/bots/:symbol/confirm-token  (TASK 3.5 — Security)
   * Terbitkan token konfirmasi HMAC berumur pendek untuk force-close.
   * Client mengirim token ini kembali pada POST /:symbol/stop { forceClose, confirm, confirmToken }.
   * Ditaruh sebelum "/:symbol" agar tidak tertangkap route generik.
   */
  router.get(
    "/:symbol/confirm-token",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const token = issueConfirmToken({ symbol: req.params.symbol, userId: req.userId });
      res.json({ ok: true, confirmToken: token, expiresInMs: DEFAULT_MAX_AGE_MS });
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
      const merged   = await mergeBotWithLiveState(userId, bot);

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
    botOpLock,
    validateBotStartInput,
    strategyGuard,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const { capital, dryRun } = req.body;
      // tpMode: "full" (default) | "partial" — dikontrol FE per bot
      const tpModeRaw = req.body.tpMode;
      const tpMode = tpModeRaw === "partial" ? "partial" : "full"; // whitelist
      // FE lama mengirim strategyKey; FE baru (multi-strategy) tidak. Bedakan keduanya.
      const explicitStrategyKey = req.body.strategyKey;
      const mode = dryRun === false ? "live" : "dry";

      // ── Tentukan jalur eksekusi: multi-strategy (otomatis dari tier) vs legacy ──
      // Multi aktif hanya bila flag ON DAN FE tidak memilih strategi manual.
      const useMulti = MULTI_STRATEGY_ENABLED && !explicitStrategyKey;

      let strategies = null;
      if (useMulti) {
        strategies = await getTierStrategies(userId, mode);
        if (!strategies.length) {
          return res.status(400).json({
            ok: false,
            statusCode: 400,
            message: `Tier kamu belum punya strategi yang siap dijalankan pada mode ${mode}.`,
          });
        }
      } else {
        // Legacy: entitlement check untuk strategi tunggal yang dipilih.
        const strategyKey = explicitStrategyKey || "ADAPTIVE_FUSION";
        try {
          await assertStrategyAllowed(userId, strategyKey);
        } catch (e) {
          return res.status(e.status).json(e.body);
        }
        strategies = [strategyKey];
      }

      const capitalPerStrategy = (capital || 500) / strategies.length;

      // Check if bot exists for this user
      let bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });

      const botData = {
        // strategyKey[0] disimpan untuk backward-compat (kolom lama tetap terisi).
        strategyKey:        strategies[0],
        strategyGroup:      useMulti ? strategies : [],
        capitalPerStrategy: useMulti ? capitalPerStrategy : 0,
        dryRun:             dryRun !== undefined ? dryRun !== false : (bot?.dryRun ?? true),
        tpMode,
      };

      // Create if doesn't exist
      if (!bot) {
        bot = await prisma.bot.create({
          data: { userId, symbol, capital: capital || 500, ...botData },
        });
      } else {
        bot = await prisma.bot.update({
          where: { userId_symbol: { userId, symbol } },
          data: {
            capital:   capital || bot.capital,
            ...botData,
            running:   true,
            startedAt: new Date(),
          },
        });
      }

      // BUG-03: Pre-flight margin budget check — reject early if live mode and
      // available margin is clearly insufficient (avoids bot starting then hanging).
      if (!bot.dryRun) {
        const coordinator = getCoordinator(userId);
        const snap = coordinator.snapshot();
        if (snap.accountEquity > 0) {
          const remaining = snap.budget - snap.committedMargin;
          // Conservative estimate: assume minimum 5× leverage so margin = capital / 5.
          // Real leverage check happens at entry time via canOpen(). This guards
          // obvious over-allocation (e.g. $500 capital, only $5 budget left).
          const DEFAULT_LEVERAGE = 5;
          const estimatedMargin = bot.capital / DEFAULT_LEVERAGE;
          if (estimatedMargin > remaining) {
            return res.status(400).json({
              ok: false,
              statusCode: 400,
              message: `Margin akun tidak cukup untuk start bot ${symbol}. Tersedia: $${remaining.toFixed(2)}, dibutuhkan: ≈$${estimatedMargin.toFixed(2)} (estimasi leverage ${DEFAULT_LEVERAGE}×). Kurangi capital, stop bot lain, atau top up balance.`,
              available: remaining,
              required: estimatedMargin,
            });
          }
        }
      }

      const { getExchangeCredentials } = require("../../services/userExchange");
      const { getConnectedExchange } = require("../../services/ExchangeService");
      const connectedExchange = await getConnectedExchange(userId);
      const creds = await getExchangeCredentials(userId, connectedExchange || "bitget");

      const decryptedApiKey     = creds?.apiKey;
      const decryptedApiSecret  = creds?.apiSecret;
      const decryptedPassphrase = creds?.apiPassphrase;

      if (!decryptedApiKey || !decryptedApiSecret) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "API Key exchange belum dikonfigurasi. Tambahkan di Settings → API Keys.",
        });
      }

      const exchangeType = (connectedExchange || "bitget").toLowerCase();
      if (exchangeType === "okx" && !decryptedPassphrase) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "OKX memerlukan passphrase API key. Tambahkan di Settings → API Keys.",
        });
      }

      // Create or get instance — koordinator multi-strategi ATAU engine tunggal legacy.
      const instance = useMulti
        ? createMultiStrategyInstance(userId, symbol, {
            strategies,
            capital:    bot.capital,
            dryRun:     bot.dryRun,
            tpMode:     bot.tpMode ?? "full",
            botId:      bot.id,
            exchangeType,
            apiKey:     decryptedApiKey,
            apiSecret:  decryptedApiSecret,
            passphrase: decryptedPassphrase,
          })
        : createBotInstance(userId, symbol, {
            capital:     bot.capital,
            strategyKey: bot.strategyKey,
            dryRun:      bot.dryRun,
            tpMode:      bot.tpMode ?? "full",
            botId:       bot.id,
            userId,                // diteruskan ke openSession → user_id di bot_sessions
            exchangeType,
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
    botOpLock,
    emergencyStopConfirmGuard,
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
    strategyChangeLimiter,
    strategyGuard,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const { strategyKey } = req.body;

      // TASK 3.3: pada flow Multi-Strategy per Coin, strategi ditentukan otomatis
      // dari tier — pemilihan manual tidak relevan lagi. Saat fitur aktif, endpoint
      // ini di-DEPRECATE (410 Gone). Saat flag OFF, tetap berfungsi (legacy) namun
      // menandai Deprecation agar klien lama bisa bermigrasi.
      if (MULTI_STRATEGY_ENABLED) {
        return res.status(410).json({
          ok: false,
          statusCode: 410,
          message: "Pemilihan strategi manual sudah tidak didukung. Strategi kini berjalan otomatis sesuai tier kamu.",
          code: "STRATEGY_SELECTION_DEPRECATED",
        });
      }
      res.setHeader("Deprecation", "true");

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

      // Bot yang RUNNING tidak boleh ganti strategi secara live: hanya field
      // strategyKey yang berubah, sedangkan signalType/interval/indikator di
      // BotEngine sudah ter-resolve saat construct → strategi baru tidak benar2
      // aktif (bug hot-swap). Wajib stop dulu; start berikutnya akan rebuild
      // BotEngine dengan config strategi yang benar.
      const liveInstance = getBot(userId, symbol);
      if (liveInstance && liveInstance.getState().running) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: "Hentikan bot terlebih dahulu sebelum mengganti strategi.",
          code: "BOT_RUNNING",
        });
      }

      // Update strategy in DB
      const updated = await prisma.bot.update({
        where: { userId_symbol: { userId, symbol } },
        data: { strategyKey },
      });

      // Buang instance lama (stopped) agar start berikutnya membangun BotEngine
      // baru dengan signalType/interval/indikator strategi yang dipilih.
      if (removeBotInstance) removeBotInstance(userId, symbol);

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
        message: `Strategy changed to ${updated.strategyKey}`,
        symbol,
        strategyKey: updated.strategyKey,
      });
    })
  );

  /**
   * PATCH /api/v1/bots/:symbol/config
   * Edit konfigurasi bot (strategyKey dan/atau capital). Hanya saat bot STOPPED.
   * Mendukung bagian "Edit" dari CRUD bot. IDOR-safe (userId scoped).
   */
  router.patch(
    "/:symbol/config",
    validateSymbolParam,
    strategyGuard, // memblok BREAKOUT_RETEST bila strategyKey dikirim
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;
      const { strategyKey, capital, tpMode } = req.body ?? {};

      if (strategyKey === undefined && capital === undefined && tpMode === undefined) {
        return res.status(400).json({
          ok: false,
          statusCode: 400,
          message: "Tidak ada perubahan. Kirim strategyKey, capital, dan/atau tpMode.",
        });
      }

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });
      if (!bot) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "Bot not found" });
      }

      // Wajib stopped — ubah config bot live berbahaya (posisi & state).
      const liveInstance = getBot(userId, symbol);
      if (liveInstance && liveInstance.getState().running) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: "Hentikan bot terlebih dahulu sebelum mengubah konfigurasi.",
          code: "BOT_RUNNING",
        });
      }

      const data = {};

      // Validasi strategyKey (entitlement per tier) bila dikirim
      if (strategyKey !== undefined) {
        if (typeof strategyKey !== "string" || !strategyKey) {
          return res.status(400).json({ ok: false, statusCode: 400, message: "strategyKey tidak valid" });
        }
        try {
          await assertStrategyAllowed(userId, strategyKey);
        } catch (e) {
          return res.status(e.status).json(e.body);
        }
        data.strategyKey = strategyKey;
      }

      // Validasi capital bila dikirim
      if (capital !== undefined) {
        const cap = Number(capital);
        if (!Number.isFinite(cap) || cap <= 0) {
          return res.status(400).json({ ok: false, statusCode: 400, message: "capital harus angka lebih dari 0" });
        }
        data.capital = cap;
      }

      // Validasi tpMode bila dikirim
      if (tpMode !== undefined) {
        if (tpMode !== "full" && tpMode !== "partial") {
          return res.status(400).json({ ok: false, statusCode: 400, message: "tpMode harus 'full' atau 'partial'" });
        }
        data.tpMode = tpMode;
      }

      const updated = await prisma.bot.update({
        where: { userId_symbol: { userId, symbol } },
        data,
      });

      // Buang instance lama (stopped) → start berikutnya rebuild dgn config baru.
      if (removeBotInstance) removeBotInstance(userId, symbol);

      await AuthService.logAction(
        userId,
        "BOT_CONFIG_UPDATE",
        "bot",
        bot.id,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({
        ok: true,
        message: "Konfigurasi bot diperbarui",
        symbol,
        strategyKey: updated.strategyKey,
        capital: updated.capital,
      });
    })
  );

  /**
   * DELETE /api/v1/bots/:symbol
   * Hapus bot (beserta log & sesi via cascade). Hanya saat bot STOPPED.
   * IDOR-safe (userId scoped).
   */
  router.delete(
    "/:symbol",
    validateSymbolParam,
    asyncHandler(async (req, res) => {
      const userId = req.userId;
      const { symbol } = req.params;

      const bot = await prisma.bot.findUnique({
        where: { userId_symbol: { userId, symbol } },
      });
      if (!bot) {
        return res.status(404).json({ ok: false, statusCode: 404, message: "Bot not found" });
      }

      const liveInstance = getBot(userId, symbol);
      if (liveInstance && liveInstance.getState().running) {
        return res.status(409).json({
          ok: false,
          statusCode: 409,
          message: "Hentikan bot terlebih dahulu sebelum menghapusnya.",
          code: "BOT_RUNNING",
        });
      }

      // Hapus instance in-memory (jika ada, stopped) lalu row DB.
      // BotLog & sesi terhapus otomatis via onDelete: Cascade di schema.
      if (removeBotInstance) removeBotInstance(userId, symbol);

      await prisma.bot.delete({
        where: { userId_symbol: { userId, symbol } },
      });

      await AuthService.logAction(
        userId,
        "BOT_DELETE",
        "bot",
        bot.id,
        req.ip,
        req.headers["user-agent"]
      );

      res.json({ ok: true, message: `Bot ${symbol} dihapus`, symbol });
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
    const { listTiers, getTierConfig } = require("../../domain/tierConfig");
    const { isStrategyLiveReady } = require("../../services/entitlement");

    const { tier, allowed, locked } = await getStrategyEntitlements(req.userId);

    // TASK 3.2: tandai status tiap strategi. Pada flow Multi-Strategy per Coin,
    // SEMUA strategi tier berjalan otomatis — ini hanya untuk display (bukan pilihan).
    const toStrategyInfo = (key) => {
      const s = strategyRegistry.get(key);
      const base = s
        ? { key, label: s.config.label, description: s.config.description, version: s.config.version }
        : { key, label: key, description: "" };
      return {
        ...base,
        status: isStrategyLiveReady(key) ? "active" : "dry_run_only",
      };
    };

    const cfg = getTierConfig(tier);
    const equalWeight = cfg?.capitalAllocation?.equal;
    const count = allowed.length || 1;

    res.json({
      ok: true,
      tier,
      // Multi-Strategy per Coin: strategi yang akan jalan OTOMATIS (display-only).
      autoRun: true,
      capitalAllocation: equalWeight ? `${(100 / count).toFixed(0)}% each` : "custom",
      maxPositionsPerSymbol: cfg?.maxPositionsPerSymbol ?? count,
      note: "All strategies run automatically. No manual selection required.",
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
    const { STRATEGIES } = require("../../domain/legacyStrategies");

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
