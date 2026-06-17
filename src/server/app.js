// ─── src/server/app.js (Refactored with Auth & Validation) ─────────────────
// Quantara API Server — Multi-Bot with Auth Layer

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");
const rateLimit = require("express-rate-limit");

const cfg = require("../config/env");
const BotEngine = require("../application/BotEngine");
const AdaptiveStrategyEngine = require("../application/AdaptiveStrategyEngine");
const MultiStrategyCoordinator = require("../application/MultiStrategyCoordinator");
const AccountCoordinator = require("../domain/AccountCoordinator");
const db     = require("../infrastructure/db/database");
const backup = require("../infrastructure/backup/BackupScheduler");
const telegramBot = require("../infrastructure/notifications/TelegramBotPoller");
const { createExchangeClient } = require("../infrastructure/exchange");

// Middleware
const { authMiddleware } = require("../middleware/auth");
const { errorHandler } = require("../middleware/errorHandler");

// Routes
const createAuthRouter = require("./routes/auth");
const createBotsRouter = require("./routes/bots-afs");
const createMarketRouter = require("./routes/market");
const createHistoryRouter = require("./routes/history");
const createBacktestRouter = require("./routes/backtest");
const createLegacyRouter = require("./routes/legacy");
const createAccountRouter = require("./routes/account");
const createAdminRouter = require("./routes/admin");
const createSubscriptionRouter = require("./routes/subscription");

// ── Env validation (fail-fast sebelum boot) ─────────────────────────────────
cfg.validate();

// ── Feature flags ─────────────────────────────────────────────────────────
// MULTI_STRATEGY_ENABLED: default ON; disable lewat env MULTI_STRATEGY_ENABLED=false.
const MULTI_STRATEGY_ENABLED = process.env.MULTI_STRATEGY_ENABLED !== "false";

// Entitlement service (dipakai resumeRunningBots untuk fallback tier-strategies)
const { getTierStrategies } = require("../services/entitlement");

// ── CORS & Security ────────────────────────────────────────────────────────
// Domain produksi dibaca dari env (cfg.corsOrigins). Localhost ditangani terpisah.
const ALLOWED_ORIGINS = cfg.corsOrigins;

// Izinkan semua localhost port tanpa batasan NODE_ENV.
// Localhost tidak dapat diakses dari luar mesin → aman secara default.
// Vite auto-geser port (5173→5174→5175 dst) sehingga kita izinkan semua.
function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Localhost selalu diizinkan (development & production — tidak ada risiko keamanan)
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

const app = express();

