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
const notifier = require("../infrastructure/notifications/TelegramNotifier");

// Middleware
const { authMiddleware } = require("../middleware/auth");
const { errorHandler } = require("../middleware/errorHandler");

// Routes
const createAuthRouter = require("./routes/auth");
const createBotsRouter = require("./routes/bots-afs");
const createMarketRouter = require("./routes/market");
const createHistoryRouter = require("./routes/history");
const createBacktestRouter = require("./routes/backtest");
const createAiRouter = require("./routes/ai");
const createLegacyRouter = require("./routes/legacy");
const createAccountRouter = require("./routes/account");
const createAdminRouter = require("./routes/admin");
const createSubscriptionRouter = require("./routes/subscription");
const createAdminVouchersRouter = require("./routes/adminVouchers");
const { createPaymentsRouter, createPaymentWebhookRouter } = require("./routes/payments");
const createAnalyticsRouter    = require("./routes/analytics");
const createMetaSelectorRouter = require("./routes/metaSelector");
const createParametersRouter   = require("./routes/parameters");

// ── Env validation (fail-fast sebelum boot) ─────────────────────────────────
cfg.validate();

const { isEmailConfigured } = require("../services/EmailService");
if (!isEmailConfigured()) {
  console.warn(
    "[startup] EMAIL_* belum dikonfigurasi — email verifikasi & reset password tidak akan terkirim."
  );
} else if (cfg.APP_URL === "http://localhost:5173") {
  console.warn(
    "[startup] APP_URL masih default localhost — link di email verifikasi/reset akan salah. Set APP_URL ke domain frontend."
  );
}

// ── Feature flags ─────────────────────────────────────────────────────────
// MULTI_STRATEGY_ENABLED: default ON; disable lewat env MULTI_STRATEGY_ENABLED=false.
const MULTI_STRATEGY_ENABLED = process.env.MULTI_STRATEGY_ENABLED !== "false";

