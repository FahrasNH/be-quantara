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
