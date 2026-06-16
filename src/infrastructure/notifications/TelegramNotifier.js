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
const TG_CHAT_ID = cfg.TELEGRAM_CHAT_ID;
const hasCreds = !!(TG_TOKEN && TG_CHAT_ID);
const ENABLED = hasCreds && cfg.NODE_ENV !== "development";

if (!hasCreds) {
  console.log("[Notifier] Notifikasi Telegram NONAKTIF — set TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID di .env");
} else if (cfg.NODE_ENV === "development") {
  console.log("[Notifier] Notifikasi Telegram NONAKTIF — dimatikan di development");
} else {
  console.log(`[Notifier] ✅ Notifikasi Telegram AKTIF → Chat ID: ${TG_CHAT_ID}`);
}

// ── Core send ke Telegram ──────────────────────────────────────────────────

async function send(text, parseMode = "HTML") {
  if (!ENABLED) return;
  try {
    const url  = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const body = JSON.stringify({
      chat_id:    TG_CHAT_ID,
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
 * @param {{ symbol, side, entryPrice, size, sl, tp, leverage, dryRun }} trade
 */
function notifyOpen(trade) {
  const {
    symbol, side, entryPrice, size,
    sl, tp, leverage = 1, dryRun = false,
  } = trade;

  const coin      = symbol.replace("USDT", "");
  const sideEmoji = side === "LONG" ? "🟢" : "🔴";
  const modeTag   = dryRun ? " <b>[DRY RUN]</b>" : " <b>[LIVE]</b>";

  const lines = [
    `${sideEmoji} <b>OPEN POSISI${modeTag}</b>`,
    `<b>${coin}/USDT</b> — ${side}`,
    ``,
    `📍 Entry     : <code>$${fmtPrice(entryPrice)}</code>`,
    size  != null ? `📦 Size      : <code>${Number(size).toFixed(4)} ${coin}</code>` : null,
    sl    != null ? `🛡️ Stop Loss  : <code>$${fmtPrice(sl)}</code>` : null,
    tp    != null ? `🎯 Take Profit: <code>$${fmtPrice(tp)}</code>` : null,
    leverage > 1  ? `⚡ Leverage   : <code>${leverage}x</code>` : null,
    ``,
    `🕐 <i>${nowStr()} WIB</i>`,
    `📡 <i>Quantara Trading Bot</i>`,
  ].filter(Boolean).join("\n");

  return send(lines);
}

// ── Notifikasi Close Posisi ────────────────────────────────────────────────

/**
 * @param {{ symbol, side, entryPrice, exitPrice, pnl, pnlPct, reason, dryRun }} trade
 */
function notifyClose(trade) {
  const {
    symbol, side, entryPrice, exitPrice,
    pnl, pnlPct, reason, dryRun = false,
  } = trade;

  const coin      = symbol.replace("USDT", "");
  const isWin     = (pnl ?? 0) >= 0;
  const resultIco = isWin ? "✅" : "❌";
  const modeTag   = dryRun ? " <b>[DRY RUN]</b>" : " <b>[LIVE]</b>";

  const reasonMap = {
    TP:       "Take Profit 🎯",
    SL:       "Stop Loss 🛡️",
    Reversal: "Reversal ↩️",
    Exchange: "Ditutup Exchange",
  };
  const reasonStr = reasonMap[reason] ?? reason ?? "—";

  const lines = [
    `${resultIco} <b>CLOSE POSISI${modeTag}</b>`,
    `<b>${coin}/USDT</b> — ${side}`,
    ``,
    `📍 Entry  : <code>$${fmtPrice(entryPrice)}</code>`,
    `📤 Exit   : <code>$${fmtPrice(exitPrice)}</code>`,
    pnl    != null ? `💰 PnL    : <b>${fmtPnl(pnl)}</b>` : null,
    pnlPct != null ? `📈 ROI    : <code>${fmtPct(pnlPct)}</code>` : null,
    `📋 Alasan : ${reasonStr}`,
    ``,
    `🕐 <i>${nowStr()} WIB</i>`,
    `📡 <i>Quantara Trading Bot</i>`,
  ].filter(Boolean).join("\n");

  return send(lines);
}

/**
 * Alert operasional (mis. gagal tutup trade di DB / posisi tanpa record) —
 * dipakai untuk memunculkan kegagalan yang sebelumnya tertelan `catch {}` senyap.
 * @param {string} message
 */
function notifyError(message) {
  const lines = [
    `🚨 <b>QUANTARA ALERT</b>`,
    ``,
    `<code>${String(message).slice(0, 500)}</code>`,
    ``,
    `🕐 <i>${nowStr()} WIB</i>`,
  ].join("\n");
  return send(lines);
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = { send, notifyOpen, notifyClose, notifyError, enabled: ENABLED };