// Entitlement service (dipakai resumeRunningBots untuk fallback tier-strategies)
const { getTierStrategies, getUserTier } = require("../services/entitlement");
// Cap account-wide posisi terbuka per-tier (fix meter "8/4"). Dipakai di resume
// agar cap di-set tanpa perlu start manual.
const { getMaxConcurrentPositions } = require("../domain/tierConfig");
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
  message: { ok: false, statusCode: 429, message: "Too many requests. Please wait a moment and try again." },
  skip: (req) => {
    if (process.env.NODE_ENV !== "production") return true;
    // Exempt backtest polling — called every few seconds during long-running jobs
    if (req.method === "GET" && (
      req.path.startsWith("/backtest/job-status/")
      || req.path.startsWith("/backtest/job-result/")
    )) return true;
    return false;
  },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_MAX,
  message: { ok: false, statusCode: 429, message: "Too many requests. Please wait a moment and try again." },
  skip: (req) => {
    // Rate limiting only in production
    if (process.env.NODE_ENV !== "production") return true;
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

  // → bump tier dinamis. Tanpa metrics → klasifikasi tier dasar (backward-compatible).
  // Diekstrak agar tidak ikut ter-spread ke config BotEngine.
  const { pairMetrics: _pairMetrics, ...engineOverrides } = configOverrides;

  // CoinGecko proxy/stale/skor di ambang tier), size & SL diperlakukan satu
  // tingkat lebih konservatif sampai data membaik. Backtest tak terpengaruh
  // (selalu Jalur 1 / confidence tinggi) — gate ini murni safety net live.
  const _singlePair = pairClassifier.applyConfidenceGate(
    pairClassifier.classify(symbol, _pairMetrics || null)
  );
  if (_singlePair.gated) {
    console.warn(`[PairTier] ${symbol}: confidence ${_singlePair.confidence} < gate — sizing bumped one notch conservative (tier ${_singlePair.tier}, path ${_singlePair.dataPath})`);
  }
  const bot = new BotEngine({
    symbol,
    botKey:      key,
    coordinator: getCoordinator(userId), // koordinasi margin lintas-bot (#5)
    pairTier:                   _singlePair.tier,
    pairSlMultiplier:           _singlePair.paramOverrides.slMultiplier,
    pairPositionSizeAdjustment: _singlePair.paramOverrides.positionSizeAdjustment,

    // regimeFilterRequired, dll) ke engine agar gating tier benar-benar aktif.
    tierOverrides:              { tier: _singlePair.tier, ..._singlePair.paramOverrides },
    ...engineOverrides,
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

  // → bump tier dinamis. Tanpa metrics → klasifikasi tier dasar (backward-compatible).

  // multi-strategy agar kedua entry point live konsisten.
  const _pairClass = pairClassifier.applyConfidenceGate(
    pairClassifier.classify(symbol, opts.pairMetrics || null)
  );
  if (_pairClass.gated) {
    console.warn(`[PairTier] ${symbol}: confidence ${_pairClass.confidence} < gate — sizing bumped one notch conservative (tier ${_pairClass.tier}, path ${_pairClass.dataPath})`);
  }
  const _pairOverrides = {
    tier:                   _pairClass.tier,
    slMultiplier:           _pairClass.paramOverrides.slMultiplier,
    positionSizeAdjustment: _pairClass.paramOverrides.positionSizeAdjustment,
  };

  // filter, SL komponen-C VOLATILE) di tiap AdaptiveStrategyEngine.
  const _tierOverrides = { tier: _pairClass.tier, ..._pairClass.paramOverrides };

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
      tierOverrides:              _tierOverrides,
      // Cap account-wide posisi terbuka per-tier (per-tier account open-position cap).
      // Diteruskan ke TIAP AdaptiveStrategyEngine → gate _checkAccountOpenCap aktif
      // utk jalur multi-strategi (semua engine berbagi user → cap dihitung dari DB).
      maxAccountOpenPositions: opts.maxAccountOpenPositions ?? 0,
      // tpMode + Grok Confirm dari bot DB — override strat.tpMode (mis. TM default partial
      // tapi user pilih TP Full di UI). Sebelumnya tidak diteruskan → UI "TP Full" tapi
      // engine tetap partial close (+1R/+2R).
      tpMode:                    opts.tpMode ?? "full",
      grokConfirmEnabled:        opts.grokConfirmEnabled ?? false,
      grokConfirmTpAdjust:       opts.grokConfirmTpAdjust ?? true,
      grokConfirmTpBandPct:      opts.grokConfirmTpBandPct,
      grokConfirmTpRejectAction: opts.grokConfirmTpRejectAction,
    },
    // Race-to-confirm: max 1 posisi terbuka per koin (PRD §9.2).
    // Override via env MULTI_STRATEGY_MAX_POSITIONS_PER_COIN hanya untuk debugging.
    maxPositionsPerCoin: parseInt(process.env.MULTI_STRATEGY_MAX_POSITIONS_PER_COIN, 10) || 1,
    // Inject DB → canEnter pakai DB sebagai sumber kebenaran tunggal (cap menghormati
    // SEMUA posisi terbuka termasuk orphan, bukan hanya state engine live).
    db,
  });

  botsMap[key] = coordinator;
  return coordinator;
}

// ── Routes ────────────────────────────────────────────────────────────────

// Health check (public)
const BacktestJobService = require("./services/BacktestJobService");