// ── Trust proxy (CRITICAL untuk rate limiting di belakang nginx) ────────────
// Tanpa ini, express-rate-limit memakai IP socket (= IP nginx), sehingga SEMUA
// user berbagi satu bucket rate-limit. Set ke jumlah hop proxy (1 = satu nginx).
// req.ip akan membaca X-Forwarded-For dari nginx → rate limit per-user yang benar.
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS) || 1);

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    if (isOriginAllowed(origin)) {
      cb(null, true);
    } else {
      cb(new Error("CORS not allowed"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Rate limiting
// AUTH_RATE_LIMIT bisa di-set via .env untuk melonggarkan limit saat testing
const AUTH_MAX = parseInt(process.env.AUTH_RATE_LIMIT) || (process.env.NODE_ENV === "production" ? 10 : 100);

// API_RATE_LIMIT: limit per-IP untuk SEMUA endpoint /api/v1 (kecuali auth).
// Dashboard real-time melakukan banyak polling sah (ticker, bot status, balance),
// jadi 100/15min terlalu kecil → 429. Default 1000/15min memberi headroom cukup
// untuk satu user dengan beberapa tab, sambil tetap mencegah abuse.
// Per-IP karena trust proxy sudah aktif (lihat app.set di atas).
const API_MAX = parseInt(process.env.API_RATE_LIMIT) || 1000;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: API_MAX,
  standardHeaders: true,  // kirim RateLimit-* headers agar FE bisa baca sisa kuota
  legacyHeaders: false,
  message: { ok: false, statusCode: 429, message: "Terlalu banyak permintaan. Tunggu beberapa saat lalu coba lagi." },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_MAX,
  message: { ok: false, statusCode: 429, message: "Terlalu banyak permintaan. Tunggu beberapa saat lalu coba lagi." },
  skip: (req) => {
    // Skip refresh - has its own refreshLimiter (20/15min)
    if (req.method === "POST" && req.path === "/refresh") {
      return true;
    }
    // Only limit POST requests
    return req.method !== "POST";
  },
});

app.use("/api/v1/auth/", authLimiter);
app.use("/api/v1/", limiter);

// ── Shared Exchange Client (singleton untuk market data) ───────────────────
const sharedClient = createExchangeClient();

// ── Bot Management (In-Memory) ─────────────────────────────────────────────
// Namespace by userId untuk mencegah cross-user leak.
// Key: `${userId}:${symbol}` → BotEngine instance
const botsMap = {};

// Koordinator margin per user (#5): semua bot milik user yang sama berbagi SATU
// akun exchange, jadi mereka berbagi satu AccountCoordinator agar total margin
// lintas-bot tidak melebihi anggaran (anti over-commit / likuidasi).
const coordinatorsMap = {}; // userId -> AccountCoordinator

function getCoordinator(userId) {
  if (!coordinatorsMap[userId]) {
    coordinatorsMap[userId] = new AccountCoordinator({
      userId,
      maxAccountUtilization:  cfg.maxAccountUtilization  ?? 0.8,
      maxConcurrentPositions: cfg.maxConcurrentPositions ?? 0,
      // Batas kerugian harian AGREGAT lintas-bot (#5). Default 6% > per-bot 4%,
      // memberi ruang tapi mencegah akumulasi 3×4%=12% di satu akun.
      maxAccountDailyLossPct: parseFloat(process.env.MAX_ACCOUNT_DAILY_LOSS_PCT) || 0.06,
    });
  }
  return coordinatorsMap[userId];
}

function makeKey(userId, symbol) {
  return `${userId}:${symbol}`;
}

function getBot(userId, symbol) {
  return botsMap[makeKey(userId, symbol)] || null;
}

function getAllBots(userId) {
  const prefix = `${userId}:`;
  return Object.entries(botsMap)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, instance]) => instance);
}

// Hapus instance BotEngine dari memori (dipakai saat ganti strategi / edit config
// / delete bot). Bot wajib sudah stopped sebelum dipanggil; sebagai pengaman kita
// tetap stop() bila masih running agar tidak ada interval/loop yatim.
function removeBotInstance(userId, symbol) {
  const key = makeKey(userId, symbol);
  const existing = botsMap[key];
  if (!existing) return false;
  try {
    if (existing.getState().running) existing.stop();
  } catch { /* abaikan — yang penting instance dilepas */ }
  delete botsMap[key];
  return true;
}

/** Hentikan & buang semua BotEngine in-memory user (dipakai saat ganti exchange). */
function stopAllUserBotsInMemory(userId) {
  const prefix = `${userId}:`;
  for (const [key, instance] of Object.entries(botsMap)) {
    if (!key.startsWith(prefix)) continue;
    try {
      if (instance.getState?.().running) instance.stop();
    } catch { /* abaikan */ }
    const sym = instance.config?.symbol ?? key.slice(prefix.length);
    removeBotInstance(userId, sym);
  }
  delete coordinatorsMap[userId];
}

