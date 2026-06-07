#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * canary.js — Canary live-trading runner (langkah terakhir sebelum production)
 *
 * Tujuan: menjalankan SATU bot live dengan modal KECIL lalu memantau ketat
 * selama beberapa jam. Bertindak sebagai "rem darurat" otomatis:
 *   • Pre-flight safety check sebelum start (akun kecil, exchange terhubung).
 *   • Pantau equity tiap interval → AUTO-STOP bila drawdown lewat batas.
 *   • Scan log bot → AUTO-STOP bila terdeteksi "naked position" (SL gagal).
 *   • Heartbeat berkala + alert Telegram (bila dikonfigurasi) + ringkasan akhir.
 *
 * PENTING: skrip ini TIDAK menempatkan order sendiri. Order dilakukan BotEngine.
 * Canary hanya start/monitor/stop lewat API + membaca balance exchange.
 *
 * ── Konfigurasi (env) ────────────────────────────────────────────────────────
 *   CANARY_API_BASE          default http://localhost:3000
 *   CANARY_EMAIL             (wajib) email login
 *   CANARY_PASSWORD          (wajib) password login
 *   CANARY_SYMBOL            default BTCUSDT
 *   CANARY_STRATEGY          default ADAPTIVE_FUSION
 *   CANARY_CAPITAL           default 20      (USDT, modal bot)
 *   CANARY_MAX_ACCOUNT_USDT  default 100     (HARD GUARD: tolak jalan bila equity akun > ini)
 *   CANARY_MAX_DRAWDOWN_PCT  default 0.05    (5% dari equity awal → auto-stop)
 *   CANARY_POLL_SEC          default 60
 *   CANARY_DURATION_HOURS    default 24
 *   CANARY_AUTOSTART         default true    (false = hanya monitor bot yang sudah jalan)
 *   CANARY_STOP_ON_DRAWDOWN  default true
 *
 * ── Jalankan ─────────────────────────────────────────────────────────────────
 *   CANARY_EMAIL=you@mail.com CANARY_PASSWORD=secret \
 *   CANARY_CAPITAL=20 CANARY_MAX_DRAWDOWN_PCT=0.05 \
 *   node scripts/canary.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

const axios = require("axios");

let notifier = { send: async () => {}, enabled: false };
try { notifier = require("../src/infrastructure/notifications/TelegramNotifier"); } catch { /* opsional */ }

// ── Config ───────────────────────────────────────────────────────────────────
const CFG = {
  apiBase:        (process.env.CANARY_API_BASE || "http://localhost:3000").replace(/\/$/, ""),
  email:          process.env.CANARY_EMAIL || "",
  password:       process.env.CANARY_PASSWORD || "",
  symbol:         (process.env.CANARY_SYMBOL || "BTCUSDT").toUpperCase(),
  strategy:       process.env.CANARY_STRATEGY || "ADAPTIVE_FUSION",
  capital:        parseFloat(process.env.CANARY_CAPITAL || "20"),
  maxAccountUsdt: parseFloat(process.env.CANARY_MAX_ACCOUNT_USDT || "100"),
  maxDrawdownPct: parseFloat(process.env.CANARY_MAX_DRAWDOWN_PCT || "0.05"),
  pollSec:        parseInt(process.env.CANARY_POLL_SEC || "60", 10),
  durationHours:  parseFloat(process.env.CANARY_DURATION_HOURS || "24"),
  autoStart:      (process.env.CANARY_AUTOSTART || "true") !== "false",
  stopOnDD:       (process.env.CANARY_STOP_ON_DRAWDOWN || "true") !== "false",
};

// Penanda log bot yang menandakan kondisi berbahaya (anti naked position #4).
const DANGER_LOG_MARKERS = [
  "naked", "GAGAL tutup darurat", "INTERVENSI MANUAL",
  "SL tidak terkonfirmasi", "SL gagal",
];

// ── Util ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const pct = (n) => `${(Number(n ?? 0) * 100).toFixed(2)}%`;

