// ─── src/server/app.js (Refactored with Auth & Validation) ─────────────────
// Quantara API Server — Multi-Bot with Auth Layer

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const http = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");
const rateLimit = require("express-rate-limit");

const cfg = require("../config/env");
const BotEngine = require("../application/BotEngine");
const db = require("../infrastructure/db/database");
const { createExchangeClient } = require("../infrastructure/exchange");
const { listStrategies } = require("../domain/strategies");

// Middleware
const { authMiddleware, optionalAuthMiddleware } = require("../middleware/auth");
const { errorHandler, asyncHandler } = require("../middleware/errorHandler");
const { validateSymbolParam } = require("../middleware/validation");

// Routes
const createAuthRouter = require("./routes/auth");
const createBotsRouter = require("./routes/bots-afs");
const createMarketRouter = require("./routes/market");
const createHistoryRouter = require("./routes/history");
const createHealthRouter = require("./routes/health");
const createBacktestRouter = require("./routes/backtest");
const createLegacyRouter = require("./routes/legacy");
const createAccountRouter = require("./routes/account");

// ── CORS & Security ────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://187.77.135.156",
];

// Di development izinkan semua localhost port (Vite bisa auto-geser 5173→5174→5175 dst)
function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (process.env.NODE_ENV !== "production") {
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  }
  return false;
}

const app = express();

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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { ok: false, error: "Too many requests, please try again later" },
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
const botsMap = {};

function getBot(symbol) {
  return botsMap[symbol] || null;
}

function getAllBots() {
  return Object.values(botsMap);
}

function createBotInstance(symbol, configOverrides = {}) {
  const existing = botsMap[symbol];
  if (existing) {
    // Jika bot sedang running, kembalikan instance yang ada (tidak bisa recreate saat live)
    if (existing.getState().running) return existing;

    // Jika bot berhenti, recreate dengan kredensial terbaru (user bisa ganti API key)
    delete botsMap[symbol];
  }
  const bot = new BotEngine({ symbol, ...configOverrides });
  botsMap[symbol] = bot;
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
app.use("/api/v1/history", authMiddleware, createHistoryRouter({ getBot, getAllBots }));

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

// Broadcast bot logs to WebSocket clients
const originalEmit = BotEngine.prototype.emit;
BotEngine.prototype.emit = function (event, ...args) {
  if (event === "log") {
    wss.clients.forEach((client) => {
      if (client.readyState === 1 && (!client.botSymbol || client.botSymbol === this.config.symbol)) {
        client.send(JSON.stringify({ type: "log", symbol: this.config.symbol, data: args[0] }));
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
  })
  .catch((err) => {
    console.error("[STARTUP] Gagal inisialisasi database:", err.message);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[SHUTDOWN] SIGTERM received, shutting down gracefully...");
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
});

module.exports = { app, server, wss };
