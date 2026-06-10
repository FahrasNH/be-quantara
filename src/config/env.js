// ─── src/config/env.js ───────────────────────────────────────────────────────
// Satu-satunya tempat pembacaan process.env.
// Semua module lain import dari sini — tidak boleh akses process.env langsung.
//
// CATATAN PENTING:
//   Konfigurasi TRADING (dryRun, strategy, capital, leverage, EMA/RSI/ATR, dll)
//   TIDAK lagi dibaca dari .env. Sumbernya sekarang:
//     • Parameter teknikal  → definisi strategi (src/domain/strategies.js)
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
  SYMBOLS_RAW: process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT",
  SYMBOL:      process.env.SYMBOL  || "BTCUSDT",

  // ── Telegram notifications ──────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",

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
  // ALLOWED_TIERS: comma-separated tier keys visible to users (empty = all tiers).
  // ALLOWED_EXCHANGES: comma-separated exchange ids accepted (empty = all).
  // Example .env.production: ALLOWED_TIERS=FOUNDRY  ALLOWED_EXCHANGES=bitget
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

  // Daftar simbol untuk market data (max 4)
  get symbolsList() {
    return this.SYMBOLS_RAW
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 4);
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
      // Gerbang konsistensi DB↔environment: cegah app production menunjuk ke
      // database staging (akar masalah insiden login 2026-06-10). Override
      // sengaja dengan ALLOW_DB_ENV_MISMATCH=1 jika memang satu DB dipakai bersama.
      if (
        process.env.ALLOW_DB_ENV_MISMATCH !== "1" &&
        /staging|dev|test/i.test(this.dbName)
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