function log(level, msg) {
  const tag = { info: "ℹ️ ", warn: "⚠️ ", error: "🚨", ok: "✅", beat: "💓" }[level] || "  ";
  console.log(`[${ts()}] ${tag} ${msg}`);
}

async function alert(msg) {
  log("error", msg);
  if (notifier.enabled) {
    try { await notifier.send(`🐤 <b>CANARY</b>\n${msg}`); } catch { /* non-fatal */ }
  }
}

// ── API client dengan auto-refresh token ─────────────────────────────────────
let accessToken = null;
let refreshToken = null;

async function login() {
  const { data } = await axios.post(`${CFG.apiBase}/api/v1/auth/login`, {
    email: CFG.email, password: CFG.password,
  });
  if (!data?.accessToken) throw new Error("Login gagal — accessToken kosong");
  accessToken  = data.accessToken;
  refreshToken = data.refreshToken;
  return data;
}

async function api(method, path, body = null, _retried = false) {
  try {
    const { data } = await axios({
      method,
      url: `${CFG.apiBase}${path}`,
      data: body || undefined,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      timeout: 20_000,
      validateStatus: (s) => s < 500, // biar bisa baca 4xx
    });
    return data;
  } catch (err) {
    // 401 → coba login ulang sekali (token access 15m expired saat monitor lama)
    if (!_retried && err.response?.status === 401) {
      await login();
      return api(method, path, body, true);
    }
    throw err;
  }
}

// Token access bisa expired di tengah monitor → refresh proaktif tiap ~12 menit.
async function refreshTokenProactive() {
  try {
    const { data } = await axios.post(`${CFG.apiBase}/api/v1/auth/refresh`, { refreshToken });
    if (data?.accessToken) accessToken = data.accessToken;
  } catch { /* fallback: api() akan re-login saat 401 */ }
}

// ── Pre-flight safety checks ─────────────────────────────────────────────────
async function preflight() {
  log("info", `Canary target: ${CFG.apiBase} | symbol ${CFG.symbol} | strategi ${CFG.strategy}`);

  if (!CFG.email || !CFG.password) {
    throw new Error("CANARY_EMAIL & CANARY_PASSWORD wajib diset.");
  }
  if (!(CFG.capital > 0)) throw new Error(`CANARY_CAPITAL tidak valid: ${CFG.capital}`);
  if (!(CFG.maxDrawdownPct > 0 && CFG.maxDrawdownPct < 1)) {
    throw new Error(`CANARY_MAX_DRAWDOWN_PCT harus 0..1, dapat ${CFG.maxDrawdownPct}`);
  }

  // 1) Login
  await login();
  log("ok", `Login berhasil sebagai ${CFG.email}`);

  // 2) Exchange terhubung + ambil equity riil
  const bal = await api("GET", "/api/v1/account/exchange-balance");
  if (!bal?.configured) {
    throw new Error("Exchange belum terhubung (API key belum dikonfigurasi di Settings).");
  }
  const equity = Number(bal.equity || bal.available || 0);
  if (!(equity > 0)) throw new Error(`Equity exchange 0/invalid (${equity}). Top-up dulu atau cek API key.`);
  log("ok", `Exchange terhubung — equity akun ${usd(equity)} (available ${usd(bal.available)})`);

  // 3) HARD GUARD: tolak jalan di akun besar (canary HARUS kecil)
  if (equity > CFG.maxAccountUsdt) {
    throw new Error(
      `ABORT: equity akun ${usd(equity)} > batas canary ${usd(CFG.maxAccountUsdt)}. ` +
      `Canary hanya boleh di akun kecil. Naikkan CANARY_MAX_ACCOUNT_USDT secara sadar bila memang disengaja.`
    );
  }

  // 4) Modal bot tidak melebihi equity
  if (CFG.capital > equity) {
    throw new Error(`CANARY_CAPITAL ${usd(CFG.capital)} > equity akun ${usd(equity)}.`);
  }

  log("ok", `Pre-flight lolos. Drawdown limit ${pct(CFG.maxDrawdownPct)} → auto-stop. Durasi ${CFG.durationHours} jam.`);
  return { equity };
}

