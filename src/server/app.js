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
const AccountCoordinator = require("../domain/AccountCoordinator");
const db     = require("../infrastructure/db/database");
const backup = require("../infrastructure/backup/BackupScheduler");
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

// ── Env validation (fail-fast sebelum boot) ─────────────────────────────────
cfg.validate();

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
  });
  botsMap[key] = bot;
  return bot;
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health check (public)
const healthHandler = (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
app.use("/api/v1/bots", authMiddleware, createBotsRouter({ getBot, getAllBots, createBotInstance }));

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
app.use("/api/v1/legacy", authMiddleware, createLegacyRouter({ getBot, getAllBots }));

// Account routes (protected)
app.use("/api/v1/account", authMiddleware, createAccountRouter());

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

wss.on("connection", (ws, req) => {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[WS] Client connected: ${clientIp}`);

  // Replay buffer in-memory (100 entri terakhir per bot) + snapshot status live
  const WS_REPLAY_PER_BOT = 100;
  Object.values(botsMap).forEach((instance) => {
    const symbol = instance.config?.symbol;
    if (!symbol) return;

    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "status", symbol, data: instance.getState() }));
      } catch { /* client mungkin sudah disconnect */ }
    }

    instance.getLogs(WS_REPLAY_PER_BOT).forEach((entry) => {
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
    console.log(`[WS] Client disconnected: ${clientIp}`);
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});

// Broadcast bot logs + status ke WebSocket clients
const originalEmit = BotEngine.prototype.emit;
BotEngine.prototype.emit = function (event, ...args) {
  const symbol = this.config?.symbol;
  if (!symbol) return originalEmit.call(this, event, ...args);

  if (event === "log" || event === "status") {
    const payload = event === "log"
      ? { type: "log", symbol, data: args[0] }
      : { type: "status", symbol, data: args[0] };

    wss.clients.forEach((client) => {
      if (client.readyState === 1 && (!client.botSymbol || client.botSymbol === symbol)) {
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
  })
  .catch((err) => {
    console.error("[STARTUP] Gagal inisialisasi database:", err.message);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down gracefully...");
  backup.stop();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
});

module.exports = { app, server, wss };
