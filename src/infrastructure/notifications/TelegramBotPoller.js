// ─────────────────────────────────────────────
// TelegramBotPoller — inbound /start handler
//
// TelegramNotifier hanya mengirim notifikasi keluar. Poller ini mendengarkan
// pesan masuk (long-polling getUpdates) dan membalas /start dengan Chat ID
// user agar bisa dihubungkan di Settings → Telegram.
// ─────────────────────────────────────────────

const cfg = require("../../config/env");

const TG_TOKEN = cfg.TELEGRAM_BOT_TOKEN;
const POLLING_ENABLED = !!(TG_TOKEN) && cfg.NODE_ENV !== "development";

let _running = false;
let _offset = 0;

async function tgApi(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(35_000),
  });
  return res.json();
}

async function sendReply(chatId, text) {
  const data = await tgApi("sendMessage", {
    chat_id:    chatId,
    text,
    parse_mode: "HTML",
  });
  if (!data.ok) {
    console.warn(`[TelegramBot] sendMessage error: ${data.description}`);
  }
}

function buildStartMessage(chatId, username) {
  const greet = username ? `@${username}` : "trader";
  return [
    `<b>Quantara Trading Bot</b>`,
    ``,
    `Halo ${greet}!`,
    ``,
    `Chat ID Anda:`,
    `<code>${chatId}</code>`,
    ``,
    `Salin angka di atas, lalu tempel di`,
    `<b>Settings → Telegram</b> di dashboard Quantara.`,
    ``,
    `Setelah terhubung, Anda akan menerima notifikasi open/close posisi dan alert operasional.`,
  ].join("\n");
}

async function handleMessage(msg) {
  const text = (msg.text || "").trim();
  const chatId = msg.chat?.id;
  if (!chatId || !text.startsWith("/")) return;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start" || command === "/id" || command === "/chatid") {
    await sendReply(chatId, buildStartMessage(chatId, msg.from?.username));
    return;
  }

  if (command === "/help") {
    await sendReply(chatId, [
      `<b>Quantara Trading Bot</b>`,
      ``,
      `/start — tampilkan Chat ID Anda`,
      `/id — sama dengan /start`,
      `/help — bantuan perintah`,
    ].join("\n"));
  }
}

async function pollOnce() {
  const data = await tgApi("getUpdates", {
    offset:          _offset,
    timeout:         25,
    allowed_updates: ["message"],
  });

  if (!data.ok) {
    console.warn("[TelegramBot] getUpdates error:", data.description);
    return;
  }

  for (const update of data.result || []) {
    _offset = update.update_id + 1;
    if (update.message) {
      try {
        await handleMessage(update.message);
      } catch (err) {
        console.warn("[TelegramBot] handleMessage error:", err.message);
      }
    }
  }
}

async function pollLoop() {
  while (_running) {
    try {
      await pollOnce();
    } catch (err) {
      if (_running) {
        console.warn("[TelegramBot] poll error:", err.message);
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
}

async function start() {
  if (!POLLING_ENABLED) {
    if (!TG_TOKEN) {
      console.log("[TelegramBot] Inbound handler NONAKTIF — TELEGRAM_BOT_TOKEN tidak di-set");
    } else {
      console.log("[TelegramBot] Inbound handler NONAKTIF — dimatikan di development");
    }
    return;
  }

  try {
    const deleted = await tgApi("deleteWebhook", { drop_pending_updates: false });
    if (!deleted.ok) {
      console.warn("[TelegramBot] deleteWebhook:", deleted.description);
    }
    const me = await tgApi("getMe");
    if (me.ok) {
      console.log(`[TelegramBot] Polling aktif sebagai @${me.result.username}`);
    }
  } catch (err) {
    console.warn("[TelegramBot] setup warning:", err.message);
  }

  _running = true;
  pollLoop();
}

function stop() {
  _running = false;
}

module.exports = { start, stop };