// ── Start / Stop bot via API ─────────────────────────────────────────────────
async function startBotLive() {
  const res = await api("POST", `/api/v1/bots/${CFG.symbol}/start`, {
    capital: CFG.capital,
    strategyKey: CFG.strategy,
    dryRun: false, // LIVE — ini canary uang nyata
  });
  if (res?.ok === false) throw new Error(`Gagal start bot: ${res.message || JSON.stringify(res)}`);
  log("ok", `Bot ${CFG.symbol} START (LIVE, modal ${usd(CFG.capital)})`);
  await alert(`Canary START — ${CFG.symbol} LIVE modal ${usd(CFG.capital)} (DD limit ${pct(CFG.maxDrawdownPct)})`);
}

async function stopBot(reason) {
  try {
    await api("POST", `/api/v1/bots/${CFG.symbol}/stop`, {});
    log("warn", `Bot ${CFG.symbol} STOP — ${reason}`);
  } catch (e) {
    await alert(`GAGAL stop bot ${CFG.symbol}: ${e.message} — STOP MANUAL DI DASHBOARD/EXCHANGE!`);
  }
}

// ── Monitoring ───────────────────────────────────────────────────────────────
async function getEquity() {
  const bal = await api("GET", "/api/v1/account/exchange-balance");
  return Number(bal?.equity || bal?.available || 0);
}

async function scanDangerLogs(seenSet) {
  try {
    const res = await api("GET", `/api/v1/bots/${CFG.symbol}/logs?limit=50`);
    const logs = res?.logs || [];
    const hits = [];
    for (const l of logs) {
      const key = `${l.time}|${l.msg}`;
      if (seenSet.has(key)) continue;
      seenSet.add(key);
      if ((l.level === "error" || l.level === "warn") &&
          DANGER_LOG_MARKERS.some((m) => String(l.msg).includes(m))) {
        hits.push(l.msg);
      }
    }
    return hits;
  } catch { return []; }
}

