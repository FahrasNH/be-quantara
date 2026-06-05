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

// ── CORS & Security ────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://187.77.135.156",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const app = express();

// Security
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
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
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { ok: false, error: "Too many requests, please try again later" },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // stricter limit for auth
  skip: (req) => req.method !== "POST",
});

app.use("/api/v1/auth/", authLimiter);
app.use("/api/v1/", limiter);

// ── Bot Management (In-Memory) ─────────────────────────────────────────────
const botsMap = {};

function getBot(symbol) {
  return botsMap[symbol] || null;
}

function getAllBots() {
  return Object.values(botsMap);
}

function createBotInstance(symbol, configOverrides = {}) {
  if (botsMap[symbol]) {
    return botsMap[symbol];
  }
  const bot = new BotEngine({ symbol, ...configOverrides });
  botsMap[symbol] = bot;
  return bot;
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health check (public)
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Auth routes (public)
app.use("/api/v1/auth", createAuthRouter());

// Protected routes below this line
app.use("/api/v1/", authMiddleware);

// Bots routes (protected, user-isolated)
app.use("/api/v1/bots", createBotsRouter({ getBot, getAllBots, createBotInstance }));

// Market routes (protected)
app.use("/api/v1/market", createMarketRouter({ createExchangeClient }));

// History routes (protected)
app.use("/api/v1/history", createHistoryRouter({ getBot, getAllBots }));

// Backtest routes (protected)
app.use("/api/v1/backtest", createBacktestRouter());

// Legacy routes (protected - deprecated)
app.use("/api/v1/legacy", createLegacyRouter({ getBot, getAllBots }));

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

server.listen(PORT, () => {
  console.log(`\n🚀 Quantara Bot Server running on ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:5173`);
  console.log(`🔐 Auth enabled`);
  console.log(`📡 WebSocket: ws://localhost:${PORT}/ws\n`);
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
