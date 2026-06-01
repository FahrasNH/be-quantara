// ─────────────────────────────────────────────
// server.js — Express API + WebSocket Server
// Multi-bot management with real-time updates
// ─────────────────────────────────────────────

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const BotEngine = require("./bot-engine");
const logger = require("./logger");
const { createExchangeClient } = require("./exchange-factory");

// ==========================================
// SETUP
// ==========================================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors({
  origin: process.env.FE_URL || "*",
  credentials: true,
}));
app.use(express.json());

// Global bots registry
const bots = new Map();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
  res.header("Content-Type", "application/json");
  next();
});

// ==========================================
// HEALTH CHECK
// ==========================================
app.get("/", (req, res) => {
  res.json({
    name: "Quantara Bot API",
    version: "1.0.0",
    status: "running",
    botsCount: bots.size,
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// ==========================================
// BOT STATUS ENDPOINTS
// ==========================================

// Get all bots status
app.get("/api/bot/status", (req, res) => {
  const statuses = Array.from(bots.values()).map(bot => bot.getSnapshot());
  res.json({
    success: true,
    bots: statuses,
    count: bots.size,
  });
});

// Get specific bot status
app.get("/api/bot/:botId/status", (req, res) => {
  const bot = bots.get(req.params.botId);

  if (!bot) {
    return res.status(404).json({
      success: false,
      error: "Bot not found",
    });
  }

  res.json({
    success: true,
    bot: bot.getSnapshot(),
  });
});

// Get specific bot trades
app.get("/api/bot/:botId/trades", (req, res) => {
  const bot = bots.get(req.params.botId);

  if (!bot) {
    return res.status(404).json({
      success: false,
      error: "Bot not found",
    });
  }

  res.json({
    success: true,
    botId: req.params.botId,
    trades: bot.state.trades,
    count: bot.state.trades.length,
  });
});

// Get all trades across all bots
app.get("/api/trades", (req, res) => {
  const allTrades = Array.from(bots.values())
    .flatMap(bot => bot.state.trades.map(trade => ({
      ...trade,
      botId: bot.botId,
      symbol: bot.config.symbol,
    })));

  res.json({
    success: true,
    trades: allTrades,
    count: allTrades.length,
  });
});

// ==========================================
// BOT CONTROL ENDPOINTS
// ==========================================

// Start new bot
app.post("/api/bot/start", async (req, res) => {
  try {
    const { symbol, params, exchange = "bitget", dryRun = true } = req.body;

    if (!symbol || !params) {
      return res.status(400).json({
        success: false,
        error: "Missing symbol or params",
      });
    }

    const botId = `bot_${symbol}_${Date.now()}`;

    const config = {
      symbol,
      exchange,
      dryRun,
      marginCoin: params.marginCoin || "USDT",
      emaFast: params.emaFast || 9,
      emaSlow: params.emaSlow || 21,
      rsiPeriod: params.rsiPeriod || 14,
      rsiOverbought: params.rsiOverbought || 70,
      rsiOversold: params.rsiOversold || 30,
      atrPeriod: params.atrPeriod || 14,
      atrMultiplier: params.atrMultiplier || 2,
      riskReward: params.riskReward || 3,
      riskPerTrade: params.riskPerTrade || 0.02,
      maxPositions: params.maxPositions || 1,
      leverage: params.leverage || 3,
      useBothSides: params.useBothSides || false,
      interval: params.interval || "4H",
      checkInterval: params.checkInterval || 60000,
    };

    const bot = new BotEngine(botId, config);

    // Attach event listeners untuk WebSocket broadcast
    bot.on("price", (data) => broadcastUpdate(botId, "price", data));
    bot.on("trade", (data) => broadcastUpdate(botId, "trade", data));
    bot.on("balance", (data) => broadcastUpdate(botId, "balance", data));
    bot.on("error", (data) => broadcastUpdate(botId, "error", data));
    bot.on("started", (data) => broadcastUpdate("all", "started", { ...data, symbol }));
    bot.on("stopped", (data) => broadcastUpdate("all", "stopped", { ...data, symbol }));

    bots.set(botId, bot);

    // Start bot asynchronously
    bot.start().catch(err => logger.error(`[${botId}] Start failed:`, err.message));

    res.json({
      success: true,
      botId,
      symbol,
      message: `Bot ${symbol} started`,
    });
  } catch (err) {
    logger.error("POST /api/bot/start error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Stop bot
app.post("/api/bot/stop", async (req, res) => {
  try {
    const { botId } = req.body;

    if (!botId) {
      return res.status(400).json({
        success: false,
        error: "Missing botId",
      });
    }

    const bot = bots.get(botId);

    if (!bot) {
      return res.status(404).json({
        success: false,
        error: "Bot not found",
      });
    }

    await bot.stop();
    bots.delete(botId);

    res.json({
      success: true,
      message: `Bot ${botId} stopped`,
    });
  } catch (err) {
    logger.error("POST /api/bot/stop error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ==========================================
// EXCHANGE ENDPOINTS
// ==========================================

// Test exchange connection
app.post("/api/exchange/connect", async (req, res) => {
  try {
    const client = createExchangeClient();
    const balance = await client.getBalance("USDT");

    res.json({
      success: true,
      balance,
      message: "Connected to exchange",
    });
  } catch (err) {
    logger.error("Exchange connect error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Get balance
app.get("/api/balance", async (req, res) => {
  try {
    const client = createExchangeClient();
    const balance = await client.getBalance("USDT");

    res.json({
      success: true,
      balance,
    });
  } catch (err) {
    logger.error("GET /api/balance error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// ==========================================
// WEBSOCKET
// ==========================================

function broadcastUpdate(botId, type, payload) {
  const message = JSON.stringify({
    type,
    botId,
    payload,
    timestamp: Date.now(),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // OPEN
      client.send(message);
    }
  });
}

wss.on("connection", (ws) => {
  logger.info("WebSocket client connected");

  // Send initial state
  const initialState = {
    type: "init",
    payload: {
      bots: Array.from(bots.values()).map(bot => bot.getSnapshot()),
    },
    timestamp: Date.now(),
  };

  ws.send(JSON.stringify(initialState));

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      logger.debug("WebSocket message:", msg);
      // Handle client messages if needed
    } catch (err) {
      logger.warn("Invalid WebSocket message:", err.message);
    }
  });

  ws.on("close", () => {
    logger.info("WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    logger.error("WebSocket error:", err.message);
  });
});

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {
  logger.error("Express error:", err.message);
  res.status(500).json({
    success: false,
    error: err.message,
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Not found",
  });
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

async function shutdown() {
  logger.warn("Shutting down server...");

  // Stop all bots
  for (const [botId, bot] of bots) {
    await bot.stop();
  }

  // Close WebSocket server
  wss.close();

  // Close HTTP server
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.error("Forced shutdown");
    process.exit(1);
  }, 10000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  logger.separator("QUANTARA BOT API SERVER");
  logger.info(`🚀 Server running on http://${HOST}:${PORT}`);
  logger.info(`📡 WebSocket: ws://${HOST}:${PORT}`);
  logger.info(`🔗 CORS enabled for: ${process.env.FE_URL || "all origins"}`);
  logger.separator();
});

module.exports = server;
