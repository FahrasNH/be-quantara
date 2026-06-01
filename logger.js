// ─────────────────────────────────────────────
// logger.js — Colored console logger + Telegram
// ─────────────────────────────────────────────

const axios = require("axios");

const COLORS = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  red:    "\x1b[31m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  white:  "\x1b[37m",
  gray:   "\x1b[90m",
};

const LEVEL_CONFIG = {
  debug: { color: COLORS.gray,   prefix: "DEBUG", show: ["debug"] },
  info:  { color: COLORS.cyan,   prefix: " INFO" },
  warn:  { color: COLORS.yellow, prefix: " WARN" },
  error: { color: COLORS.red,    prefix: "ERROR" },
  trade: { color: COLORS.green,  prefix: "TRADE" },
  price: { color: COLORS.blue,   prefix: "PRICE" },
};

class Logger {
  constructor(logLevel = "info", telegramToken = "", telegramChatId = "") {
    this.logLevel = logLevel;
    this.telegramToken = telegramToken;
    this.telegramChatId = telegramChatId;
    this.levels = ["debug", "info", "warn", "error", "trade", "price"];
    this.minLevel = this.levels.indexOf(logLevel);
  }

  _timestamp() {
    return new Date().toLocaleString("id-ID", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }

  _log(level, ...args) {
    const idx = this.levels.indexOf(level);
    if (idx < this.minLevel && level !== "trade" && level !== "error") return;

    const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.info;
    const time = `${COLORS.gray}[${this._timestamp()}]${COLORS.reset}`;
    const lvl  = `${cfg.color}${COLORS.bold}[${cfg.prefix}]${COLORS.reset}`;
    const msg  = args.map(a => typeof a === "object" ? JSON.stringify(a, null, 2) : String(a)).join(" ");

    console.log(`${time} ${lvl} ${cfg.color}${msg}${COLORS.reset}`);
  }

  debug(...args) { this._log("debug", ...args); }
  info(...args)  { this._log("info",  ...args); }
  warn(...args)  { this._log("warn",  ...args); }
  error(...args) { this._log("error", ...args); }
  price(...args) { this._log("price", ...args); }

  // Trade log — selalu tampil + kirim ke Telegram
  trade(...args) {
    this._log("trade", ...args);
    const msg = args.join(" ");
    this._sendTelegram(`🤖 *Quantara*\n\n${msg}`);
  }

  // Separator garis
  separator(label = "") {
    const line = "─".repeat(50);
    if (label) {
      console.log(`\n${COLORS.gray}${line}${COLORS.reset}`);
      console.log(`${COLORS.bold}${COLORS.yellow}  ${label}${COLORS.reset}`);
      console.log(`${COLORS.gray}${line}${COLORS.reset}\n`);
    } else {
      console.log(`${COLORS.gray}${line}${COLORS.reset}`);
    }
  }

  // Kirim notifikasi Telegram
  async _sendTelegram(message) {
    if (!this.telegramToken || !this.telegramChatId) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.telegramToken}/sendMessage`,
        { chat_id: this.telegramChatId, text: message, parse_mode: "Markdown" },
        { timeout: 5000 }
      );
    } catch {
      // Telegram failure tidak stop bot
    }
  }

  // Notif khusus trade
  async notifyTrade(action, symbol, side, price, size, pnl = null) {
    const emoji = action === "OPEN"
      ? (side === "LONG" ? "🟢" : "🔴")
      : (pnl > 0 ? "✅" : "❌");

    const pnlStr = pnl !== null
      ? `\nPnL: ${pnl > 0 ? "+" : ""}$${pnl.toFixed(2)}`
      : "";

    const msg = [
      `${emoji} *${action} ${side}*`,
      `Symbol: ${symbol}`,
      `Harga: $${price.toLocaleString()}`,
      `Size: ${size}`,
      pnlStr,
      `\nWaktu: ${this._timestamp()}`,
    ].filter(Boolean).join("\n");

    this.trade(msg.replace(/\*/g, ""));
    await this._sendTelegram(msg);
  }
}

// Singleton
const logger = new Logger(
  process.env.LOG_LEVEL || "info",
  process.env.TELEGRAM_BOT_TOKEN || "",
  process.env.TELEGRAM_CHAT_ID || ""
);

module.exports = logger;
