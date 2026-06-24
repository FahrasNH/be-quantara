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
const { getStrategy } = require("../domain/legacyStrategies");
const { createExchangeClient } = require("../infrastructure/exchange");
const db     = require("../infrastructure/db/database");
const backup = require("../infrastructure/backup/BackupScheduler");
const telegramBot = require("../infrastructure/notifications/TelegramBotPoller");

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
// PAIR-TIER: klasifikasi pair (LIQUID/STABLE/VOLATILE) untuk override SL/posisi
// + filter strategi. Dipakai di createBot*/resume agar override SELALU diterapkan,
// tidak peduli bot dibuat lewat start manual atau auto-resume.
const { pairClassifier } = require("../infrastructure/classification/PairClassifier");

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

// ── Per-user START mutex (BUG-FIX-03) ──────────────────────────────────────
// "Start All" menembak N POST /start serentak. Tanpa serialisasi, tiap request
// membaca committedMargin SEBELUM request lain sempat reserve → semua lolos gate
// (TOCTOU) lalu reserve bareng → akun over-allocate (utilisasi 536%). Mutex per
// user men-serialisasi bagian kritis "refresh equity → gate → reserve" sehingga
// reservasi bot ke-1 sudah terlihat oleh bot ke-2. Hanya bagian itu yang dikunci
// (cepat); start engine yang lambat tetap berjalan paralel di latar belakang.
const startLocks = new Map(); // userId -> Promise (lock saat ini)

