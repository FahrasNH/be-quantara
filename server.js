// ─────────────────────────────────────────────
// server.js — Quantara API Server
// HTTP + WebSocket server untuk FE integration
//
// Cara pakai:
//   node server.js        (production)
//   nodemon server.js     (development)
//   npm run dev
// ─────────────────────────────────────────────

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const http    = require("http");
const { WebSocketServer } = require("ws");
const BotEngine = require("./bot-engine");
const db        = require("./db");

const PORT = parseInt(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

// ── Express ──
const app = express();
app.use(cors());           // Allow all origins (dev friendly)
app.use(express.json());

// ── HTTP + WebSocket server ──
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── Bot engine ──
const bot = new BotEngine();

// ── Broadcast ke semua WS client ──
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

// Forward bot events ke WS
bot.on("log",    entry => broadcast({ type: "log",    data: entry }));
bot.on("status", state => broadcast({ type: "status", data: state }));

// ── WebSocket connection ──
wss.on("connection", ws => {
  console.log("[WS] Client terhubung");

  // Kirim 100 log terakhir saat konek
  bot.getLogs(100).forEach(entry => {
    ws.send(JSON.stringify({ type: "log", data: entry }));
  });

  // Kirim status saat ini
  ws.send(JSON.stringify({ type: "status", data: bot.getState() }));

  ws.on("close", () => console.log("[WS] Client terputus"));
  ws.on("error", err => console.error("[WS] Error:", err.message));
});

// ─────────────────────────────────────────────
// HTTP ROUTES
// ─────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok:        true,
    timestamp: new Date().toISOString(),
    version:   "1.0.0",
    bot:       bot.getState().running ? "running" : "stopped",
  });
});

// Status bot
app.get("/api/status", (req, res) => {
  res.json(bot.getState());
});

// Konfigurasi bot (tanpa API key)
app.get("/api/config", (req, res) => {
  res.json(bot.getConfig());
});

// Log history
app.get("/api/logs", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
  res.json(bot.getLogs(limit));
});

// Balance dari exchange
app.get("/api/balance", async (req, res) => {
  try {
    const bal = await bot.client.getBalance("USDT");
    res.json(bal);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Posisi terbuka dari exchange
app.get("/api/positions", async (req, res) => {
  try {
    const pos = await bot.client.getPositions(bot.config.symbol);
    res.json(pos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candles (untuk backtest di FE)
app.get("/api/candles", async (req, res) => {
  try {
    const symbol   = req.query.symbol   || bot.config.symbol;
    const interval = req.query.interval || bot.config.interval;
    const limit    = Math.min(parseInt(req.query.limit) || 200, 500);
    const candles  = await bot.client.getCandles(symbol, interval, limit);
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candles historis untuk backtest — fetch paginated hingga 1000 candles
const INTERVAL_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000, "12h": 43_200_000,
  "1d": 86_400_000, "1w": 604_800_000,
};
app.get("/api/candles/backtest", async (req, res) => {
  try {
    const symbol    = req.query.symbol   || bot.config.symbol;
    const timeframe = req.query.interval || "1d";
    const total     = Math.min(parseInt(req.query.limit) || 500, 1000);
    const PAGE      = 200;
    const msPerBar  = INTERVAL_MS[timeframe] || 86_400_000;

    const allCandles = [];
    // Fetch from oldest to newest: calculate starting point
    let since = Date.now() - total * msPerBar;

    while (allCandles.length < total) {
      const remaining = total - allCandles.length;
      const batch = await bot.client.getCandles(symbol, timeframe, Math.min(remaining, PAGE), since);
      if (!batch || batch.length === 0) break;
      allCandles.push(...batch);
      // Advance since past last candle
      since = batch[batch.length - 1].timestamp + msPerBar;
      if (batch.length < Math.min(remaining, PAGE)) break; // reached end
    }

    // Deduplicate by timestamp, sort ascending
    const seen   = new Set();
    const unique = allCandles
      .filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
      .sort((a, b) => a.timestamp - b.timestamp);

    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start bot
app.post("/api/bot/start", async (req, res) => {
  try {
    await bot.start();
    res.json({ ok: true, message: "Bot berhasil dijalankan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Stop bot
app.post("/api/bot/stop", async (req, res) => {
  try {
    await bot.stop();
    res.json({ ok: true, message: "Bot berhasil dihentikan" });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────
// DATABASE ENDPOINTS
// ─────────────────────────────────────────────

// Daftar sesi bot dari DB
app.get("/api/sessions", (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit) || 20, 100);
    const sessions = db.getSessions(limit);
    res.json(sessions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Detail satu sesi
app.get("/api/sessions/:id", (req, res) => {
  try {
    const session = db.getSession(parseInt(req.params.id));
    if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
    res.json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Riwayat trade dari DB
app.get("/api/trades", (req, res) => {
  try {
    const sessionId = req.query.session_id ? parseInt(req.query.session_id) : null;
    const symbol    = req.query.symbol    || null;
    const limit     = Math.min(parseInt(req.query.limit) || 100, 1000);
    const trades    = db.getTrades({ sessionId, symbol, limit });
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Statistik trade per sesi
app.get("/api/trades/stats/:sessionId", (req, res) => {
  try {
    const stats = db.getTradeStats(parseInt(req.params.sessionId));
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equity curve dari DB
app.get("/api/equity/:sessionId", (req, res) => {
  try {
    const equity = db.getEquity(parseInt(req.params.sessionId));
    res.json(equity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Log dari DB (sesi tertentu)
app.get("/api/db/logs/:sessionId", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const logs  = db.getLogs(parseInt(req.params.sessionId), limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Info database
app.get("/api/db/info", (req, res) => {
  try {
    res.json({
      path:     db.getDbPath(),
      sessions: db.getSessions(1).length > 0 ? "ada data" : "kosong",
    });
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
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          return iface.address;
        }
      }
    }
    return "127.0.0.1";
  };

  const displayIP = HOST === "0.0.0.0" ? getLocalIP() : HOST;

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║      Quantara API Server — Ready             ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  HTTP  : http://${displayIP}:${PORT}`);
  console.log(`  WS    : ws://${displayIP}:${PORT}`);
  console.log(`  External: https://187.77.135.156:${PORT}`);
  console.log(`  Mode  : ${process.env.DRY_RUN !== "false" ? "DRY RUN" : "LIVE TRADING"}`);
  console.log(`  Exchange: ${process.env.EXCHANGE || "bitget"}`);
  console.log(`  CORS for: ${process.env.FE_URL || "all origins"}\n`);
});

// Graceful shutdown
async function shutdown(sig) {
  console.log(`\n[${sig}] Server shutting down...`);
  if (bot.getState().running) await bot.stop();
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
