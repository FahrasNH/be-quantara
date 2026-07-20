// ─── src/config/env.js ───────────────────────────────────────────────────────
// Satu-satunya tempat pembacaan process.env.
// Semua module lain import dari sini — tidak boleh akses process.env langsung.
//
// CATATAN PENTING:
//   Konfigurasi TRADING (dryRun, strategy, capital, leverage, EMA/RSI/ATR, dll)
//   TIDAK lagi dibaca dari .env. Sumbernya sekarang:
//     • Parameter teknikal  → definisi strategi (src/config/strategyDefaults.js)
//     • Pilihan per-bot      → database (tabel Bot) via Settings/UI
//   .env hanya menyimpan konfigurasi level-server & kredensial infrastruktur.
// ─────────────────────────────────────────────────────────────────────────────

const cfg = {
  // ── Server ────────────────────────────────────────────────────────────────
  PORT:     parseInt(process.env.PORT) || 3000,
  HOST:     process.env.HOST           || "0.0.0.0",
  NODE_ENV: process.env.NODE_ENV       || "development",

  // ── Exchange credentials (FALLBACK saja) ───────────────────────────────────
  // Sumber utama kredensial adalah API key per-user di database (Settings).
  // Nilai di bawah hanya dipakai jika user belum mengkonfigurasi key di DB.
  BITGET_API_KEY:    process.env.BITGET_API_KEY    || "",
  BITGET_SECRET_KEY: process.env.BITGET_SECRET_KEY || "",
  BITGET_PASSPHRASE: process.env.BITGET_PASSPHRASE || "",

  // ── Market data (simbol untuk ticker & backtest publik) ─────────────────────
  SYMBOLS_RAW: process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT,ETHUSDT,BNBUSDT,XRPUSDT,SOLUSDT",
  SYMBOL:      process.env.SYMBOL  || "BTCUSDT",

  // ── Telegram notifications ──────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",

  // ── Email (password reset) ──────────────────────────────────────────────────
  // Gmail: EMAIL_HOST=smtp.gmail.com EMAIL_PORT=587 EMAIL_USER=you@gmail.com
  //        EMAIL_PASS=<App Password from Google Account → Security → App passwords>
  EMAIL_HOST: process.env.EMAIL_HOST || "",
  EMAIL_PORT: parseInt(process.env.EMAIL_PORT) || 587,
  EMAIL_USER: process.env.EMAIL_USER || "",
  EMAIL_PASS: process.env.EMAIL_PASS || "",
  // Public URL of the frontend — used to construct reset links.
  // e.g. https://quantara.example.com or http://187.77.135.156
  APP_URL:    process.env.APP_URL    || "http://localhost:5173",

  // ── xAI Grok (console.x.ai) — AI training & optimizer ─────────────────────
  XAI_ENABLED:            process.env.XAI_ENABLED === "true",
  XAI_API_KEY:            process.env.XAI_API_KEY || "",
  XAI_MANAGEMENT_API_KEY: process.env.XAI_MANAGEMENT_API_KEY || "",
  XAI_COLLECTION_ID:      process.env.XAI_COLLECTION_ID || "",
  XAI_MODEL:              process.env.XAI_MODEL || "grok-4.3",
  XAI_TIMEOUT_MS:         parseInt(process.env.XAI_TIMEOUT_MS, 10) || 60_000,
  // Izinkan AI optimizer tanpa tier VAULT (dev/staging)
  XAI_OPTIMIZER_OPEN:     process.env.XAI_OPTIMIZER_OPEN === "true",

  // ── Grok AI Live Trading ────────────────────────────────────────────────────
  GROK_TRADING_ENABLED:            process.env.GROK_TRADING_ENABLED === "true",
  GROK_TRADING_MIN_CONFIDENCE_ENTRY: parseInt(process.env.GROK_TRADING_MIN_CONFIDENCE_ENTRY, 10) || 8,
  GROK_TRADING_MIN_CONFIDENCE_TP_SL: parseInt(process.env.GROK_TRADING_MIN_CONFIDENCE_TP_SL, 10) || 7,
  GROK_TRADING_MAX_TOKENS:         parseInt(process.env.GROK_TRADING_MAX_TOKENS, 10) || 2000,
  GROK_TRADING_TEMPERATURE:        parseFloat(process.env.GROK_TRADING_TEMPERATURE) || 0.3,
  GROK_TRADING_CYCLE_MS:           parseInt(process.env.GROK_TRADING_CYCLE_MS, 10) || 600_000,
  GROK_TRADING_DRY_RUN:            process.env.GROK_TRADING_DRY_RUN !== "false",
  GROK_TRADING_LOG_INTERACTIONS:   process.env.GROK_TRADING_LOG_INTERACTIONS !== "false",
  // Izinkan Grok live trading tanpa tier VAULT (dev/staging)
  GROK_TRADING_OPEN:               process.env.GROK_TRADING_OPEN === "true",

  // ── Grok Confirm Gate + TP Adjust (Mode B — AF/TM/MR/BR) ─────────────────
  GROK_CONFIRM_ENABLED:              process.env.GROK_CONFIRM_ENABLED === "true",
  GROK_CONFIRM_MIN_CONFIDENCE_ENTRY: parseInt(process.env.GROK_CONFIRM_MIN_CONFIDENCE_ENTRY, 10) || 8,
  GROK_CONFIRM_MIN_TP_CONFIDENCE:    parseInt(process.env.GROK_CONFIRM_MIN_TP_CONFIDENCE, 10) || 7,
  GROK_CONFIRM_MIN_TP_MODE_CONFIDENCE: parseInt(process.env.GROK_CONFIRM_MIN_TP_MODE_CONFIDENCE, 10) || 6,
  GROK_CONFIRM_TP_ADJUST_BAND_PCT:   parseFloat(process.env.GROK_CONFIRM_TP_ADJUST_BAND_PCT) || 15,
  GROK_CONFIRM_TP_MAX_ATR_MULT:      parseFloat(process.env.GROK_CONFIRM_TP_MAX_ATR_MULT) || 0.5,
  GROK_CONFIRM_TP_REJECT_ACTION:     process.env.GROK_CONFIRM_TP_REJECT_ACTION || "skip",
  GROK_CONFIRM_FAIL_MODE:            process.env.GROK_CONFIRM_FAIL_MODE || "closed",
  GROK_CONFIRM_PROMPT_LITE:          process.env.GROK_CONFIRM_PROMPT_LITE !== "false",
  GROK_CONFIRM_OPEN:                 process.env.GROK_CONFIRM_OPEN === "true",
  /** Parallel xAI calls per chunk during backtest Grok Confirm (default 8). */
  GROK_CONFIRM_CONCURRENCY:          Math.max(1, parseInt(process.env.GROK_CONFIRM_CONCURRENCY, 10) || 8),

  // ── Midtrans payment gateway (Sprint 5 / PAY-01) ────────────────────────────
  // Get Server Key & Client Key from the Midtrans dashboard
  //   (Settings → Access Keys). Use the SANDBOX keys on staging.
  //   MIDTRANS_IS_PRODUCTION=false → sandbox  |  true → production
  // The Server Key is also the secret used to verify webhook SHA512 signatures —
  // it must NEVER be exposed to the frontend. Only the Client Key is public.
  MIDTRANS_SERVER_KEY:    process.env.MIDTRANS_SERVER_KEY    || "",
  MIDTRANS_CLIENT_KEY:    process.env.MIDTRANS_CLIENT_KEY    || "",
  MIDTRANS_IS_PRODUCTION: process.env.MIDTRANS_IS_PRODUCTION === "true",
  // Public base URL of THIS backend — used to build the webhook/redirect URLs
  // registered in the Midtrans dashboard. e.g. https://staging.quantara.software
  API_PUBLIC_URL:         process.env.API_PUBLIC_URL || process.env.APP_URL || "http://localhost:3000",

  // ── Secrets (dipakai AuthService & crypto) ──────────────────────────────────
  JWT_SECRET:         process.env.JWT_SECRET         || "",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "",
  ENCRYPTION_KEY:     process.env.ENCRYPTION_KEY     || "",
  DATABASE_URL:       process.env.DATABASE_URL       || "",

  // ── CORS ────────────────────────────────────────────────────────────────────
  // Domain frontend yang diizinkan. Set lewat .env (comma-separated) di production
  // agar ganti domain tidak perlu edit kode. Localhost selalu diizinkan terpisah.
  CORS_ORIGINS_RAW: process.env.CORS_ORIGINS || "http://187.77.135.156",

  // ── Production Feature Flags ─────────────────────────────────────────────────
  // ALLOWED_TIERS: comma-separated tier keys visible to users.
  //   empty / unset = semua tier (FOUNDRY, MINT, VAULT) diizinkan  ← default production
  //   "FOUNDRY"     = hanya tier dasar (mode staging/closed-beta)
  // ALLOWED_EXCHANGES: comma-separated exchange ids accepted.
  //   empty / unset = semua exchange  |  "bitget,okx,binance" = production
  ALLOWED_TIERS_RAW:     process.env.ALLOWED_TIERS     || "",
  ALLOWED_EXCHANGES_RAW: process.env.ALLOWED_EXCHANGES || "",

  // ── Helpers ─────────────────────────────────────────────────────────────────

  // Tiers yang ditampilkan ke user. null = semua tier diizinkan.
  get allowedTiers() {
    if (!this.ALLOWED_TIERS_RAW) return null;
    return this.ALLOWED_TIERS_RAW.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  },

  // Exchange yang diterima. null = semua exchange diizinkan.
  get allowedExchanges() {
    if (!this.ALLOWED_EXCHANGES_RAW) return null;
    return this.ALLOWED_EXCHANGES_RAW.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  },

  // Daftar origin CORS yang diizinkan (selain localhost)
  get corsOrigins() {
    return this.CORS_ORIGINS_RAW
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  },

  // Daftar simbol untuk market data (platform allowlist only)
  get symbolsList() {
    const { filterAllowedSymbolStrings } = require("../shared/constants/allowedSymbols");
    const parsed = this.SYMBOLS_RAW
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    const filtered = filterAllowedSymbolStrings(parsed);
    return filtered.length > 0 ? filtered : filterAllowedSymbolStrings([]);
  },

  // Apakah ada API key fallback yang valid (bukan placeholder)
  get hasApiKey() {
    const k = this.BITGET_API_KEY;
    return !!(k && k !== "your_api_key_here" && k !== "your_bitget_api_key");
  },

  get isProduction() {
    return this.NODE_ENV === "production";
  },

  // Nama database dari DATABASE_URL (postgresql://user:pass@host:port/DBNAME?...)
  get dbName() {
    const m = this.DATABASE_URL.match(/\/([^/?]+)(\?|$)/);
    return m ? m[1] : "";
  },

  /** True when DATABASE_URL clearly points at a non-production DB name. */
  isNonProductionDbName(name) {
    if (!name) return false;
    // Word-boundary style: match _staging/_dev/_test as segments, not "development".
    return /(?:^|_)(?:staging|dev|test)(?:$|_)/i.test(name);
  },

  /**
   * Validasi env wajib sebelum server start. Di production, fail-fast jika ada
   * secret yang kosong atau masih memakai nilai placeholder default.
   * Panggil sekali di entry point (app.js) sebelum db.init().
   */
  validate() {
    const errors = [];
    const PLACEHOLDERS = [
      "your-secret-key-change-in-production",
      "your-refresh-secret-key-change-in-production",
    ];
    // SEC-004: kunci enkripsi contoh yang pernah ter-commit di .env.example.
    // WAJIB ditolak di production — jika operator copy contoh ke prod, semua
    // API key exchange tersimpan bisa didekripsi siapa pun yang punya repo.
    const PUBLISHED_ENCRYPTION_KEY =
      "c13aec676c24983a3addcec886a7a2d5df09c85f2adbcb0bd1de0adaa1340754";

    if (!this.DATABASE_URL) errors.push("DATABASE_URL belum diset.");
    if (!this.JWT_SECRET) errors.push("JWT_SECRET belum diset.");
    if (!this.JWT_REFRESH_SECRET) errors.push("JWT_REFRESH_SECRET belum diset.");
    if (!this.ENCRYPTION_KEY) errors.push("ENCRYPTION_KEY belum diset.");
    else if (this.ENCRYPTION_KEY.length !== 64) {
      errors.push("ENCRYPTION_KEY harus 64 hex char (32 byte). Generate: openssl rand -hex 32");
    }

    if (this.isProduction) {
      if (PLACEHOLDERS.includes(this.JWT_SECRET)) {
        errors.push("JWT_SECRET masih memakai nilai placeholder — WAJIB diganti di production.");
      }
      if (PLACEHOLDERS.includes(this.JWT_REFRESH_SECRET)) {
        errors.push("JWT_REFRESH_SECRET masih memakai nilai placeholder — WAJIB diganti di production.");
      }
      if (this.JWT_SECRET && this.JWT_SECRET === this.JWT_REFRESH_SECRET) {
        errors.push("JWT_SECRET dan JWT_REFRESH_SECRET tidak boleh sama.");
      }
      if (this.ENCRYPTION_KEY === PUBLISHED_ENCRYPTION_KEY) {
        errors.push(
          "ENCRYPTION_KEY masih memakai nilai contoh dari .env.example yang pernah ter-commit " +
          "— WAJIB generate baru (openssl rand -hex 32). Jika key contoh ini pernah dipakai di " +
          "production, rotate key lalu re-encrypt semua API key exchange tersimpan."
        );
      }
      // SEC-002 GAP2: ADMIN_SECRET memproteksi endpoint /api/v1/admin (assign tier
      // tanpa billing). Tanpa validasi, nilai default lemah ("changeme") berarti
      // siapa pun bisa self-upgrade tier di production.
      const adminSecret = process.env.ADMIN_SECRET;
      if (!adminSecret) {
        errors.push("ADMIN_SECRET belum diset — endpoint /api/v1/admin tidak boleh aktif tanpa secret di production.");
      } else if (adminSecret.length < 16 || /^(changeme|admin|secret|password)$/i.test(adminSecret)) {
        errors.push("ADMIN_SECRET terlalu lemah (min 16 char, bukan nilai default). Generate: openssl rand -hex 24");
      }
      // Gerbang konsistensi DB↔environment: cegah app production menunjuk ke
      // database staging (akar masalah insiden login 2026-06-10). Override
      // sengaja dengan ALLOW_DB_ENV_MISMATCH=1 jika memang satu DB dipakai bersama.
      if (
        process.env.ALLOW_DB_ENV_MISMATCH !== "1" &&
        this.isNonProductionDbName(this.dbName)
      ) {
        errors.push(
          `NODE_ENV=production tapi DATABASE_URL menunjuk database "${this.dbName}" ` +
          `(terindikasi non-produksi). Perbaiki DATABASE_URL, atau set ` +
          `ALLOW_DB_ENV_MISMATCH=1 bila ini memang disengaja.`
        );
      }
    }

    if (errors.length) {
      throw new Error(
        "Konfigurasi environment tidak valid:\n  - " + errors.join("\n  - ")
      );
    }
  },
};

module.exports = cfg;
