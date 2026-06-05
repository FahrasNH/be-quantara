// ─── src/server/app.js ───────────────────────────────────────────────────────
// Quantara API Server — Multi-Bot (HTTP + WebSocket)
// Mendukung hingga 3 koin secara bersamaan.
// ─────────────────────────────────────────────────────────────────────────────

const express     = require("express");
const cors        = require("cors");
const compression = require("compression");
const helmet      = require("helmet");
const http        = require("http");
const { WebSocketServer } = require("ws");
const os = require("os");

const cfg        = require("../config/env");
const BotEngine  = require("../application/BotEngine");
const db         = require("../infrastructure/db/database");
const { createExchangeClient } = require("../infrastructure/exchange");
const { listStrategies }       = require("../domain/strategies");

// Route factories
const createBotsRouter    = require("./routes/bots-afs");
const createMarketRouter  = require("./routes/market");
const createHistoryRouter = require("./routes/history");
const createHealthRouter  = require("./routes/health");
const createBacktestRouter = require("./routes/backtest");
const createLegacyRouter  = require("./routes/legacy");

// ── Express + HTTP + WebSocket ─────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  "http://187.77.135.156",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const app    = express();
app.use(helmet({ contentSecurityPolicy: false })); // CSP off — agar WS & inline style tetap jalan
app.use(compression());
app.use(cors({
  origin: (origin, cb) => {
    // Izinkan request tanpa origin (curl, server-to-server) dan origin yang terdaftar
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error(`CORS: origin tidak diizinkan — ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── Bot Registry ──────────────────────────────────────────────────────────
const SYMBOLS_LIST = cfg.symbolsList;

// Shared exchange client untuk public market data
const sharedClient = createExchangeClient();

// Map: symbol → BotEngine
const bots = new Map();

for (const sym of SYMBOLS_LIST) {
  const capital       = cfg.capitalFor(sym);
  const savedStrategy = db.getSetting(`strategy_${sym}`) || cfg.STRATEGY;
  const bot           = new BotEngine({ symbol: sym, capital, strategy: savedStrategy });
  bots.set(sym, bot);
}

// Helper: ambil bot berdasarkan symbol (case-insensitive)
function getBot(sym) {
  return bots.get(sym?.toUpperCase()) ?? null;
}

// ── WebSocket broadcast ────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

// Forward event tiap bot ke WS
for (const [sym, bot] of bots) {
  bot.on("log",    entry => broadcast({ type: "log",    symbol: sym, data: entry }));
  bot.on("status", state => broadcast({ type: "status", symbol: sym, data: state }));
}

// ── WebSocket heartbeat — cegah Nginx/proxy timeout ──────────────────────
// Ping setiap 25 detik; jika client tidak jawab → putus & hapus
const WS_PING_INTERVAL = 25_000;
const wsPingTimer = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();   // browser WebSocket otomatis kirim pong
  });
}, WS_PING_INTERVAL);

wss.on("close", () => clearInterval(wsPingTimer));

// Kirim status semua bot + recent logs saat WS connect
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; }); // tandai client masih hidup

  console.log("[WS] Client terhubung");
  for (const [sym, bot] of bots) {
    bot.getLogs(50).forEach(entry =>
      ws.send(JSON.stringify({ type: "log", symbol: sym, data: entry }))
    );
    ws.send(JSON.stringify({ type: "status", symbol: sym, data: bot.getState() }));
  }
  ws.on("close", () => console.log("[WS] Client terputus"));
  ws.on("error", err => console.error("[WS] WS error:", err.message));
});

// ── Routes ─────────────────────────────────────────────────────────────────

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

// Strategies list
app.get("/api/strategies", (req, res) => res.json(listStrategies()));

// Modular route groups
const routeCtx = { bots, getBot, broadcast, sharedClient, SYMBOLS_LIST, healthChecker: null, db };
app.use("/api/bots",       createBotsRouter(routeCtx));
app.use("/api",            createMarketRouter(routeCtx));
app.use("/api",            createHistoryRouter({ SYMBOLS_LIST }));
app.use("/api",            createLegacyRouter(routeCtx));

// v1 API Routes — for PHASE 2 frontend integration
app.use("/api/v1/bots",     createBotsRouter(routeCtx));
app.use("/api/v1/health",   createHealthRouter(routeCtx));
app.use("/api/v1/history",  createHistoryRouter({ SYMBOLS_LIST }));
app.use("/api/v1/backtest", createBacktestRouter(routeCtx));

// ── Server Start ────────────────────────────────────────────────────────────
function getLocalIP() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) return iface.address;
      }
    }
  } catch { /* sandbox / docker environment */ }
  return "127.0.0.1";
}

server.listen(cfg.PORT, cfg.HOST, () => {
  const displayIP = cfg.HOST === "0.0.0.0" ? getLocalIP() : cfg.HOST;

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║    Quantara API Server — Multi-Bot Ready     ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  HTTP  : http://${displayIP}:${cfg.PORT}`);
  console.log(`  WS    : ws://${displayIP}:${cfg.PORT}`);
  console.log(`  Mode  : ${cfg.DRY_RUN ? "DRY RUN" : "LIVE TRADING"}`);
  console.log(`  Symbols: ${SYMBOLS_LIST.join(", ")}`);
  SYMBOLS_LIST.forEach(sym => {
    console.log(`    • ${sym} — Capital: $${cfg.capitalFor(sym)}`);
  });
  console.log();
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
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
  console.error("[FATAL] uncaughtException:", err.message, err.stack);
  // Jangan exit — biarkan PM2 yang restart jika perlu
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] unhandledRejection:", reason instanceof Error ? reason.stack : reason);
  // Jangan crash — log saja, PM2 akan restart jika process mati
});

module.exports = { app, server, bots, getBot };