function createBotInstance(userId, symbol, configOverrides = {}) {
  const key = makeKey(userId, symbol);
  const existing = botsMap[key];
  if (existing) {
    // Jika bot sedang running, kembalikan instance yang ada (tidak bisa recreate saat live)
    if (existing.getState().running) {
      if (configOverrides.botId) existing.config.botId = configOverrides.botId;
      return existing;
    }

    // Jika bot berhenti, recreate dengan kredensial terbaru (user bisa ganti API key)
    delete botsMap[key];
  }
  const bot = new BotEngine({
    symbol,
    botKey:      key,
    coordinator: getCoordinator(userId), // koordinasi margin lintas-bot (#5)
    ...configOverrides,
    // SELALU set userId (defense-in-depth): tanpa ini, openSession membuat
    // bot_sessions.user_id NULL → getTrades (INNER JOIN s.user_id) menyembunyikan
    // trade dari History. Bug ini muncul di jalur auto-resume yang lupa meneruskan
    // userId. Di-set TERAKHIR agar tak bisa ter-override configOverrides.
    userId,
  });
  botsMap[key] = bot;
  return bot;
}

/**
 * Buat instance MultiStrategyCoordinator untuk satu koin (fitur Auto Multi-Strategy
 * Execution per Coin). Koordinator ini disimpan di botsMap pada slot yang sama
 * dengan BotEngine sehingga route/WS memperlakukannya identik (getState/start/stop).
 *
 * @param {string} userId
 * @param {string} symbol
 * @param {Object} opts  — { strategies[], capital, dryRun, apiKey, apiSecret, passphrase, botId }
 * @returns {MultiStrategyCoordinator}
 */
function createMultiStrategyInstance(userId, symbol, opts = {}) {
  const key = makeKey(userId, symbol);
  const existing = botsMap[key];
  if (existing) {
    if (existing.getState().running) return existing;
    delete botsMap[key];
  }

  const accountCoordinator = getCoordinator(userId);

  // engineFactory di-INJECT ke koordinator → satu AdaptiveStrategyEngine per strategi,
  // berbagi AccountCoordinator + kredensial user. cfg dari koordinator sudah berisi
  // strategyKey/capital/dryRun/botKey/groupKey.
  const engineFactory = (strategyKey, cfg2) =>
    new AdaptiveStrategyEngine({
      ...cfg2,
      coordinator: accountCoordinator,
      exchangeType: opts.exchangeType || "bitget",
      apiKey:      opts.apiKey,
      apiSecret:   opts.apiSecret,
      passphrase:  opts.passphrase,
      botId:       opts.botId,
    });

  const coordinator = new MultiStrategyCoordinator({
    userId,
    symbol,
    strategies:   opts.strategies,
    totalCapital: opts.capital,
    engineFactory,
    accountCoordinator,
    dryRun:       opts.dryRun,
    conflictMode: process.env.MULTI_STRATEGY_CONFLICT_MODE || "skip",
    engineConfig: { botId: opts.botId },
    // Cap posisi terbuka per koin lintas-strategi (anti penumpukan satu arah).
    // Default 2; override via env MULTI_STRATEGY_MAX_POSITIONS_PER_COIN.
    maxPositionsPerCoin: parseInt(process.env.MULTI_STRATEGY_MAX_POSITIONS_PER_COIN, 10) || 2,
    // Inject DB → canEnter pakai DB sebagai sumber kebenaran tunggal (cap menghormati
    // SEMUA posisi terbuka termasuk orphan, bukan hanya state engine live).
    db,
  });

  botsMap[key] = coordinator;
  return coordinator;
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health check (public)
const healthHandler = (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    allowedExchanges: cfg.allowedExchanges,
  });
};

// Root health (direct backend access)
app.get("/health", healthHandler);

// Versioned health (public — reachable through nginx /api/ proxy)
app.get("/api/v1/health", healthHandler);

// Auth routes (public — NO authentication required)
app.use("/api/v1/auth", createAuthRouter());

// ✅ FIX: Apply auth middleware ONLY to protected routes
// Bots routes (protected, user-isolated)
app.use("/api/v1/bots", authMiddleware, createBotsRouter({ getBot, getAllBots, createBotInstance, createMultiStrategyInstance, removeBotInstance, sharedClient, getCoordinator }));