const healthHandler = (req, res) => {
  const backtest = BacktestJobService.queueStats();
  const { isEmailConfigured } = require("../services/EmailService");
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    allowedExchanges: cfg.allowedExchanges,
    emailConfigured: isEmailConfigured(),
    appUrl: cfg.APP_URL,
    backtest,
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

// AI training & optimizer (xAI Grok — console.x.ai)
app.use("/api/v1/ai", authMiddleware, createAiRouter());

// Legacy routes (protected - deprecated)
app.use("/api/v1/legacy", authMiddleware, createLegacyRouter({ getBot, SYMBOLS_LIST: cfg.symbolsList }));

// Account routes (protected)
app.use("/api/v1/account", authMiddleware, createAccountRouter({ stopAllUserBotsInMemory }));
app.use("/api/v1/subscription", authMiddleware, createSubscriptionRouter());

// Payment & Voucher System (Sprint 5). Webhook is PUBLIC (SHA512-signature auth)
// and MUST be mounted before the authed /payments router so authMiddleware never
// gates it. Admin voucher CRUD self-guards (JWT + admin role) inside its router.
app.use("/api/v1/payments/webhook", createPaymentWebhookRouter());
app.use("/api/v1/payments", authMiddleware, createPaymentsRouter());
app.use("/api/v1/admin/vouchers", createAdminVouchersRouter());

app.use("/api/v1/admin",   createAdminRouter({ stopAllBotsInMemory, getBot })); // routes self-guard (JWT+role); ADMIN_SECRET only for the legacy billing stub

// Sprint 2 / PA-3 — Internal Analytics API (authMiddleware already ran)
app.use("/api/v1/internal/analytics", authMiddleware, createAnalyticsRouter());

// Sprint 3 / MS-3 — MetaSelector API (wss injected lazily after server creation)
// Route uses a lazy wss reference so advisory WS events work correctly.
const _metaSelectorWssRef = { current: null };
app.use("/api/v1/internal/meta-selector", authMiddleware, createMetaSelectorRouter(_metaSelectorWssRef));
app.use("/api/v1/internal/parameters",   authMiddleware, createParametersRouter());

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

// Wire wss into MetaSelector lazy ref (Sprint 3 / MS-3)
_metaSelectorWssRef.current = wss;

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

const RESUME_MAX_RETRIES = parseInt(process.env.RESUME_MAX_RETRIES, 10) || 3;
const _resumeInFlight = new Set(); // `${userId}::${symbol}` — cegah resume paralel ganda

/**
 * Resume satu bot dari record DB. Dipakai startup auto-resume & watchdog cron.
 * Gagal setelah N retry → set DB running=false + alert Telegram admin (anti-zombie).
 *
 * @returns {Promise<{ ok: boolean, action?: string, reason?: string }>}
 */
async function resumeOneBot(bot, { source = "startup" } = {}) {
  const inflightKey = `${bot.userId}::${bot.symbol}`;
  if (_resumeInFlight.has(inflightKey)) {
    return { ok: false, reason: "in-flight" };
  }
  _resumeInFlight.add(inflightKey);

  const prisma = require("../infrastructure/db/prismaClient");
  let lastErr = null;

  try {
    for (let attempt = 1; attempt <= RESUME_MAX_RETRIES; attempt++) {
      try {
        const result = await _resumeOneBotAttempt(bot, prisma);
        return result;
      } catch (e) {
        lastErr = e;
        console.warn(
          `[Resume/${source}] Percobaan ${attempt}/${RESUME_MAX_RETRIES} gagal ${bot.symbol}: ${e.message}`
        );
        if (attempt < RESUME_MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
    }

    // Semua retry habis — tandai stopped di DB agar tidak zombie (running=true tanpa engine)
    try {
      await prisma.bot.update({
        where: { id: bot.id },
        data: { running: false, stoppedAt: new Date() },
      });
    } catch (dbErr) {
      console.error(`[Resume/${source}] Gagal set running=false ${bot.symbol}: ${dbErr.message}`);
    }

    const alertMsg =
      `[${source}] Gagal resume bot ${bot.symbol} (user ${bot.userId}) ` +
      `setelah ${RESUME_MAX_RETRIES} percobaan: ${lastErr?.message ?? "unknown"}. ` +
      `DB running=false (anti-zombie).`;
    console.error(`[Resume/${source}] ${alertMsg}`);
    notifier.notifyError(alertMsg);

    return { ok: false, reason: lastErr?.message ?? "max-retries" };
  } finally {
    _resumeInFlight.delete(inflightKey);
  }
}

/** Satu percobaan resume — throw bila gagal (untuk retry loop di resumeOneBot). */
async function _resumeOneBotAttempt(bot, prisma) {
  const { getExchangeCredentials } = require("../services/userExchange");
  const { getConnectedExchange } = require("../services/ExchangeService");

  const connectedExchange = await getConnectedExchange(bot.userId);
  const creds = await getExchangeCredentials(bot.userId, connectedExchange || "bitget");
  const apiKey     = creds?.apiKey;
  const apiSecret  = creds?.apiSecret;
  const passphrase = creds?.apiPassphrase;

  // Bot LIVE tanpa kredensial tidak bisa dilanjutkan → tandai stopped.
  if (!bot.dryRun && (!apiKey || !apiSecret)) {
    await prisma.bot.update({ where: { id: bot.id }, data: { running: false, stoppedAt: new Date() } });
    console.warn(`[Startup] Bot LIVE ${bot.symbol} tidak punya API key → stopped`);
    return { ok: true, action: "stopped-no-creds" };
  }

  const exchangeType = (connectedExchange || "bitget").toLowerCase();
  if (!bot.dryRun && exchangeType === "okx" && !passphrase) {
    await prisma.bot.update({ where: { id: bot.id }, data: { running: false, stoppedAt: new Date() } });
    console.warn(`[Startup] Bot LIVE ${bot.symbol} OKX tanpa passphrase → stopped`);
    return { ok: true, action: "stopped-no-passphrase" };
  }

  let strategies = null;

  if (MULTI_STRATEGY_ENABLED) {
    try {
      const mode = bot.dryRun ? "dry" : "live";
      const tierStrategies = await getTierStrategies(bot.userId, mode);
      const dbStrategies = Array.isArray(bot.strategyGroup) && bot.strategyGroup.length > 0
        ? bot.strategyGroup
        : [];
      strategies = tierStrategies.length >= dbStrategies.length
        ? tierStrategies
        : dbStrategies;
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

  if (Array.isArray(strategies) && strategies.length > 0) {
    const pc = pairClassifier.classify(bot.symbol);
    if (pc.tier === "VOLATILE") {
      const filtered = strategies.filter((s) => !pc.blockedStrategies.includes(s));
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

  let accountOpenCap = 0;
  try {
    accountOpenCap = getMaxConcurrentPositions(await getUserTier(bot.userId));
    getCoordinator(bot.userId).setMaxAccountOpenPositions(accountOpenCap);
  } catch (e) {
    accountOpenCap = getMaxConcurrentPositions(undefined);
    console.warn(`[Startup] Gagal resolve cap posisi tier ${bot.symbol}: ${e.message} — fallback ${accountOpenCap}`);
  }

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
      maxAccountOpenPositions: accountOpenCap,
      grokConfirmEnabled:        bot.grokConfirmEnabled ?? false,
      grokConfirmTpAdjust:       bot.grokConfirmTpAdjust ?? true,
      grokConfirmTpBandPct:      bot.grokConfirmTpBandPct ?? undefined,
      grokConfirmTpRejectAction: bot.grokConfirmTpRejectAction ?? undefined,
    });
    console.log(`[Startup] Resume bot ${bot.symbol} multi-strategy [${strategies.join(",")}] tpMode:${bot.tpMode ?? "full"} (${bot.dryRun ? "dry-run" : "LIVE"})`);
  } else {
    instance = createBotInstance(bot.userId, bot.symbol, {
      capital:     bot.capital,
      strategyKey: bot.strategyKey,
      dryRun:      bot.dryRun,
      tpMode:      bot.tpMode ?? "full",
      botId:       bot.id,
      userId:      bot.userId,
      exchangeType,
      apiKey, apiSecret, passphrase,
      maxAccountOpenPositions: accountOpenCap,
      grokConfirmEnabled:        bot.grokConfirmEnabled ?? false,
      grokConfirmTpAdjust:       bot.grokConfirmTpAdjust ?? true,
      grokConfirmTpBandPct:      bot.grokConfirmTpBandPct ?? undefined,
      grokConfirmTpRejectAction: bot.grokConfirmTpRejectAction ?? undefined,
    });
    console.log(`[Startup] Resume bot ${bot.symbol} single-strategy [${bot.strategyKey}] (${bot.dryRun ? "dry-run" : "LIVE"})`);
  }

  const fresh = await prisma.bot.findUnique({ where: { id: bot.id }, select: { running: true } });
  if (!fresh?.running) {
    console.log(`[Startup] Skip resume ${bot.symbol} — sudah di-stop selagi warm-up`);
    return { ok: true, action: "skipped-stopped-during-warmup" };
  }

  const liveState = instance.getState();
  if (!liveState.running && !liveState.starting) await instance.start();
  return { ok: true, action: "resumed" };
}

async function resumeRunningBots() {
  try {
    const prisma = require("../infrastructure/db/prismaClient");

    const bots = await prisma.bot.findMany({
      where: { running: true },
    });

    console.log(`[Startup] 🔁 Auto-resume: ${bots.length} bot dengan running=true ditemukan`);

    let resumed = 0;
    let stopped = 0;
    let failed = 0;

    const seenResumeKeys = new Set();
    const resumeQueue = bots.filter((b) => {
      const k = `${b.userId}::${b.symbol}`;
      if (seenResumeKeys.has(k)) {
        console.warn(`[Startup] Lewati duplikat resume ${b.symbol} (baris bot ganda untuk user ${b.userId})`);
        return false;
      }
      seenResumeKeys.add(k);
      return true;
    });

    for (const bot of resumeQueue) {
      const result = await resumeOneBot(bot, { source: "startup" });
      if (result.ok) {
        if (result.action === "resumed" || result.action === "skipped-stopped-during-warmup") resumed++;
        else if (String(result.action || "").startsWith("stopped")) stopped++;
      } else {
        failed++;
      }
      if (resumeQueue.indexOf(bot) < resumeQueue.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    console.log(`[Startup] ✅ Auto-resume selesai: ${resumed} dilanjutkan, ${stopped} dihentikan, ${failed} gagal`);
  } catch (err) {
    console.warn("[Startup] resumeRunningBots error (non-fatal):", err.message);
  } finally {
    _resumeInFlight.clear();
  }
}

/**
 * Watchdog cron: deteksi bot zombie (DB running=true tapi tidak ada instance in-memory
 * dan sudah >2 menit sejak startedAt) lalu trigger resume. HealthChecker.js fokus pada
 * metrik sistem (CPU/mem); watchdog ini khusus konsistensi bot↔DB.
 */
async function runBotWatchdog() {
  try {
    const hc = getHealthChecker();
    if (hc && !hc.isHealthy()) {
      console.warn("[Watchdog] Skip tick — HealthChecker melaporkan sistem unhealthy");
      return;
    }

    const prisma = require("../infrastructure/db/prismaClient");
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);

    const candidates = await prisma.bot.findMany({
      where: {
        running: true,
        startedAt: { lt: twoMinAgo },
      },
    });

    if (candidates.length === 0) return;

    for (const bot of candidates) {
      const instance = getBot(bot.userId, bot.symbol);
      if (instance) continue;

      console.warn(
        `[Watchdog] Zombie bot: ${bot.symbol} (user ${bot.userId}) — DB running=true, tidak ada engine, startedAt >2m → resume`
      );
      await resumeOneBot(bot, { source: "watchdog" });
    }
  } catch (err) {
    console.warn("[Watchdog] Error (non-fatal):", err.message);
  }
}

function startBotWatchdog() {
  const intervalMs = parseInt(process.env.BOT_WATCHDOG_INTERVAL_MS, 10) || 60_000;
  setInterval(() => runBotWatchdog(), intervalMs).unref?.();
  // Tunda tick pertama agar startup auto-resume selesai dulu
  setTimeout(() => runBotWatchdog(), Math.max(intervalMs, 90_000)).unref?.();
  console.log(`[Watchdog] Bot zombie checker aktif (interval ${intervalMs / 1000}s)`);
}

/** Lazy singleton HealthChecker (opsional) — skip watchdog bila sistem unhealthy. */
let _healthCheckerInstance = null;
function getHealthChecker() {
  if (_healthCheckerInstance !== null) return _healthCheckerInstance;
  try {
    const HealthChecker = require("../infrastructure/monitoring/HealthChecker");
    _healthCheckerInstance = new HealthChecker({ checkInterval: 60_000 });
  } catch {
    _healthCheckerInstance = false;
  }
  return _healthCheckerInstance || null;
}

/**
 * P1-10: Log restart count PM2 saat boot; alert Telegram bila mendekati max_restarts.
 * PM2 set restart_time via process env (unstable restarts sejak min_uptime terakhir).
 */
function checkPm2RestartHealth() {
  if (!process.env.pm_id) return;

  const appName = process.env.name || "quantara";
  const restarts = parseInt(process.env.restart_time, 10) || 0;
  const maxRestarts = parseInt(process.env.PM2_MAX_RESTARTS, 10) || 10;

  console.log(`[PM2] Process "${appName}" restart_time=${restarts} (max_restarts=${maxRestarts})`);

  if (restarts >= maxRestarts) {
    const msg =
      `PM2 max_restarts (${maxRestarts}) TERLAMPAUI untuk "${appName}" — ` +
      `proses tidak akan auto-restart lagi. Butuh intervensi manual.`;
    console.error(`[PM2] ${msg}`);
    notifier.notifyError(msg);
  } else if (restarts >= Math.max(1, maxRestarts - 1)) {
    const msg =
      `PM2 restart loop: "${appName}" restart ${restarts}/${maxRestarts} — ` +
      `mendekati batas max_restarts.`;
    console.warn(`[PM2] ${msg}`);
    notifier.notifyError(msg);
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

    pairClassifier.refreshDynamic().catch(() => {});
    setInterval(() => pairClassifier.refreshDynamic().catch(() => {}), 2 * 60 * 60 * 1000);

    // snapshot terakhir (sinyal ambang 0.48/0.65/0.78 mulai usang → jalankan
    // scripts/recalibrate-pair-tiers.js). Observasi saja, tidak mengubah ambang.
    const { pairTierDriftMonitor } = require("../infrastructure/classification/PairTierDriftMonitor");
    pairTierDriftMonitor.start();
    checkPm2RestartHealth();
    startBotWatchdog();
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
