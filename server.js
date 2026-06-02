// ─────────────────────────────────────────────
// server.js — Quantara API Server (Multi-Bot)
// HTTP + WebSocket server untuk FE integration
// Mendukung hingga 3 koin secara bersamaan.
//
// Cara pakai:
//   node server.js        (production)
//   nodemon server.js     (development)
// ─────────────────────────────────────────────

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const http    = require("http");
const { WebSocketServer } = require("ws");
const BotEngine = require("./bot-engine");
const db        = require("./db");
const { createExchangeClient } = require("./exchange-factory");
const { listStrategies }       = require("./strategies");

const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// ── Express ──
const app = express();
app.use(cors());
app.use(express.json());

// ── HTTP + WebSocket server ──
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─────────────────────────────────────────────
// MULTI-BOT SETUP
// Baca SYMBOLS dari .env, buat BotEngine per symbol (max 3)
// ─────────────────────────────────────────────

const SYMBOLS_RAW  = process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT";
const SYMBOLS_LIST = SYMBOLS_RAW.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 3);

// Shared exchange client untuk ticker (tidak perlu auth untuk public data)
const sharedClient = createExchangeClient();

// Map: symbol → BotEngine
const bots = new Map();

for (const sym of SYMBOLS_LIST) {
  // Per-symbol capital override: CAPITAL_BTCUSDT, CAPITAL_ETHUSDT, dst.
  const capKey    = `CAPITAL_${sym}`;
  const capital   = parseFloat(process.env[capKey]) || parseFloat(process.env.CAPITAL) || 500;
  const bot       = new BotEngine({ symbol: sym, capital });
  bots.set(sym, bot);
}

// Helper: ambil bot berdasarkan symbol (case-insensitive)
function getBot(sym) {
  return bots.get(sym?.toUpperCase()) ?? null;
}

// ── Broadcast ke semua WS client ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

// Forward event tiap bot ke WS (sertakan symbol)
for (const [sym, bot] of bots) {
  bot.on("log",    entry => broadcast({ type: "log",    symbol: sym, data: entry }));
  bot.on("status", state => broadcast({ type: "status", symbol: sym, data: state }));
}

// ── WebSocket connection ──
wss.on("connection", ws => {
  console.log("[WS] Client terhubung");

  // Kirim status semua bot saat connect
  for (const [sym, bot] of bots) {
    bot.getLogs(50).forEach(entry =>
      ws.send(JSON.stringify({ type: "log", symbol: sym, data: entry }))
    );
    ws.send(JSON.stringify({ type: "status", symbol: sym, data: bot.getState() }));
  }

  ws.on("close", () => console.log("[WS] Client terputus"));
  ws.on("error", err => console.error("[WS] Error:", err.message));
});

// ─────────────────────────────────────────────
// HTTP ROUTES
// ─────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  const runningBots = [...bots.entries()]
    .filter(([, b]) => b.getState().running)
    .map(([sym]) => sym);
  res.json({
    ok:          true,
    timestamp:   new Date().toISOString(),
    version:     "2.0.0",
    symbols:     SYMBOLS_LIST,
    runningBots,
  });
});