// Market routes (protected)
app.use("/api/v1/market", authMiddleware, createMarketRouter({
  sharedClient,
  bots: { values: () => Object.values(botsMap), entries: () => Object.entries(botsMap) },
  getBot,
  SYMBOLS_LIST: cfg.symbolsList,
}));

// History routes (protected)
app.use("/api/v1/history", authMiddleware, createHistoryRouter({ SYMBOLS_LIST: cfg.symbolsList, getAllBots }));

// Backtest routes (protected)
app.use("/api/v1/backtest", authMiddleware, createBacktestRouter({ SYMBOLS_LIST: cfg.symbolsList }));

// Legacy routes (protected - deprecated)
app.use("/api/v1/legacy", authMiddleware, createLegacyRouter({ getBot, SYMBOLS_LIST: cfg.symbolsList }));

// Account routes (protected)
app.use("/api/v1/account", authMiddleware, createAccountRouter({ stopAllUserBotsInMemory }));
app.use("/api/v1/subscription", authMiddleware, createSubscriptionRouter());
app.use("/api/v1/admin",   createAdminRouter()); // no authMiddleware — protected by ADMIN_SECRET header

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    statusCode: 404,
    message: "Endpoint not found",
  });
});

// Error handling (last middleware)
app.use(errorHandler);

// ── HTTP Server Setup ──────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket Setup ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

// Helper: ekstrak userId dari JWT di WS handshake request.
// Token bisa datang dari query string (?token=...) atau header Sec-WebSocket-Protocol.
function wsAuthUserId(req) {
  try {
    const AuthService = require("../services/AuthService");
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) return null;
    const payload = AuthService.verifyAccessToken(token);
    return payload?.userId ?? null;
  } catch {
    return null;
  }
}

