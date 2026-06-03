// ─── src/config/env.js ───────────────────────────────────────────────────────
// Satu-satunya tempat pembacaan process.env.
// Semua module lain import dari sini — tidak boleh akses process.env langsung.
// ─────────────────────────────────────────────────────────────────────────────

const cfg = {
  // Server
  PORT:    parseInt(process.env.PORT)  || 3000,
  HOST:    process.env.HOST            || "0.0.0.0",

  // Exchange — hanya Bitget
  BITGET_API_KEY:    process.env.BITGET_API_KEY    || "",
  BITGET_SECRET_KEY: process.env.BITGET_SECRET_KEY || "",
  BITGET_PASSPHRASE: process.env.BITGET_PASSPHRASE || "",

  // Trading
  SYMBOLS_RAW:      process.env.SYMBOLS || process.env.SYMBOL || "BTCUSDT",
  SYMBOL:           process.env.SYMBOL  || "BTCUSDT",
  MARGIN_COIN:      process.env.MARGIN_COIN || "USDT",
  CAPITAL:          parseFloat(process.env.CAPITAL)         || 500,
  STRATEGY:         process.env.STRATEGY                    || "B",
  DRY_RUN:          process.env.DRY_RUN !== "false",
  LEVERAGE:         parseInt(process.env.LEVERAGE)          || 5,
  RISK_PER_TRADE:   parseFloat(process.env.RISK_PER_TRADE)  || 0.01,
  MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS) || 1,
  USE_BOTH_SIDES:   process.env.USE_BOTH_SIDES === "true",
  CANDLE_INTERVAL:  process.env.CANDLE_INTERVAL             || "15m",
  CHECK_INTERVAL_MS:parseInt(process.env.CHECK_INTERVAL_MS) || 60000,

  // Strategy overrides (opsional via .env)
  EMA_FAST:       parseInt(process.env.EMA_FAST)        || null,
  EMA_SLOW:       parseInt(process.env.EMA_SLOW)        || null,
  RSI_PERIOD:     parseInt(process.env.RSI_PERIOD)      || null,
  RSI_OVERBOUGHT: parseInt(process.env.RSI_OVERBOUGHT)  || null,
  RSI_OVERSOLD:   parseInt(process.env.RSI_OVERSOLD)    || null,
  ATR_PERIOD:     parseInt(process.env.ATR_PERIOD)      || null,
  ATR_MULTIPLIER: parseFloat(process.env.ATR_MULTIPLIER)|| null,
  RISK_REWARD:    parseFloat(process.env.RISK_REWARD)   || null,

  // Telegram notifications
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || "",

  // Helper: modal per symbol (CAPITAL_BTCUSDT, CAPITAL_ETHUSDT, ...)
  capitalFor(symbol) {
    return parseFloat(process.env[`CAPITAL_${symbol}`]) || this.CAPITAL;
  },

  // Helper: symbols list (max 3)
  get symbolsList() {
    return this.SYMBOLS_RAW
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 3);
  },

  // Helper: apakah API Key valid (bukan placeholder)
  get hasApiKey() {
    const k = this.BITGET_API_KEY;
    return !!(k && k !== "your_api_key_here" && k !== "your_bitget_api_key");
  },
};

module.exports = cfg;
