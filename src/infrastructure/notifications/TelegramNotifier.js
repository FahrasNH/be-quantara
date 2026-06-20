// ─────────────────────────────────────────────
// notifier.js — Quantara Notification Service
//
// Mendukung: Telegram Bot (gratis, instan)
//
// Setup Telegram:
// 1. Chat @BotFather di Telegram → /newbot → ikuti instruksi
// 2. Simpan TOKEN yang diberikan BotFather
// 3. Kirim pesan ke bot kamu → buka browser:
//    https://api.telegram.org/bot{TOKEN}/getUpdates
//    Cari "chat":{"id":...} → itu CHAT_ID kamu
// 4. Isi di .env:
//    TELEGRAM_BOT_TOKEN=123456789:AABBccdd...
//    TELEGRAM_CHAT_ID=123456789
// ─────────────────────────────────────────────

const cfg = require("../../config/env");

const TG_TOKEN = cfg.TELEGRAM_BOT_TOKEN;
// TG_CHAT_ID dari env sekarang hanya sebagai fallback legacy.
// Per-user chat ID diambil dari DB dan diteruskan saat memanggil notify*.
const TG_CHAT_ID_FALLBACK = cfg.TELEGRAM_CHAT_ID;
const hasToken = !!(TG_TOKEN);
const ENABLED = hasToken && cfg.NODE_ENV !== "development";

if (!hasToken) {
  console.log("[Notifier] Notifikasi Telegram NONAKTIF — set TELEGRAM_BOT_TOKEN di .env");
} else if (cfg.NODE_ENV === "development") {
  console.log("[Notifier] Notifikasi Telegram NONAKTIF — dimatikan di development");
} else {
  console.log(`[Notifier] Notifikasi Telegram AKTIF (bot @quantara_trading_bot). Per-user chat ID dari DB.`);
}

// ── Core send ke Telegram ──────────────────────────────────────────────────
// chatId: gunakan user's chat ID jika ada, fallback ke env TELEGRAM_CHAT_ID (legacy)

async function send(text, parseMode = "HTML", chatId = null) {
  const targetChatId = chatId || TG_CHAT_ID_FALLBACK;
  if (!ENABLED || !targetChatId) return;
  try {
    const url  = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    targetChatId,
      text,
      parse_mode: parseMode,
    });
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal:  AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.warn(`[Notifier] Telegram error: ${res.status} — ${errBody}`);
    }
  } catch (err) {
    // Jangan sampai error notifikasi menghentikan bot
    console.warn("[Notifier] Gagal kirim Telegram:", err.message);
  }
}

// ── Formatter helpers ──────────────────────────────────────────────────────

function fmtPrice(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${Number(n).toFixed(2)}%`;
}

function fmtPnl(n) {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(Number(n)).toFixed(2)}`;
}

function nowStr() {
  return new Date().toLocaleString("id-ID", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone:  "Asia/Jakarta",
  });
}

// ── Notifikasi Open Posisi ─────────────────────────────────────────────────

/**
 * @param {{ symbol, side, entryPrice, size, sl, tp, leverage, dryRun, chatId }} trade
 */
function notifyOpen(trade) {
  const {
    symbol, side, entryPrice, size,
    sl, tp, leverage = 1, dryRun = false, chatId = null,
  } = trade;

  const coin      = symbol.replace("USDT", "");
  const modeTag   = dryRun ? " <b>[DRY RUN]</b>" : " <b>[LIVE]</b>";
  const isLong    = side.toLowerCase().includes("long");
  const dirIcon   = isLong ? "🟢" : "🔴";
  const dirLabel  = isLong ? "📈 LONG" : "📉 SHORT";

  const lines = [
    `${dirIcon} <b>OPEN POSISI${modeTag}</b>`,
    `<b>${coin}/USDT</b> — ${dirLabel}`,
    ``,
    `Entry      : <code>$${fmtPrice(entryPrice)}</code>`,
    size  != null ? `Size       : <code>${Number(size).toFixed(4)} ${coin}</code>` : null,
    sl    != null ? `🛑 Stop Loss  : <code>$${fmtPrice(sl)}</code>` : null,
    tp    != null ? `🎯 Take Profit: <code>$${fmtPrice(tp)}</code>` : null,
    leverage > 1  ? `Leverage   : <code>${leverage}x</code>` : null,
    ``,
    `<i>${nowStr()} WIB</i>`,
    `<i>Quantara Trading Bot</i>`,
  ].filter(Boolean).join("\n");

  return send(lines, "HTML", chatId);
}

// ── Notifikasi Close Posisi ────────────────────────────────────────────────

/**
 * @param {{ symbol, side, entryPrice, exitPrice, pnl, pnlPct, reason, dryRun, chatId }} trade
 */
function notifyClose(trade) {
  const {
    symbol, side, entryPrice, exitPrice,
    pnl, pnlPct, reason, dryRun = false, chatId = null,
  } = trade;

  const coin        = symbol.replace("USDT", "");
  const isWin       = (pnl ?? 0) >= 0;
  const resultIcon  = isWin ? "✅" : "❌";
  const resultLabel = isWin ? "WIN" : "LOSS";
  const modeTag     = dryRun ? " <b>[DRY RUN]</b>" : " <b>[LIVE]</b>";
  const isLong      = side.toLowerCase().includes("long");
  const dirIcon     = isLong ? "🟢" : "🔴";
  const dirLabel    = isLong ? "📈 LONG" : "📉 SHORT";

  const reasonMap = {
    TP:       "🎯 Take Profit",
    SL:       "🛑 Stop Loss",
    Reversal: "🔄 Reversal",
    Exchange: "⚡ Ditutup Exchange",
  };
  const reasonStr = reasonMap[reason] ?? reason ?? "—";

  const lines = [
    `${resultIcon} <b>CLOSE POSISI [${resultLabel}]${modeTag}</b>`,
    `${dirIcon} <b>${coin}/USDT</b> — ${dirLabel}`,
    ``,
    `Entry  : <code>$${fmtPrice(entryPrice)}</code>`,
    `Exit   : <code>$${fmtPrice(exitPrice)}</code>`,
    pnl    != null ? `PnL    : <b>${fmtPnl(pnl)}</b>` : null,
    pnlPct != null ? `ROI    : <code>${fmtPct(pnlPct)}</code>` : null,
    `Alasan : ${reasonStr}`,
    ``,
    `<i>${nowStr()} WIB</i>`,
    `<i>Quantara Trading Bot</i>`,
  ].filter(Boolean).join("\n");

  return send(lines, "HTML", chatId);
}

/**
 * Alert operasional (mis. gagal tutup trade di DB / posisi tanpa record) —
 * dipakai untuk memunculkan kegagalan yang sebelumnya tertelan `catch {}` senyap.
 * @param {string} message
 * @param {string|null} chatId
 */
function notifyError(message, chatId = null) {
  const lines = [
    `<b>QUANTARA ALERT</b>`,
    ``,
    `<code>${String(message).slice(0, 500)}</code>`,
    ``,
    `<i>${nowStr()} WIB</i>`,
  ].join("\n");
  return send(lines, "HTML", chatId);
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = { send, notifyOpen, notifyClose, notifyError, enabled: ENABLED };