async function acquireStartLock(userId) {
  while (startLocks.get(userId)) {
    try { await startLocks.get(userId); } catch { /* lock sebelumnya selesai */ }
  }
  let release;
  const held = new Promise((r) => { release = r; });
  startLocks.set(userId, held);
  return () => { startLocks.delete(userId); release(); };
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

/**
 * EMERGENCY: stop & drop EVERY in-memory BotEngine across ALL users (admin
 * Stop-All — ADMIN-BE-05). Mirrors stopAllUserBotsInMemory but platform-wide.
 * Returns { stopped, failed } counts. Engine.stop() handles position close-out.
 */
function stopAllBotsInMemory() {
  let stopped = 0, failed = 0;
  const userIds = new Set();
  for (const [key, instance] of Object.entries(botsMap)) {
    userIds.add(key.split(":")[0]);
    try {
      if (instance.getState?.().running) { instance.stop(); stopped++; }
    } catch { failed++; }
  }
  for (const key of Object.keys(botsMap)) delete botsMap[key];
  for (const uid of userIds) delete coordinatorsMap[uid];
  return { stopped, failed };
}

function createBotInstance(userId, symbol, configOverrides = {}) {
  const key = makeKey(userId, symbol);
  const existing = botsMap[key];
  if (existing) {
    // Kembalikan instance yang ada bila sedang running atau dalam proses start
    const st = existing.getState();
    if (st.running || st.starting) {
      if (configOverrides.botId) existing.config.botId = configOverrides.botId;
      return existing;
    }

    // Bot berhenti → recreate dengan kredensial terbaru (user bisa ganti API key)
    delete botsMap[key];
  }
  // PAIR-TIER override juga untuk engine tunggal (legacy/non-multi).
  const _singlePair = pairClassifier.classify(symbol);
  const bot = new BotEngine({
    symbol,
    botKey:      key,
    coordinator: getCoordinator(userId), // koordinasi margin lintas-bot (#5)
    pairTier:                   _singlePair.tier,
    pairSlMultiplier:           _singlePair.paramOverrides.slMultiplier,
    pairPositionSizeAdjustment: _singlePair.paramOverrides.positionSizeAdjustment,
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
 * Hitung leverage adaptif berdasarkan equity akun — user tidak perlu pikirkan,
 * bot auto-scale leverage agar lolos min-notional untuk akun kecil & aman untuk akun besar.
 * @param {boolean} dryRun
 * @param {string} exchangeType
 * @param {string} apiKey
 * @param {string} apiSecret
 * @param {string} passphrase
 * @returns {Promise<number>} leverage tier (1–5)
 */
async function getAdaptiveLeverage(dryRun, exchangeType, apiKey, apiSecret, passphrase) {
  let equity = 0;

  if (dryRun) {
    // Dry run: gunakan virtual balance dari env (default $1000)
    equity = parseFloat(process.env.DRY_RUN_VIRTUAL_BALANCE) || 1000;
  } else {
    // Live: fetch real equity dari exchange
    try {
      const client = createExchangeClient(exchangeType, { apiKey, apiSecret, passphrase });
      const balance = await client.getBalance("USDT");
      equity = balance?.equity || balance?.available || 0;
    } catch (err) {
      // Fallback jika exchange error: gunakan modal minimum (konservatif)
      equity = 100;
    }
  }

  // Tier leverage berdasarkan equity — lolos min-notional kecil, safe untuk besar
  if (equity < 100)      return 5;  // Akun sangat kecil: max leverage
  if (equity < 1000)     return 3;  // Akun kecil: moderate leverage
  if (equity < 10000)    return 2;  // Akun menengah: low leverage
  return 1;                          // Akun besar: no leverage (capital preservation)
}

/**
 * Buat instance MultiStrategyCoordinator untuk satu koin (fitur Auto Multi-Strategy
 * Execution per Coin). Koordinator ini disimpan di botsMap pada slot yang sama
 * dengan BotEngine sehingga route/WS memperlakukannya identik (getState/start/stop).
 *
 * @param {string} userId
 * @param {string} symbol
 * @param {Object} opts  — { strategies[], capital, dryRun, apiKey, apiSecret, passphrase, botId }
 * @returns {Promise<MultiStrategyCoordinator>}
 */
async function createMultiStrategyInstance(userId, symbol, opts = {}) {
  const key = makeKey(userId, symbol);
  const existing = botsMap[key];
  if (existing) {
    const st = existing.getState();
    if (st.running || st.starting) return existing;
    // Stop instance SEBELUM delete untuk cleanup interval + listener. Saat interval
    // tetap jalan setelah delete, memori bocor: engine terus tick di memory tanpa ada
    // yang mengarahkan state. Ini penyebab utama OOM-leak saat re-create coordinator.
    try { await existing.stop(); } catch (e) { console.warn(`[Cleanup] stop ${symbol} gagal: ${e.message}`); }
    delete botsMap[key];
  }

  const accountCoordinator = getCoordinator(userId);

  // Klasifikasi tier pair → ambil override SL & ukuran posisi (lihat engineConfig).
  const _pairClass = pairClassifier.classify(symbol);
  const _pairOverrides = {
    tier:                   _pairClass.tier,
    slMultiplier:           _pairClass.paramOverrides.slMultiplier,
    positionSizeAdjustment: _pairClass.paramOverrides.positionSizeAdjustment,
  };

  // SATU ccxt client dipakai bersama oleh ke-4 engine pada koin/akun ini. TANPA ini,
  // tiap engine (4 per koin) memuat cache market exchange-nya sendiri — Binance ~2000
  // market × blob `info` = ~5–15MB per client. 4× per koin × N koin = ratusan MB
  // duplikat → penyumbang UTAMA OOM. Karena ke-4 engine berbagi user+symbol+exchange+
  // akun yang sama, mereka aman berbagi satu client (rate-limiter pun jadi 1 antrian
  // → tekanan API berkurang). `stop()` tidak menutup client, jadi sibling tak terganggu.
  const sharedExchangeClient = createExchangeClient(opts.exchangeType || "bitget", {
    apiKey:        opts.apiKey,
    apiSecret:     opts.apiSecret,
    apiPassphrase: opts.passphrase,
  });

  // engineFactory di-INJECT ke koordinator → satu AdaptiveStrategyEngine per strategi,
  // berbagi AccountCoordinator + kredensial user. cfg dari koordinator sudah berisi
  // strategyKey/capital/dryRun/botKey/groupKey.
  const engineFactory = (strategyKey, cfg2) => {
    const eng = new AdaptiveStrategyEngine({
      ...cfg2,
      coordinator: accountCoordinator,
      exchangeType: opts.exchangeType || "bitget",
      apiKey:      opts.apiKey,
      apiSecret:   opts.apiSecret,
      passphrase:  opts.passphrase,
      botId:       opts.botId,
    });
    // Ganti client per-engine (baru dibuat, market BELUM dimuat = nyaris gratis)
    // dengan client bersama → cache market dimuat SEKALI per koin, bukan 4×.
    eng.client = sharedExchangeClient;
    return eng;
  };

  // Leverage adaptif berdasarkan equity akun — user tinggal pilih koin & running,
  // leverage otomatis adjust (akun kecil 5×, besar 1×). Lolos min-notional untuk
  // akun kecil (BTC min-size 0.001 butuh leverage jika equity < $100), aman untuk
  // akun besar (leverage rendah = jarak likuidasi jauh dari SL). Position size tetap
  // dibatasi riskPerTrade per-strategi; risk tidak berubah, hanya notional yang scale.
  const sharedLeverage = await getAdaptiveLeverage(
    opts.dryRun,
    opts.exchangeType || "bitget",
    opts.apiKey,
    opts.apiSecret,
    opts.passphrase
  );

  const coordinator = new MultiStrategyCoordinator({
    userId,
    symbol,
    strategies:   opts.strategies,
    totalCapital: opts.capital,
    engineFactory,
    accountCoordinator,
    dryRun:       opts.dryRun,
    conflictMode: process.env.MULTI_STRATEGY_CONFLICT_MODE || "skip",
    engineConfig: {
      botId:        opts.botId,
      // Exchange creds in engineConfig so coordinator can make a single pre-flight
      // balance + leverage call instead of N calls (one per engine).
      exchangeType: opts.exchangeType || "bitget",
      apiKey:       opts.apiKey,
      apiSecret:    opts.apiSecret,
      passphrase:   opts.passphrase,
      // Leverage konservatif (min lintas-strategi) yang di-set sekali per-symbol.
      leverage:     sharedLeverage,
      // PAIR-TIER override: SL/posisi disesuaikan tier pair (VOLATILE 1.5×SL/0.6×size,
      // STABLE 1.1×/0.9×, LIQUID 1×/1×). Diklasifikasi di sini agar SELALU aktif baik
      // dari start manual maupun auto-resume (sebelumnya hanya dihitung di route start
      // lalu dibuang → override tidak pernah benar-benar diterapkan ke trade).
      pairTier:                   _pairOverrides.tier,
      pairSlMultiplier:           _pairOverrides.slMultiplier,
      pairPositionSizeAdjustment: _pairOverrides.positionSizeAdjustment,
    },
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
app.use("/api/v1/bots", authMiddleware, createBotsRouter({ getBot, getAllBots, createBotInstance, createMultiStrategyInstance, removeBotInstance, sharedClient, getCoordinator, acquireStartLock }));

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
app.use("/api/v1/admin",   createAdminRouter({ stopAllBotsInMemory, getBot })); // routes self-guard (JWT+role); ADMIN_SECRET only for the legacy billing stub

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

  // Snapshot status live per bot saat koneksi WS dibuka. HANYA status (bukan log).
  //
  // PENTING: log TIDAK lagi di-replay di sini. Sebelumnya tiap reconnect membanjiri
  // client dengan ≤100 log × N bot (mis. 9 bot = ~900 frame) — itulah penyebab
  // "logs muncul tiap 2 detik" & kartu "loncat-loncat": tiap kali server restart
  // (OOM) → WS putus → reconnect → replay storm → re-render massal. Log sudah
  // di-hydrate FE dari DB (GET /bots/logs) + localStorage, jadi replay WS redundan.
  // FIX: hanya kirim snapshot status milik userId yang terautentikasi.
  getAllBots(wsUserId).forEach((instance) => {
    const symbol = instance.config?.symbol;
    if (!symbol) return;
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: "status", symbol, data: instance.getState() }));
      } catch { /* client mungkin sudah disconnect */ }
    }
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      // Heartbeat: FE kirim {type:"ping"} tiap 30s. Balas pong agar koneksi
      // dianggap hidup oleh client & proxy (cegah putus saat idle).
      if (msg.type === "ping") {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
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
//
// PERF (300+ bots): status events di-debounce 1s per-symbol agar 900 engines
// yang ticking serentak tidak membanjiri WS client dengan 15 frames/detik.
// Log events tidak di-debounce — tiap entry langsung dikirim.
const _wsStatusDebounce = new Map(); // symbol → { timer, payload }

function _broadcastToClients(botUserId, symbol, payload) {
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

const originalEmit = BotEngine.prototype.emit;
BotEngine.prototype.emit = function (event, ...args) {
  const symbol    = this.config?.symbol;
  const botUserId = this.config?.userId;
  if (!symbol) return originalEmit.call(this, event, ...args);

  if (event === "log") {
    _broadcastToClients(botUserId, symbol, { type: "log", symbol, data: args[0] });
  } else if (event === "status") {
    // Engine bagian dari MultiStrategyCoordinator → siarkan STATE TERAGREGASI
    // koordinator (modal/PnL/posisi gabungan 4 strategi), bukan state parsial 1
    // engine. Tanpa ini, status teragregasi hanya muncul saat poll 60s → kartu FE
    // tampak "tidak update" walau bot ticking tiap 30s–5m.
    const coord = this.config?.groupCoordinator;
    const statusData = (coord && typeof coord.getState === "function")
      ? coord.getState()
      : args[0];

    // Debounce: batalkan timer sebelumnya, set ulang dengan payload terbaru.
    // Ini memastikan hanya 1 status frame/detik per symbol yang dikirim ke FE
    // walau banyak engine emit status dalam waktu bersamaan.
    const existing = _wsStatusDebounce.get(symbol);
    if (existing) clearTimeout(existing.timer);

    const payload = { type: "status", symbol, data: statusData };
    const timer = setTimeout(() => {
      _wsStatusDebounce.delete(symbol);
      _broadcastToClients(botUserId, symbol, payload);
    }, 1000);
    _wsStatusDebounce.set(symbol, { timer, payload });
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
    // PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
    const prisma = require("../infrastructure/db/prismaClient");
    const { getExchangeCredentials } = require("../services/userExchange");

    const bots = await prisma.bot.findMany({
      where: { running: true },
    });

    // Log tanpa syarat → penanda pasti bahwa kode auto-resume sudah ter-deploy.
    console.log(`[Startup] 🔁 Auto-resume: ${bots.length} bot dengan running=true ditemukan`);

    let resumed = 0, stopped = 0;

    // PERF vs OOM trade-off: 3-worker pool memicu OOM-leak saat 10+ bots (40+ engines
    // × 40MB each). Kurangi ke 1 worker = resume sequential. Bot ke-10 mungkin butuh
    // menit untuk selesai, tapi at least proses tidak tembus ceiling. Memory leak
    // (saat resume engine tidak ter-cleanup) tetap ada tapi perlahan (300ms antar-bot),
    // jadi proses bisa stabil di bawah 3GB sampai semua resume selesai.
    async function resumeOneBot(bot) {
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
          return;
        }

        const exchangeType = (connectedExchange || "bitget").toLowerCase();
        if (!bot.dryRun && exchangeType === "okx" && !passphrase) {
          await prisma.bot.update({ where: { id: bot.id }, data: { running: false, stoppedAt: new Date() } });
          stopped++;
          console.warn(`[Startup] Bot LIVE ${bot.symbol} OKX tanpa passphrase → stopped`);
          return;
        }

        // Pilih path resume: multi-strategy jika flag ON.
        // Selalu ambil tier strategies terkini agar upgrade tier langsung berlaku
        // tanpa perlu stop+start manual. DB strategyGroup dipakai sebagai fallback.
        let strategies = null;

        if (MULTI_STRATEGY_ENABLED) {
          try {
            const mode = bot.dryRun ? "dry" : "live";
            const tierStrategies = await getTierStrategies(bot.userId, mode);
            const dbStrategies = Array.isArray(bot.strategyGroup) && bot.strategyGroup.length > 0
              ? bot.strategyGroup
              : [];
            // Pakai tier strategies jika lebih banyak dari yang tersimpan di DB
            // (tier upgrade), atau tier strategies jika DB kosong.
            strategies = tierStrategies.length >= dbStrategies.length
              ? tierStrategies
              : dbStrategies;
            // Sync DB jika tier strategies berbeda dari yang tersimpan
            if (JSON.stringify(strategies) !== JSON.stringify(dbStrategies)) {
              await prisma.bot.update({
                where: { id: bot.id },
                data: { strategyGroup: strategies, strategyKey: strategies[0] },
              }).catch(() => {});
            }
          } catch (_) {
            strategies = Array.isArray(bot.strategyGroup) && bot.strategyGroup.length > 0
              ? bot.strategyGroup
              : null;
          }
        }

        // PAIR-TIER: terapkan filter strategi VOLATILE SAAT RESUME juga (sebelumnya
        // hanya di route start). Tanpa ini, tiap restart server me-resume bot VOLATILE
        // dengan SEMUA 4 strategi tier → aturan "MR only" pada pair berisiko tinggi
        // dilanggar diam-diam. Sinkronkan juga ke DB agar kartu menampilkan jumlah benar.
        if (Array.isArray(strategies) && strategies.length > 0) {
          const pc = pairClassifier.classify(bot.symbol);
          if (pc.tier === "VOLATILE") {
            const filtered = strategies.filter(s => !pc.blockedStrategies.includes(s));
            const volStrategies = filtered.length > 0 ? filtered : ["MEAN_REVERSION"];
            if (JSON.stringify(volStrategies) !== JSON.stringify(strategies)) {
              strategies = volStrategies;
              await prisma.bot.update({
                where: { id: bot.id },
                data: { strategyGroup: strategies, strategyKey: strategies[0] },
              }).catch(() => {});
              console.log(`[Startup] ${bot.symbol} VOLATILE → resume hanya [${strategies.join(",")}] (filter MR-only)`);
            }
          }
        }

        const useMulti = MULTI_STRATEGY_ENABLED && strategies && strategies.length > 0;

        let instance;
        if (useMulti) {
          instance = await createMultiStrategyInstance(bot.userId, bot.symbol, {
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

        // Re-check DB sebelum start: jika user sudah Stop All selagi kita warm-up
        // (set running=false via HTTP), batal — jangan re-start bot yang sudah
        // distop. Tanpa re-check ini ada race: stop endpoint tidak menemukan
        // instance (belum di-create), set DB running=false, tapi resumeOneBot lanjut
        // membuat instance baru & start → bot jalan lagi padahal DB=false.
        const fresh = await prisma.bot.findUnique({ where: { id: bot.id }, select: { running: true } });
        if (!fresh?.running) {
          console.log(`[Startup] Skip resume ${bot.symbol} — sudah di-stop selagi warm-up`);
          return;
        }
        // Jangan panggil start() bila instance sudah running ATAU sedang starting:
        // memanggil start() pada coordinator yang masih warm-up melempar "sedang dalam
        // proses start" → resume bot ini GAGAL (gejala: NEAR tak pernah tampil ROI/live
        // PnL sementara WLD muncul). Cukup lewati; instance yang sedang start akan
        // menyelesaikan warm-up-nya sendiri.
        const liveState = instance.getState();
        if (!liveState.running && !liveState.starting) await instance.start();
        resumed++;
      } catch (e) {
        console.warn(`[Startup] Gagal resume ${bot.symbol}: ${e.message}`);
      }
    }

    // Dedupe per (user, symbol): bila ada >1 baris bot untuk simbol sama (data lama/
    // duplikat), dua worker bisa me-resume coordinator yang SAMA paralel → satu set
    // starting=true, satu lagi panggil start() lagi → throw "sedang dalam proses start"
    // → bot itu gugur resume (mis. NEAR). Resume cukup satu per (user, symbol).
    const seenResumeKeys = new Set();
    const resumeQueue = bots.filter(b => {
      const k = `${b.userId}::${b.symbol}`;
      if (seenResumeKeys.has(k)) {
        console.warn(`[Startup] Lewati duplikat resume ${b.symbol} (baris bot ganda untuk user ${b.userId})`);
        return false;
      }
      seenResumeKeys.add(k);
      return true;
    });
    async function resumeWorker() {
      while (resumeQueue.length) {
        const bot = resumeQueue.shift();
        await resumeOneBot(bot);
        // 300ms inter-start breathing room untuk exchange rate-limiter
        if (resumeQueue.length > 0) await new Promise(r => setTimeout(r, 300));
      }
    }
    // Sequential resume (1 worker) untuk hindari OOM spike saat 10+ bots.
    await resumeWorker();

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
    // Dynamic pair classification dari CoinGecko (refresh tiap 4 jam, non-blocking)
    pairClassifier.refreshDynamic().catch(() => {});
    setInterval(() => pairClassifier.refreshDynamic().catch(() => {}), 4 * 60 * 60 * 1000);
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