wss.on("connection", (ws, req) => {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  // FIX: autentikasi WS saat koneksi — tolak koneksi tanpa token valid.
  const wsUserId = wsAuthUserId(req);
  if (!wsUserId) {
    ws.close(4401, "Unauthorized");
    console.log(`[WS] Rejected unauthenticated connection from ${clientIp}`);
    return;
  }
  ws.userId = wsUserId;
  console.log(`[WS] Client connected: ${clientIp} (user: ${wsUserId})`);

  // Replay buffer in-memory (100 entri terakhir per bot) + snapshot status live.
  // FIX: hanya replay bot milik userId yang terautentikasi.
  const WS_REPLAY_PER_BOT = 100;
  getAllBots(wsUserId).forEach((instance) => {
    const symbol = instance.config?.symbol;
    if (!symbol) return;

    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "status", symbol, data: instance.getState() }));
      } catch { /* client mungkin sudah disconnect */ }
    }

    // MultiStrategyCoordinator tidak punya getLogs — guard sebelum panggil
    const logs = typeof instance.getLogs === "function"
      ? instance.getLogs(WS_REPLAY_PER_BOT)
      : [];
    logs.forEach((entry) => {
      if (ws.readyState === 1) {
        try {
          ws.send(JSON.stringify({ type: "log", symbol, data: entry }));
        } catch { /* client mungkin sudah disconnect */ }
      }
    });
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Handle WebSocket messages (bot logs, real-time data, etc.)
      if (msg.type === "subscribe" && msg.botSymbol) {
        ws.botSymbol = msg.botSymbol;
      }
    } catch (err) {
      console.error("[WS] Message parse error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected: ${clientIp} (user: ${wsUserId})`);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});

// Broadcast bot logs + status ke WebSocket clients.
// FIX: hanya kirim ke client yang userId-nya cocok dengan pemilik bot.
const originalEmit = BotEngine.prototype.emit;
BotEngine.prototype.emit = function (event, ...args) {
  const symbol = this.config?.symbol;
  const botUserId = this.config?.userId;
  if (!symbol) return originalEmit.call(this, event, ...args);

  if (event === "log" || event === "status") {
    // Engine bagian dari MultiStrategyCoordinator → siarkan STATE TERAGREGASI
    // koordinator (modal/PnL/posisi gabungan 4 strategi), bukan state parsial 1
    // engine. Tanpa ini, status teragregasi hanya muncul saat poll 60s → kartu FE
    // tampak "tidak update" walau bot ticking tiap 30s–5m.
    const coord = this.config?.groupCoordinator;
    const statusData = (event === "status" && coord && typeof coord.getState === "function")
      ? coord.getState()
      : args[0];
    const payload = event === "log"
      ? { type: "log", symbol, data: args[0] }
      : { type: "status", symbol, data: statusData };

    wss.clients.forEach((client) => {
      if (
        client.readyState === 1 &&
        client.userId === botUserId &&
        (!client.botSymbol || client.botSymbol === symbol)
      ) {
        try {
          client.send(JSON.stringify(payload));
        } catch { /* client mungkin sudah disconnect */ }
      }
    });
  }
  return originalEmit.call(this, event, ...args);
};

// ── Server Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── Startup Recovery: AUTO-RESUME running bots ─────────────────────────────
// Saat server restart (crash / deploy / OOM), semua BotEngine in-memory hilang.
// Sebelumnya bot yang sedang LIVE tidak pernah dipulihkan → user mengira masih
// jalan padahal mati, lalu start ulang dengan toggle FE yang default dry-run
// → bot "tiba-tiba pindah ke Dry Run".
//
// Fix: baca semua Bot yang running=true dari DB, lalu recreate + start ulang
// BotEngine-nya dengan dryRun & kredensial yang TERSIMPAN — jadi bot LIVE tetap
// LIVE tanpa intervensi user. start() akan me-reuse sesi terbuka (lihat
// openSession) sehingga tidak membuat sesi duplikat.
async function resumeRunningBots() {
  try {
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient();
    const { getExchangeCredentials } = require("../services/userExchange");

    const bots = await prisma.bot.findMany({
      where: { running: true },
    });

    // Log tanpa syarat → penanda pasti bahwa kode auto-resume sudah ter-deploy.
    console.log(`[Startup] 🔁 Auto-resume: ${bots.length} bot dengan running=true ditemukan`);

    let resumed = 0, stopped = 0;
    for (const bot of bots) {
      // Resolusi kredensial DI DALAM try per-bot. Sebelumnya getExchangeCredentials
      // dipanggil di luar try → bila gagal (mis. kolom DB hilang saat skema drift),
      // exception naik ke outer catch dan MEMBATALKAN resume SEMUA bot → bot LIVE
      // tampil mati lalu di-start ulang user dalam mode dry. Kini kegagalan satu bot
      // hanya melewati bot itu, tidak menjatuhkan loop.
      try {
        const { getConnectedExchange } = require("../services/ExchangeService");
        const connectedExchange = await getConnectedExchange(bot.userId);
        const creds = await getExchangeCredentials(bot.userId, connectedExchange || "bitget");
        const apiKey     = creds?.apiKey;
        const apiSecret  = creds?.apiSecret;
        const passphrase = creds?.apiPassphrase;

        // Bot LIVE tanpa kredensial tidak bisa dilanjutkan → tandai stopped.
        if (!bot.dryRun && (!apiKey || !apiSecret)) {
          await prisma.bot.update({ where: { id: bot.id }, data: { running: false, stoppedAt: new Date() } });
          stopped++;
          console.warn(`[Startup] Bot LIVE ${bot.symbol} tidak punya API key → stopped`);
          continue;
        }

        const exchangeType = (connectedExchange || "bitget").toLowerCase();
        if (!bot.dryRun && exchangeType === "okx" && !passphrase) {
          await prisma.bot.update({ where: { id: bot.id }, data: { running: false, stoppedAt: new Date() } });
          stopped++;
          console.warn(`[Startup] Bot LIVE ${bot.symbol} OKX tanpa passphrase → stopped`);
          continue;
        }

        // Pilih path resume: multi-strategy jika flag ON.
        // Tanpa pengecekan ini setiap restart server akan selalu menjalankan BotEngine
        // legacy dengan strategyKey=ADAPTIVE_FUSION dari DB → log selalu "[ADAPTIVE_FUSION]".
        //
        // Prioritas strategyGroup:
        //   1. Pakai bot.strategyGroup dari DB jika sudah terisi (bot pernah di-start multi-strategy)
        //   2. Fallback: ambil dari tier user via getTierStrategies() — auto-upgrade bots legacy
        //      yang punya strategyGroup=[] tapi seharusnya jalan multi-strategy (VAULT/MINT/FORGE)
        let strategies = Array.isArray(bot.strategyGroup) && bot.strategyGroup.length > 0
          ? bot.strategyGroup
          : null;

        if (MULTI_STRATEGY_ENABLED && !strategies) {
          try {
            const mode = bot.dryRun ? "dry" : "live";
            strategies = await getTierStrategies(bot.userId, mode);
          } catch (_) {
            strategies = null; // fallback ke legacy jika gagal ambil tier
          }
        }

        const useMulti = MULTI_STRATEGY_ENABLED && strategies && strategies.length > 0;

        let instance;
        if (useMulti) {
          instance = createMultiStrategyInstance(bot.userId, bot.symbol, {
            strategies,
            capital:     bot.capital,
            dryRun:      bot.dryRun,
            tpMode:      bot.tpMode ?? "full",
            botId:       bot.id,
            exchangeType,
            apiKey, apiSecret, passphrase,
          });
          console.log(`[Startup] Resume bot ${bot.symbol} multi-strategy [${strategies.join(",")}] tpMode:${bot.tpMode ?? "full"} (${bot.dryRun ? "dry-run" : "LIVE"})`);
        } else {
          instance = createBotInstance(bot.userId, bot.symbol, {
            capital:     bot.capital,
            strategyKey: bot.strategyKey,
            dryRun:      bot.dryRun,           // ← mode ASLI dari DB, bukan default FE
            tpMode:      bot.tpMode ?? "full",
            botId:       bot.id,
            userId:      bot.userId,
            exchangeType,
            apiKey, apiSecret, passphrase,
          });
          console.log(`[Startup] Resume bot ${bot.symbol} single-strategy [${bot.strategyKey}] (${bot.dryRun ? "dry-run" : "LIVE"})`);
        }

        if (!instance.getState().running) await instance.start();
        resumed++;
      } catch (e) {
        console.warn(`[Startup] Gagal resume ${bot.symbol}: ${e.message}`);
      }
    }
    console.log(`[Startup] ✅ Auto-resume selesai: ${resumed} dilanjutkan, ${stopped} dihentikan`);
    await prisma.$disconnect();
  } catch (err) {
    console.warn("[Startup] resumeRunningBots error (non-fatal):", err.message);
  }
}

// Pastikan tabel engine (Postgres) siap sebelum menerima request.
db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n🚀 Quantara Bot Server running on ${PORT}`);
      console.log(`📊 Dashboard: http://localhost:5173`);
      console.log(`🔐 Auth enabled`);
      console.log(`📡 WebSocket: ws://localhost:${PORT}/ws\n`);
    });
    // Backup otomatis tiap 24 jam — berjalan di dalam proses Node.js, tanpa cron
    backup.start();
    telegramBot.start();
    // Purge soft-deleted exchange keys older than 7 days (every 6h)
    const { scheduleKeyPurge } = require("../services/exchangeKeyPurge");
    scheduleKeyPurge();
    // Pulihkan bot yang sedang berjalan (async, tidak memblok startup)
    resumeRunningBots();
  })
  .catch((err) => {
    console.error("[STARTUP] Gagal inisialisasi database:", err.message);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down gracefully...");
  telegramBot.stop();
  backup.stop();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
});

module.exports = { app, server, wss };