// ─────────────────────────────────────────────
// TICKER — Harga real-time multi-symbol
// GET /api/tickers?symbols=BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT
// ─────────────────────────────────────────────
app.get("/api/tickers", async (req, res) => {
  try {
    const syms = (req.query.symbols || SYMBOLS_LIST.join(","))
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const result = {};
    await Promise.all(syms.map(async sym => {
      try {
        const t = await sharedClient.getTicker(sym);
        result[sym] = t;
      } catch {
        result[sym] = null;
      }
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// MULTI-BOT ENDPOINTS
// ─────────────────────────────────────────────

// Daftar semua bot dan statusnya
app.get("/api/bots", (req, res) => {
  const result = {};
  for (const [sym, bot] of bots) {
    result[sym] = bot.getState();
  }
  res.json(result);
});

// Status satu bot
app.get("/api/bots/:symbol", (req, res) => {
  const bot = getBot(req.params.symbol);
  if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
  res.json(bot.getState());
});

// Start satu bot
app.post("/api/bots/:symbol/start", async (req, res) => {
  const bot = getBot(req.params.symbol);
  if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
  try {
    await bot.start();
    res.json({ ok: true, symbol: req.params.symbol.toUpperCase(), message: "Bot berhasil dijalankan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Stop satu bot
app.post("/api/bots/:symbol/stop", async (req, res) => {
  const bot = getBot(req.params.symbol);
  if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
  try {
    await bot.stop();
    res.json({ ok: true, symbol: req.params.symbol.toUpperCase(), message: "Bot berhasil dihentikan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Start semua bot
app.post("/api/bot/start", async (req, res) => {
  const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
  const bot = getBot(sym);
  if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
  try {
    await bot.start();
    res.json({ ok: true, symbol: sym, message: "Bot berhasil dijalankan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Stop satu bot (legacy + new)
app.post("/api/bot/stop", async (req, res) => {
  const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
  const bot = getBot(sym);
  if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
  try {
    await bot.stop();
    res.json({ ok: true, symbol: sym, message: "Bot berhasil dihentikan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Status bot (legacy — gunakan bot pertama atau by ?symbol=)
app.get("/api/status", (req, res) => {
  const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
  const bot = getBot(sym) || [...bots.values()][0];
  res.json(bot.getState());
});

// Config bot
app.get("/api/config", (req, res) => {
  const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
  const bot = getBot(sym) || [...bots.values()][0];
  res.json(bot.getConfig());
});

// Log history
app.get("/api/logs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  const sym   = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
  const bot   = getBot(sym) || [...bots.values()][0];
  res.json(bot.getLogs(limit));
});

// Balance dari exchange
app.get("/api/balance", async (req, res) => {
  try {
    const anyBot = [...bots.values()][0];
    const bal    = await anyBot.client.getBalance("USDT");
    res.json(bal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Posisi terbuka
app.get("/api/positions", async (req, res) => {
  try {
    const sym  = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot  = getBot(sym) || [...bots.values()][0];
    const pos  = await bot.client.getPositions(bot.config.symbol);
    res.json(pos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candles
app.get("/api/candles", async (req, res) => {
  try {
    const sym      = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
    const bot      = getBot(sym) || [...bots.values()][0];
    const interval = req.query.interval || bot.config.interval;
    const limit    = Math.min(parseInt(req.query.limit) || 200, 500);
    const candles  = await sharedClient.getCandles(sym, interval, limit);
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candles historis untuk backtest
const INTERVAL_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000,
};
app.get("/api/candles/backtest", async (req, res) => {
  try {
    const symbol    = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
    const timeframe = req.query.interval || "1d";
    const total     = Math.min(parseInt(req.query.limit) || 500, 1000);
    const PAGE      = 200;
    const msPerBar  = INTERVAL_MS[timeframe] || 86_400_000;
    const allCandles = [];
    let since = Date.now() - total * msPerBar;

    while (allCandles.length < total) {
      const remaining = total - allCandles.length;
      const batch = await sharedClient.getCandles(symbol, timeframe, Math.min(remaining, PAGE), since);
      if (!batch || batch.length === 0) break;
      allCandles.push(...batch);
      since = batch[batch.length - 1].timestamp + msPerBar;
      if (batch.length < Math.min(remaining, PAGE)) break;
    }

    const seen   = new Set();
    const unique = allCandles
      .filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// STRATEGY ENDPOINTS
// ─────────────────────────────────────────────

// List semua strategi tersedia
app.get("/api/strategies", (req, res) => {
  res.json(listStrategies());
});

// Switch strategi untuk satu bot
// POST /api/bots/:symbol/strategy  { "strategy": "B" }
app.post("/api/bots/:symbol/strategy", async (req, res) => {
  const sym      = req.params.symbol.toUpperCase();
  const strategy = (req.body.strategy || "").toUpperCase();

  if (!["A", "B", "C"].includes(strategy)) {
    return res.status(400).json({ error: "Strategy tidak valid. Pilih: A, B, atau C" });
  }

  const oldBot = getBot(sym);
  if (!oldBot) return res.status(404).json({ error: "Symbol tidak tersedia" });

  const wasRunning = oldBot.getState().running;

  // Stop bot lama
  if (wasRunning) await oldBot.stop();
  oldBot.removeAllListeners();

  // Buat bot baru dengan strategi baru
  const capKey  = `CAPITAL_${sym}`;
  const capital = parseFloat(process.env[capKey]) || parseFloat(process.env.CAPITAL) || 500;
  const newBot  = new BotEngine({ symbol: sym, capital, strategy });

  // Register event listeners
  newBot.on("log",    entry => broadcast({ type: "log",    symbol: sym, data: entry }));
  newBot.on("status", state => broadcast({ type: "status", symbol: sym, data: state }));

  // Update map
  bots.set(sym, newBot);

  // Restart kalau sebelumnya running
  if (wasRunning) await newBot.start();

  res.json({
    ok:            true,
    symbol:        sym,
    strategy:      strategy,
    strategyLabel: newBot.config.strategyLabel,
    signalType:    newBot.config.signalType,
    restarted:     wasRunning,
    message:       `Strategi diganti ke [${strategy}] ${newBot.config.strategyLabel}${wasRunning ? " — bot di-restart otomatis" : ""}`,
  });
});

// ─────────────────────────────────────────────
// DATABASE ENDPOINTS
// ─────────────────────────────────────────────

app.get("/api/sessions", (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 20, 100);
    const symbol   = req.query.symbol || null;
    const sessions = db.getSessions(limit, symbol);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  try {
    const session = db.getSession(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/trades", (req, res) => {
  try {
    const sessionId = req.query.session_id ? parseInt(req.query.session_id) : null;
    const symbol    = req.query.symbol    || null;
    const limit     = Math.min(parseInt(req.query.limit) || 100, 1000);
    res.json(db.getTrades({ sessionId, symbol, limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/trades/stats/:sessionId", (req, res) => {
  try {
    res.json(db.getTradeStats(parseInt(req.params.sessionId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/equity/:sessionId", (req, res) => {
  try {
    res.json(db.getEquity(parseInt(req.params.sessionId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/logs/:sessionId", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    res.json(db.getLogs(parseInt(req.params.sessionId), limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/db/info", (req, res) => {
  try {
    res.json({ path: db.getDbPath(), symbols: SYMBOLS_LIST });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const os = require("os");
  const getLocalIP = () => {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
    return "127.0.0.1";
  };
  const displayIP = HOST === "0.0.0.0" ? getLocalIP() : HOST;

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║    Quantara API Server — Multi-Bot Ready     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  HTTP  : http://${displayIP}:${PORT}`);
  console.log(`  WS    : ws://${displayIP}:${PORT}`);
  console.log(`  Mode  : ${process.env.DRY_RUN !== "false" ? "DRY RUN" : "LIVE TRADING"}`);
  console.log(`  Symbols: ${SYMBOLS_LIST.join(", ")}`);
  SYMBOLS_LIST.forEach(sym => {
    const cap = process.env[`CAPITAL_${sym}`] || process.env.CAPITAL || 500;
    console.log(`    • ${sym} — Capital: $${cap}`);
  });
  console.log();
});

// Graceful shutdown — stop semua bot
async function shutdown(sig) {
  console.log(`\n[${sig}] Server shutting down...`);
  for (const [sym, bot] of bots) {
    if (bot.getState().running) {
      console.log(`  Stopping ${sym}...`);
      await bot.stop();
    }
  }
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", err => {
  console.error("[FATAL]", err.message, err.stack);
});