async function run() {
  console.log("\n🐤 ══════════ QUANTARA CANARY ══════════\n");

  const { equity: startEquity } = await preflight();

  if (CFG.autoStart) await startBotLive();
  else log("info", "AUTOSTART=false → hanya monitor bot yang sudah berjalan.");

  let peakEquity = startEquity;
  let minEquity  = startEquity;
  let polls = 0;
  let nakedDetected = false;
  const seenLogs = new Set();
  const startedAt = Date.now();
  const endAt = startedAt + CFG.durationHours * 3600_000;
  let lastRefresh = Date.now();

  // Graceful stop
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log("warn", `Sinyal ${sig} diterima — menghentikan canary...`);
    if (CFG.autoStart) await stopBot(`shutdown (${sig})`);
    await summary({ startEquity, peakEquity, minEquity, polls, nakedDetected, reason: `manual ${sig}` });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (Date.now() < endAt && !stopping) {
    await sleep(CFG.pollSec * 1000);
    polls++;

    // Refresh token proaktif tiap ~12 menit
    if (Date.now() - lastRefresh > 12 * 60_000) { await refreshTokenProactive(); lastRefresh = Date.now(); }

    let equity, state;
    try {
      equity = await getEquity();
      state  = await api("GET", `/api/v1/bots/${CFG.symbol}`);
    } catch (e) {
      log("warn", `Poll gagal: ${e.message} — lanjut poll berikutnya`);
      continue;
    }

    if (equity > peakEquity) peakEquity = equity;
    if (equity < minEquity)  minEquity = equity;

    const ddFromStart = startEquity > 0 ? (startEquity - equity) / startEquity : 0;
    const ddFromPeak  = peakEquity  > 0 ? (peakEquity - equity) / peakEquity  : 0;

    const st = state?.state || {};
    const openN = (st.openPositions?.length) ?? st.openTradeCount ?? 0;
    const trades = st.closedTrades ?? 0;
    const errs = st.errors ?? 0;

    log("beat",
      `equity ${usd(equity)} | DD start ${pct(ddFromStart)} / peak ${pct(ddFromPeak)} | ` +
      `open ${openN} | closed ${trades} | errs ${errs} | last ${usd(st.lastPrice)}`
    );

    // ── Cek bahaya: naked position dari log ──────────────────────────────────
    const danger = await scanDangerLogs(seenLogs);
    if (danger.length) {
      nakedDetected = true;
      await alert(`Naked/SL-failure terdeteksi di log bot:\n• ${danger.slice(0, 3).join("\n• ")}`);
      await stopBot("naked position / SL failure terdeteksi");
      break;
    }

    // ── Cek drawdown → auto-stop ─────────────────────────────────────────────
    if (ddFromStart >= CFG.maxDrawdownPct) {
      await alert(
        `DRAWDOWN LIMIT TEMBUS: ${pct(ddFromStart)} ≥ ${pct(CFG.maxDrawdownPct)} ` +
        `(equity ${usd(equity)} dari ${usd(startEquity)})`
      );
      if (CFG.stopOnDD && CFG.autoStart) { await stopBot("drawdown limit"); }
      break;
    }

    // Warn bila error bertumpuk
    if (errs >= 5) log("warn", `Bot melaporkan ${errs} error beruntun — pantau koneksi exchange.`);
  }

  if (!stopping) {
    const reason = nakedDetected ? "naked detected"
      : (Date.now() >= endAt ? "durasi selesai" : "drawdown limit");
    if (CFG.autoStart && Date.now() >= endAt) await stopBot("durasi canary selesai");
    await summary({ startEquity, peakEquity, minEquity, polls, nakedDetected, reason });
  }
}

async function summary({ startEquity, peakEquity, minEquity, polls, nakedDetected, reason }) {
  let endEquity = startEquity;
  try { endEquity = await getEquity(); } catch { /* pakai terakhir */ }
  const pnl = endEquity - startEquity;
  const pnlPct = startEquity > 0 ? pnl / startEquity : 0;
  const maxDD = peakEquity > 0 ? (peakEquity - minEquity) / peakEquity : 0;

  const verdict = nakedDetected ? "❌ GAGAL (naked/SL failure) — JANGAN naikkan ke production"
    : pnlPct <= -CFG.maxDrawdownPct ? "❌ GAGAL (drawdown limit tembus) — investigasi dulu"
    : "✅ LOLOS canary — lanjut evaluasi sebelum scale-up";

  const lines = [
    "",
    "🐤 ════════ CANARY SUMMARY ════════",
    `  Alasan berhenti : ${reason}`,
    `  Polls           : ${polls}`,
    `  Equity awal     : ${usd(startEquity)}`,
    `  Equity akhir    : ${usd(endEquity)}`,
    `  PnL             : ${usd(pnl)} (${pct(pnlPct)})`,
    `  Peak / Min      : ${usd(peakEquity)} / ${usd(minEquity)}`,
    `  Max drawdown    : ${pct(maxDD)}`,
    `  Naked detected  : ${nakedDetected ? "YA" : "tidak"}`,
    `  VERDICT         : ${verdict}`,
    "════════════════════════════════════",
    "",
  ];
  console.log(lines.join("\n"));
  if (notifier.enabled) { try { await notifier.send(`🐤 <b>CANARY SUMMARY</b>\n${verdict}\nPnL ${usd(pnl)} (${pct(pnlPct)}) | maxDD ${pct(maxDD)}`); } catch { /* noop */ } }
}

run().catch(async (err) => {
  await alert(`Canary FATAL: ${err.message}`);
  console.error(err.stack || err.message);
  process.exit(1);
});
