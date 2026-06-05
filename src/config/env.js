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

  // ── Helpers ─────────────────────────────────────────────────────────────────

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
};

module.exports = cfg;
