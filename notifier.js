// ─────────────────────────────────────────────
// notifier.js — WhatsApp Notification via CallMeBot
//
// Setup:
// 1. Tambah +34 644 59 77 85 ke kontak WhatsApp kamu
// 2. Kirim pesan: "I allow callmebot to send me messages"
// 3. Kamu akan dapat API key via WhatsApp
// 4. Isi di .env:
//      WHATSAPP_NUMBER=628xxxxxxxxxx   (format internasional, tanpa +)
//      WHATSAPP_APIKEY=xxxxxxxx
// ─────────────────────────────────────────────

const PHONE  = process.env.WHATSAPP_NUMBER;
const APIKEY = process.env.WHATSAPP_APIKEY;
const ENABLED = !!(PHONE && APIKEY);

if (!ENABLED) {
  console.log("[Notifier] WhatsApp notifikasi NONAKTIF — set WHATSAPP_NUMBER & WHATSAPP_APIKEY di .env");
}

// ── Core send ──────────────────────────────────────────────────────────────

async function send(text) {
  if (!ENABLED) return;
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://api.callmebot.com/whatsapp.php?phone=${PHONE}&text=${encoded}&apikey=${APIKEY}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[Notifier] Gagal kirim WA: HTTP ${res.status}`);
    }
  } catch (err) {
    // Jangan sampai error notifikasi menghentikan bot
    console.warn("[Notifier] Error kirim WA:", err.message);
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
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(Number(n)).toFixed(2)}`;
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

  const sideLabel  = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const modeLabel  = dryRun ? "[DRY RUN] " : "[LIVE] ";
  const coin       = symbol.replace("USDT", "");

  const lines = [
    `${modeLabel}*Quantara — Open Posisi*`,
    ``,
    `${sideLabel} ${coin}/USDT`,
    `📍 Entry  : $${fmtPrice(entryPrice)}`,
    size  != null ? `📦 Size   : ${Number(size).toFixed(4)} ${coin}` : null,
    sl    != null ? `🛡️ SL     : $${fmtPrice(sl)}` : null,
    tp    != null ? `🎯 TP     : $${fmtPrice(tp)}` : null,
    leverage > 1  ? `⚡ Leverage: ${leverage}x` : null,
    ``,
    `🕐 ${new Date().toLocaleString("id-ID")}`,
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

  const isWin     = (pnl ?? 0) >= 0;
  const sideLabel = side === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const resultIco = isWin ? "✅ PROFIT" : "❌ LOSS";
  const modeLabel = dryRun ? "[DRY RUN] " : "[LIVE] ";
  const coin      = symbol.replace("USDT", "");

  const reasonMap = { TP: "Take Profit 🎯", SL: "Stop Loss 🛡️", Reversal: "Reversal ↩️" };
  const reasonStr = reasonMap[reason] ?? reason ?? "—";

  const lines = [
    `${modeLabel}*Quantara — Close Posisi*`,
    ``,
    `${resultIco} | ${sideLabel} ${coin}/USDT`,
    `📍 Entry  : $${fmtPrice(entryPrice)}`,
    `📤 Exit   : $${fmtPrice(exitPrice)}`,
    pnl    != null ? `💰 PnL    : ${fmtPnl(pnl)}` : null,
    pnlPct != null ? `📈 ROI    : ${fmtPct(pnlPct)}` : null,
    `📋 Alasan : ${reasonStr}`,
    ``,
    `🕐 ${new Date().toLocaleString("id-ID")}`,
  ].filter(Boolean).join("\n");

  return send(lines);
}

// ── Export ────────────────────────────────────────────────────────────────

module.exports = { send, notifyOpen, notifyClose, enabled: ENABLED };
