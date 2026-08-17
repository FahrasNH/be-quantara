/**
 * Wyckoff customizable local backtest — prints PnL / win rate / drawdown / etc.
 *
 * No deploy required. Default source is mock (offline CI-safe).
 * For last-12-months real candles, use public exchange fetch (binance by default).
 *
 * ── Config (env or CLI flags) ──────────────────────────────────────────────
 *   WYCKOFF_BT_SOURCE / --source     mock | real          (default: mock)
 *   WYCKOFF_BT_MONTHS / --months     number               (default: 12)
 *   WYCKOFF_BT_SYMBOL / --symbol     BTCUSDT              (default: BTCUSDT)
 *   WYCKOFF_BT_TYPES  / --types      Intraday|Scalping|…  (default: Intraday)
 *   WYCKOFF_BT_CAPITAL / --capital   1000                 (default: 1000)
 *   WYCKOFF_BT_EXCHANGE / --exchange binance|bitget|okx   (default: binance)
 *   WYCKOFF_BT_ENTRY_MODEL / --entry-model  balanced|moderate|aggressive|conservative
 *   WYCKOFF_BT_FEES / --fees         0|1                  (default: 0 for mock, 1 for real)
 *   WYCKOFF_BT_OUT_DIR / --out       custom output folder (optional)
 *   WYCKOFF_BT_OUT_FILE / --out-file custom single .txt path (optional)
 *
 * After each run, ONE combined report file is written:
 *   backtest-reports/wyckoff/<timestamp>_<symbol>_<Nm>_<source>_....txt
 *   (summary + index table + funnel + detail every position)
 *
 * ── Run ────────────────────────────────────────────────────────────────────
 *   # Prefer the CLI script (Node 24 `node --test` does NOT forward --flags):
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --symbol BTCUSDT --types Scalping,Intraday,Swing --fees 1
 *   npm run wyckoff:report -- --source real --types Scalping --fees 1
 *   npm run test:wyckoff:12m
 *
 *   # Env overrides also work under `node --test`:
 *   set WYCKOFF_BT_TYPES=Scalping,Intraday,Swing&& set WYCKOFF_BT_SOURCE=real&& npm run test:wyckoff:report
 *
 *   # CI-safe mock (no network)
 *   npm run test:wyckoff:report
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { runTripleTypeBacktest } = require("#modules/backtest/services/RealStrategyBacktestService.js");
const {
  applyStrategyJobDefaults,
  TYPE_TF,
} = require("#modules/backtest/services/runBacktestJob.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, "backtest-reports", "wyckoff");

// ── Config parsing ───────────────────────────────────────────────────────────

function parseCfg(argv = process.argv.slice(2)) {
  // node --test: args after `--` are forwarded to the test file. Depending on
  // Node version, the literal `--` may or may not remain in process.argv.
  // When it is stripped, values like "Scalping,Intraday,Swing" no longer sit
  // next to "--types" if we only keep tokens that start with "--" — that bug
  // silently fell back to default types=Intraday.
  const dash = argv.indexOf("--");
  let args;
  if (dash >= 0) {
    args = argv.slice(dash + 1);
  } else {
    // Keep flag+value pairs: "--types", "Scalping,Intraday,Swing", ...
    args = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!String(a).startsWith("--")) continue;
      args.push(a);
      const next = argv[i + 1];
      if (next != null && !String(next).startsWith("--")) {
        args.push(next);
        i += 1;
      }
    }
  }

  const get = (flag, envKey, def) => {
    const i = args.indexOf(flag);
    if (i !== -1 && args[i + 1] != null && !String(args[i + 1]).startsWith("--")) {
      return args[i + 1];
    }
    if (process.env[envKey] != null && process.env[envKey] !== "") {
      return process.env[envKey];
    }
    return def;
  };

  const source = String(get("--source", "WYCKOFF_BT_SOURCE", "mock")).toLowerCase();
  const months = Math.max(1, parseInt(get("--months", "WYCKOFF_BT_MONTHS", "12"), 10) || 12);
  const feesFlag = get("--fees", "WYCKOFF_BT_FEES", source === "real" ? "1" : "0");

  return {
    source: source === "real" || source === "db" ? "real" : "mock",
    months,
    days: Math.round(months * 30.44),
    symbol: String(get("--symbol", "WYCKOFF_BT_SYMBOL", "BTCUSDT")).toUpperCase(),
    types: String(get("--types", "WYCKOFF_BT_TYPES", "Intraday"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    capital: parseFloat(get("--capital", "WYCKOFF_BT_CAPITAL", "1000")) || 1000,
    exchange: String(get("--exchange", "WYCKOFF_BT_EXCHANGE", "binance")).toLowerCase(),
    entryModel: String(get("--entry-model", "WYCKOFF_BT_ENTRY_MODEL", "balanced")),
    enableFees: feesFlag === "1" || feesFlag === "true",
    userId: get("--user", "WYCKOFF_BT_USER_ID", process.env.DATASET_EXPAND_USER_ID || null),
    outDir: get("--out", "WYCKOFF_BT_OUT_DIR", null),
    outFile: get("--out-file", "WYCKOFF_BT_OUT_FILE", null),
  };
}

const CFG = parseCfg();

const TF_MIN = {
  "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080,
};

// ── Candle loaders ───────────────────────────────────────────────────────────

/** Deterministic regime-cycling mock (same spirit as scripts/backtest-af-real.js). */
function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000
    : symbol.startsWith("ETH") ? 3500
      : 600;
  let price = seed;
  // End "now", walk backward so the window is the last N months
  let time = Date.now() - bars * intervalMin * 60_000;
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.max(1, Math.floor((24 * 60) / intervalMin));
  const candles = [];
  let s = 123456789;
  const rnd = () => {
    s = (1103515245 * s + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];
    let drift;
    let noiseAmp;
    switch (regime) {
      case "STRONG_UP": drift = price * 0.0015; noiseAmp = 0.004; break;
      case "STRONG_DOWN": drift = -price * 0.0015; noiseAmp = 0.004; break;
      case "VOLATILE_CHOP": drift = (rnd() - 0.5) * price * 0.003; noiseAmp = 0.012; break;
      default: drift = (rnd() - 0.45) * price * 0.0008; noiseAmp = 0.005;
    }
    const noise = (rnd() - 0.5) * price * noiseAmp * 2;
    const open = price;
    const close = Math.max(price + drift + noise, 1);
    const high = Math.max(open, close) * (1 + rnd() * noiseAmp);
    const low = Math.min(open, close) * (1 - rnd() * noiseAmp);
    candles.push({
      timestamp: time,
      date: new Date(time).toISOString(),
      open,
      high,
      low,
      close,
      volume: 1000 + rnd() * 2000,
    });
    price = close;
    time += intervalMin * 60_000;
  }
  return candles;
}

/** Public Binance Vision OHLCV (no API key; works when api.binance.com is blocked). */
async function fetchBinanceVisionKlines(symbol, interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const limit = 1000;
  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}`
      + `&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${endMs}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`binance.vision HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (ts < startMs || ts > endMs) continue;
      out.push({
        timestamp: ts,
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
      });
    }
    const lastTs = Number(rows[rows.length - 1][0]);
    const next = lastTs + 1;
    if (next <= cursor || rows.length < limit) break;
    cursor = next;
  }
  return out;
}

async function loadCandles(tf, cfg) {
  const intervalMin = TF_MIN[tf] || 15;
  if (cfg.source === "mock") {
    return { candles: genMock(cfg.symbol, cfg.days, intervalMin), source: "mock" };
  }

  const end = new Date();
  const start = new Date(end.getTime() - cfg.days * 24 * 60 * 60 * 1000);

  // Prefer Binance Vision public data API (reachable when api.binance.com is geo-blocked).
  if (cfg.exchange === "binance" || cfg.exchange === "binanceusdm") {
    try {
      const candles = await fetchBinanceVisionKlines(
        cfg.symbol,
        tf,
        start.getTime(),
        end.getTime(),
      );
      if (candles.length > 50) {
        return { candles, source: "binance.vision", meta: { count: candles.length } };
      }
    } catch (err) {
      console.warn(`[wyckoff-report] binance.vision fetch failed: ${err.message}`);
    }
  }

  const HistoricalKlinesService = require("#modules/backtest/services/HistoricalKlinesService.js");
  const res = await HistoricalKlinesService.fetchHistoricalKlines(cfg.userId, {
    symbol: cfg.symbol,
    timeframe: tf,
    start: start.toISOString(),
    end: end.toISOString(),
    exchangeType: cfg.exchange,
    allowClamp: true,
  });
  return { candles: res.candles || [], source: res.exchange || cfg.exchange, meta: res };
}

// ── Report printer ───────────────────────────────────────────────────────────

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}`;
}

function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return `${v}%`;
}

function computeExtraStats(trades, capital) {
  const list = Array.isArray(trades) ? trades : [];
  const wins = list.filter((t) => t.result === "win" || (t.pnl ?? t.pnlNet ?? 0) > 0);
  const losses = list.filter((t) => t.result === "loss" || (t.pnl ?? t.pnlNet ?? 0) < 0);
  const totalPnl = list.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const totalPnlNet = list.reduce((s, t) => s + (t.pnlNet ?? t.pnl ?? 0), 0);
  const totalFees = list.reduce((s, t) => s + (t.fee || 0), 0);

  const bySide = {};
  for (const side of ["LONG", "SHORT"]) {
    const subset = list.filter((t) => String(t.side).toUpperCase() === side);
    const w = subset.filter((t) => (t.pnl ?? 0) > 0).length;
    bySide[side] = {
      trades: subset.length,
      wins: w,
      winRate: subset.length ? ((w / subset.length) * 100).toFixed(1) : "0.0",
      pnl: subset.reduce((s, t) => s + (t.pnl ?? 0), 0),
    };
  }

  const exits = {};
  for (const t of list) {
    const r = t.reason || t.exitReason || "unknown";
    exits[r] = (exits[r] || 0) + 1;
  }

  return {
    totalPnl,
    totalPnlNet,
    totalFees,
    wins: wins.length,
    losses: losses.length,
    bySide,
    exits,
    finalCapital: capital + totalPnlNet,
  };
}

function printReport(cfg, result, loadMeta) {
  const stats = result.stats || {};
  const trades = result.trades || [];
  const extra = computeExtraStats(trades, cfg.capital);
  const line = "─".repeat(56);

  console.log(`\n${"═".repeat(58)}`);
  console.log(`  WYCKOFF LOCAL BACKTEST REPORT`);
  console.log(`${"═".repeat(58)}`);
  console.log(`  Symbol        : ${cfg.symbol}`);
  console.log(`  Window        : last ${cfg.months} month(s) (~${cfg.days}d)`);
  console.log(`  Source        : ${cfg.source}${loadMeta?.source ? ` (${loadMeta.source})` : ""}`);
  console.log(`  Types         : ${cfg.types.join(", ")}`);
  console.log(`  Entry model   : ${cfg.entryModel}`);
  console.log(`  Capital       : $${cfg.capital}`);
  console.log(`  Fees          : ${cfg.enableFees ? "ON" : "OFF"}`);
  if (loadMeta?.bars) {
    console.log(`  Entry bars    : ${loadMeta.bars.entry?.toLocaleString?.() ?? loadMeta.bars.entry}`);
    console.log(`  HTF bars      : ${loadMeta.bars.htf?.toLocaleString?.() ?? loadMeta.bars.htf}`);
  }
  console.log(line);
  console.log(`  Total Trades  : ${stats.totalTrades ?? trades.length}  (${extra.wins}W / ${extra.losses}L)`);
  console.log(`  Win Rate      : ${pct(stats.winRate ?? (trades.length ? ((extra.wins / trades.length) * 100).toFixed(1) : "0.0"))}`);
  console.log(`  Total PnL     : $${money(extra.totalPnl)}   (net $${money(extra.totalPnlNet)})`);
  console.log(`  Net Return    : ${pct(stats.totalReturn)}   (final $${stats.finalCapital ?? extra.finalCapital.toFixed(2)})`);
  console.log(`  Profit Factor : ${stats.profitFactor ?? "n/a"}`);
  console.log(`  Avg Win/Loss  : $${stats.avgWin ?? "0.00"} / $${stats.avgLoss ?? "0.00"}  (RR ${stats.riskReward ?? "n/a"})`);
  console.log(`  Max Drawdown  : ${pct(stats.maxDrawdown)}`);
  console.log(`  Sharpe        : ${stats.sharpe ?? "n/a"}`);
  console.log(`  Total Fees    : $${stats.totalFees ?? extra.totalFees.toFixed(2)}`);
  console.log(line);
  console.log(
    `  By Direction  : LONG ${extra.bySide.LONG.trades} (${extra.bySide.LONG.winRate}% WR, $${money(extra.bySide.LONG.pnl)})`
    + `  |  SHORT ${extra.bySide.SHORT.trades} (${extra.bySide.SHORT.winRate}% WR, $${money(extra.bySide.SHORT.pnl)})`,
  );
  const exitStr = Object.entries(extra.exits).map(([k, v]) => `${k}:${v}`).join("  |  ") || "none";
  console.log(`  By Exit       : ${exitStr}`);

  // Per-type breakdown
  if (result.perTypeStats) {
    console.log(line);
    for (const [type, ts] of Object.entries(result.perTypeStats)) {
      if (!ts || ts.skipped) {
        console.log(`  ${type.padEnd(10)} : SKIPPED ${ts?.reason ? `(${ts.reason})` : ""}`);
        continue;
      }
      const opened = ts.execAblation?.opened ?? "?";
      const passed = ts.ablation?.passed ?? "?";
      console.log(
        `  ${type.padEnd(10)} : trades=${ts.trades ?? 0}  wins=${ts.wins ?? 0}`
        + `  passed=${passed}  opened=${opened}  bars=${ts.entryBars ?? "?"}`,
      );
    }
  }
  console.log(`${"═".repeat(58)}\n`);

  return { stats, extra, trades };
}

// ── Save detailed position dumps to .txt folder ──────────────────────────────

function fmtNum(n, digits = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return n == null ? "-" : String(n);
  return v.toFixed(digits);
}

function formatDuration(openTime, closeTime) {
  const a = Date.parse(openTime);
  const b = Date.parse(closeTime);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return "-";
  const mins = Math.round((b - a) / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return `${h}h ${m}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function pickMeta(trade) {
  const meta = trade.entryMeta || trade.meta || {};
  const lines = [];
  const keys = [
    "reason", "wyPatternType", "wyPhase", "wyPhaseStrength", "wyVolumeRatio",
    "wyRr", "wySosOrSow", "wyLpsLevel", "wyEntryModel", "wyFakeBreakDepthAtr",
    "confidence", "plannedRR", "htfTrend", "dailyRegime", "marketCond",
  ];
  for (const k of keys) {
    const v = trade[k] ?? meta[k] ?? meta?.entry?.[k];
    if (v != null && v !== "") lines.push(`  ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  if (trade.entryReasons) {
    lines.push(`  entryReasons: ${trade.entryReasons}`);
  }
  // Dump leftover useful nested bits (compact)
  if (meta && typeof meta === "object") {
    const phase = meta.phase?.phase || meta.phase;
    const event = meta.signal?.event || meta.entry?.event;
    if (phase && !lines.some((l) => l.includes("wyPhase"))) lines.push(`  phase: ${phase}`);
    if (event) lines.push(`  signalEvent: ${event}`);
    if (meta.stopLoss != null) lines.push(`  meta.stopLoss: ${fmtNum(meta.stopLoss)}`);
    if (meta.takeProfit != null) lines.push(`  meta.takeProfit: ${fmtNum(meta.takeProfit)}`);
    if (meta.rr != null) lines.push(`  meta.rr: ${fmtNum(meta.rr, 2)}`);
  }
  return lines.length ? lines.join("\n") : "  (none)";
}

function formatPositionBlock(trade, index, runningPnl) {
  const entry = trade.entry ?? trade.entryPrice;
  const exit = trade.exit ?? trade.exitPrice;
  const pnl = trade.pnl ?? 0;
  const pnlNet = trade.pnlNet ?? pnl;
  const size = trade.size ?? trade.quantity;
  const result = trade.result || (pnl > 0 ? "win" : pnl < 0 ? "loss" : "flat");
  const lines = [
    `${"=".repeat(64)}`,
    `POSITION #${String(index).padStart(4, "0")}  |  ${String(trade.side || "?").toUpperCase()}  |  ${String(result).toUpperCase()}`,
    `${"=".repeat(64)}`,
    `Symbol       : ${trade.symbol || CFG.symbol}`,
    `Strategy     : ${trade.strategy || "WYCKOFF"}`,
    `Trade type   : ${trade.tradeType || trade.component || "-"}`,
    `Component    : ${trade.winningComponent || trade.component || "-"}`,
    ``,
    `Open time    : ${trade.openTime || trade.date || "-"}`,
    `Close time   : ${trade.closeTime || trade.date || "-"}`,
    `Duration     : ${formatDuration(trade.openTime, trade.closeTime || trade.date)}`,
    ``,
    `Entry price  : ${fmtNum(entry)}`,
    `Exit price   : ${fmtNum(exit)}`,
    `Stop loss    : ${fmtNum(trade.sl ?? trade.stopLoss)}`,
    `Take profit  : ${fmtNum(trade.tp ?? trade.takeProfit)}`,
    `Size         : ${fmtNum(size, 6)}`,
    `ATR (entry)  : ${fmtNum(trade.atr, 6)}`,
    `Planned RR   : ${fmtNum(trade.plannedRR, 2)}`,
    `Confidence   : ${fmtNum(trade.confidence, 3)}`,
    ``,
    `Gross PnL    : $${money(trade.grossPnl ?? pnl)}`,
    `Fee          : $${fmtNum(trade.fee ?? 0, 4)}`,
    `PnL          : $${money(pnl)}   (${fmtNum(trade.pnlPct, 2)}%)`,
    `PnL net      : $${money(pnlNet)}`,
    `Running PnL  : $${money(runningPnl)}`,
    ``,
    `Exit reason  : ${trade.reason || trade.exitReason || "-"}`,
    `Result       : ${result}`,
    `Partial      : ${trade.isPartial ? "yes" : "no"}`,
    ``,
    `HTF trend    : ${trade.htfTrend ?? "-"}`,
    `Daily regime : ${trade.dailyRegime ?? "-"}`,
    `Market cond  : ${trade.marketCond ?? "-"}`,
    `Entry RSI    : ${fmtNum(trade.entryRsi, 2)}`,
    ``,
    `-- Entry / Wyckoff meta --`,
    pickMeta(trade),
    ``,
  ];
  return lines.join("\n");
}

function buildSummarySection(cfg, result, loadMeta, report, filePath) {
  const stats = result.stats || {};
  const extra = report.extra;
  const lines = [
    "WYCKOFF LOCAL BACKTEST REPORT (SINGLE FILE)",
    "=".repeat(64),
    `Generated    : ${new Date().toISOString()}`,
    `Report file  : ${filePath}`,
    `Symbol       : ${cfg.symbol}`,
    `Window       : last ${cfg.months} month(s) (~${cfg.days}d)`,
    `Source       : ${cfg.source}${loadMeta?.source ? ` (${loadMeta.source})` : ""}`,
    `Types        : ${cfg.types.join(", ")}`,
    `Entry model  : ${cfg.entryModel}`,
    `Capital      : $${cfg.capital}`,
    `Fees         : ${cfg.enableFees ? "ON" : "OFF"}`,
    `Exchange     : ${cfg.exchange}`,
    "",
    `Entry bars   : ${loadMeta?.bars?.entry ?? "-"}`,
    `HTF bars     : ${loadMeta?.bars?.htf ?? "-"}`,
    "",
    "-".repeat(64),
    "SUMMARY",
    "-".repeat(64),
    `Total Trades : ${stats.totalTrades ?? report.trades.length}  (${extra.wins}W / ${extra.losses}L)`,
    `Win Rate     : ${pct(stats.winRate)}`,
    `Total PnL    : $${money(extra.totalPnl)}   (net $${money(extra.totalPnlNet)})`,
    `Net Return   : ${pct(stats.totalReturn)}   (final $${stats.finalCapital ?? extra.finalCapital.toFixed(2)})`,
    `Profit Factor: ${stats.profitFactor}`,
    `Avg Win/Loss : $${stats.avgWin} / $${stats.avgLoss}  (RR ${stats.riskReward})`,
    `Max Drawdown : ${pct(stats.maxDrawdown)}`,
    `Sharpe       : ${stats.sharpe}`,
    `Total Fees   : $${stats.totalFees ?? extra.totalFees.toFixed(2)}`,
    "",
    `LONG         : ${extra.bySide.LONG.trades} trades, WR ${extra.bySide.LONG.winRate}%, PnL $${money(extra.bySide.LONG.pnl)}`,
    `SHORT        : ${extra.bySide.SHORT.trades} trades, WR ${extra.bySide.SHORT.winRate}%, PnL $${money(extra.bySide.SHORT.pnl)}`,
    `Exits        : ${Object.entries(extra.exits).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    "",
  ];

  if (result.perTypeStats) {
    lines.push("Per trade-type:");
    for (const [type, ts] of Object.entries(result.perTypeStats)) {
      if (!ts || ts.skipped) {
        lines.push(`  ${type}: SKIPPED ${ts?.reason || ""}`);
        continue;
      }
      lines.push(
        `  ${type}: trades=${ts.trades ?? 0} wins=${ts.wins ?? 0}`
        + ` passed=${ts.ablation?.passed ?? "-"} opened=${ts.execAblation?.opened ?? "-"}`
        + ` bars=${ts.entryBars ?? "-"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildIndexSection(trades) {
  const lines = [
    "-".repeat(64),
    "POSITION INDEX",
    "-".repeat(64),
    "IDX  | RESULT | SIDE  | TYPE      | OPEN                 | CLOSE                | ENTRY      | EXIT       | PnL       | REASON",
    "-".repeat(120),
  ];
  trades.forEach((t, i) => {
    lines.push([
      String(i + 1).padStart(4, " "),
      String(t.result || "-").padEnd(6, " "),
      String(t.side || "-").padEnd(5, " "),
      String(t.tradeType || t.component || "-").padEnd(9, " "),
      String(t.openTime || "-").slice(0, 19).padEnd(20, " "),
      String(t.closeTime || t.date || "-").slice(0, 19).padEnd(20, " "),
      fmtNum(t.entry ?? t.entryPrice, 2).padStart(10, " "),
      fmtNum(t.exit ?? t.exitPrice, 2).padStart(10, " "),
      money(t.pnl ?? 0).padStart(9, " "),
      String(t.reason || t.exitReason || "-"),
    ].join(" | "));
  });
  if (!trades.length) lines.push("(no closed trades)");
  lines.push("");
  return lines.join("\n");
}

function buildFunnelSection(result) {
  const lines = [
    "-".repeat(64),
    "ABLATION / EXECUTION FUNNEL",
    "-".repeat(64),
    "",
  ];
  const pts = result.perTypeStats || {};
  if (!Object.keys(pts).length) {
    lines.push("(no perTypeStats)", "");
    return lines.join("\n");
  }
  for (const [type, ts] of Object.entries(pts)) {
    lines.push(`-- ${type} --`);
    if (!ts || ts.skipped) {
      lines.push(`  skipped: ${ts?.reason || "yes"}`, "");
      continue;
    }
    lines.push(`  trades      : ${ts.trades ?? 0}`);
    lines.push(`  wins        : ${ts.wins ?? 0}`);
    lines.push(`  entryBars   : ${ts.entryBars ?? 0}`);
    lines.push(`  htfBars     : ${ts.htfBars ?? 0}`);
    if (ts.ablationKey) lines.push(`  ablationKey : ${ts.ablationKey}`);
    if (ts.ablation && typeof ts.ablation === "object") {
      lines.push("  strategy ablation:");
      for (const [k, v] of Object.entries(ts.ablation)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    if (ts.execAblation && typeof ts.execAblation === "object") {
      lines.push("  execution ablation:");
      for (const [k, v] of Object.entries(ts.execAblation)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildPositionsSection(trades) {
  const lines = [
    "-".repeat(64),
    `POSITION DETAILS (${trades.length} trades)`,
    "-".repeat(64),
    "",
  ];
  let running = 0;
  trades.forEach((t, i) => {
    running += t.pnl ?? 0;
    lines.push(formatPositionBlock(t, i + 1, running));
  });
  if (!trades.length) lines.push("(no closed trades in this run)", "");
  return lines.join("\n");
}

/**
 * Write ONE combined .txt report under backtest-reports/wyckoff/
 * @returns {{ outFile: string, outDir: string, tradeCount: number }}
 */
function savePositionReports(cfg, result, loadMeta, report) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = [
    stamp,
    cfg.symbol,
    `${cfg.months}m`,
    cfg.source,
    cfg.types.join("-") || "Intraday",
    cfg.entryModel,
  ].join("_");

  const outDir = cfg.outDir
    ? path.resolve(cfg.outDir)
    : DEFAULT_OUT_ROOT;
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = cfg.outFile
    ? path.resolve(cfg.outFile)
    : path.join(outDir, `${runId}.txt`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const trades = report.trades || result.trades || [];
  const body = [
    buildSummarySection(cfg, result, loadMeta, report, outFile),
    buildIndexSection(trades),
    buildFunnelSection(result),
    buildPositionsSection(trades),
    "=".repeat(64),
    "END OF REPORT",
    "=".repeat(64),
    "",
  ].join("\n");

  fs.writeFileSync(outFile, body, "utf8");

  // Pointer at repo root for easy discovery in the IDE
  try {
    const pointer = [
      "WYCKOFF backtest report (latest — single file)",
      "",
      outFile,
      "",
      `Trades : ${trades.length}`,
      `Generated : ${new Date().toISOString()}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(REPO_ROOT, "WYCKOFF_REPORT_LATEST.txt"), pointer, "utf8");
  } catch {
    /* ignore pointer write failures */
  }

  return { outFile, outDir, tradeCount: trades.length, files: [outFile] };
}

// ── Backtest runner ──────────────────────────────────────────────────────────

async function runWyckoffCustomBacktest(cfg) {
  const typeOrder = cfg.types.filter((t) => TYPE_TF[t]);
  if (!typeOrder.length) {
    throw new Error(`No valid trade types in: ${cfg.types.join(",")}. Use Scalping, Intraday, and/or Swing.`);
  }

  const entryCandles = {};
  const htfCandles = {};
  const barsMeta = { entry: {}, htf: {} };

  for (const type of typeOrder) {
    const tfs = TYPE_TF[type];
    const entryLoad = await loadCandles(tfs.entry, cfg);
    const htfLoad = await loadCandles(tfs.trend, cfg);
    entryCandles[type] = entryLoad.candles;
    htfCandles[type] = htfLoad.candles;
    barsMeta.entry[type] = entryLoad.candles.length;
    barsMeta.htf[type] = htfLoad.candles.length;

    if (!entryLoad.candles.length) {
      throw new Error(`No ${tfs.entry} candles for ${type} (${cfg.source})`);
    }
  }

  const { STRATEGIES } = require("#config/strategyDefaults.js");
  const wyDefaults = STRATEGIES.WYCKOFF || {};
  const config = applyStrategyJobDefaults("WYCKOFF", {
    activeTypes: typeOrder,
    entryModel: cfg.entryModel,
    allowHtfSideways: wyDefaults.allowHtfSideways,
    sidewaysShortOnly: wyDefaults.sidewaysShortOnly,
    allowHtfSidewaysLong: wyDefaults.allowHtfSidewaysLong,
    requireHtfAlign: wyDefaults.requireHtfAlign !== false,
    volumeConfirmMult: wyDefaults.volumeConfirmMult,
    longVolumeConfirmMult: wyDefaults.longVolumeConfirmMult,
    shortVolumeConfirmMult: wyDefaults.shortVolumeConfirmMult,
    cooldownBars: wyDefaults.cooldownBars,
    atrMinMult: wyDefaults.atrMinMult,
    riskPerTrade: wyDefaults.riskPerTrade ?? 0.008,
    typeRiskWeights: wyDefaults.typeRiskWeights,
    riskSizingBasis: wyDefaults.riskSizingBasis,
    maxDailyLossPct: wyDefaults.maxDailyLossPct,
    maxTradesPerDay: wyDefaults.maxTradesPerDay,
    typeOverrides: wyDefaults.typeOverrides,
    wyckoff: {
      entryModel: cfg.entryModel,
      allowHtfSideways: wyDefaults.allowHtfSideways,
      sidewaysShortOnly: wyDefaults.sidewaysShortOnly,
      allowHtfSidewaysLong: wyDefaults.allowHtfSidewaysLong,
      requireHtfAlign: wyDefaults.requireHtfAlign !== false,
      volumeConfirmMult: wyDefaults.volumeConfirmMult,
      longVolumeConfirmMult: wyDefaults.longVolumeConfirmMult,
      shortVolumeConfirmMult: wyDefaults.shortVolumeConfirmMult,
      cooldownBars: wyDefaults.cooldownBars,
    },
  });
  config.entryModel = cfg.entryModel;
  config.afActiveRacers = ["WYCKOFF"];
  config.selectedComponents = ["WYCKOFF"];
  if (wyDefaults.typeOverrides) config.typeOverrides = wyDefaults.typeOverrides;
  if (wyDefaults.atrMinMult != null) config.atrMinMult = wyDefaults.atrMinMult;
  if (wyDefaults.allowHtfSideways != null) config.allowHtfSideways = wyDefaults.allowHtfSideways;
  if (wyDefaults.sidewaysShortOnly != null) config.sidewaysShortOnly = wyDefaults.sidewaysShortOnly;
  if (wyDefaults.allowHtfSidewaysLong != null) config.allowHtfSidewaysLong = wyDefaults.allowHtfSidewaysLong;
  if (wyDefaults.riskPerTrade != null) config.riskPerTrade = wyDefaults.riskPerTrade;
  if (wyDefaults.typeRiskWeights) config.typeRiskWeights = wyDefaults.typeRiskWeights;
  if (wyDefaults.riskSizingBasis != null) config.riskSizingBasis = wyDefaults.riskSizingBasis;
  if (wyDefaults.maxDailyLossPct != null) config.maxDailyLossPct = wyDefaults.maxDailyLossPct;
  if (wyDefaults.maxTradesPerDay != null) config.maxTradesPerDay = wyDefaults.maxTradesPerDay;
  if (wyDefaults.longVolumeConfirmMult != null) config.longVolumeConfirmMult = wyDefaults.longVolumeConfirmMult;
  if (wyDefaults.shortVolumeConfirmMult != null) config.shortVolumeConfirmMult = wyDefaults.shortVolumeConfirmMult;

  const result = await runTripleTypeBacktest({
    strategyKey: "WYCKOFF",
    capital: cfg.capital,
    enableFees: cfg.enableFees,
    enableSlippage: false,
    typeOrder,
    entryCandles,
    htfCandles,
    dailyCandles: [],
    config,
    symbol: cfg.symbol,
    dataSource: cfg.source,
    exchangeType: cfg.exchange,
  });

  const loadMeta = {
    source: cfg.source,
    bars: {
      entry: Object.values(barsMeta.entry).reduce((a, b) => a + b, 0),
      htf: Object.values(barsMeta.htf).reduce((a, b) => a + b, 0),
      perType: barsMeta,
    },
  };

  return { result, loadMeta };
}

// ── Tests ────────────────────────────────────────────────────────────────────

// ── Tests (skipped when loaded as a library by the CLI script) ───────────────

if (!process.env.WYCKOFF_BT_CLI) {
describe("Wyckoff customizable backtest report", () => {
  test(`runs ${CFG.months}m ${CFG.source} backtest and prints PnL / win rate`, async (t) => {
    // Node 24 `node --test` does not forward CLI args after `--` into
    // process.argv — custom runs must use scripts/wyckoff-backtest-report.js
    // (or WYCKOFF_BT_* env). Warn when this harness is stuck on defaults.
    if (typeof process.env.NODE_TEST_CONTEXT === "string" || process.execArgv.includes("--test")) {
      const argvHasTypes = process.argv.includes("--types");
      if (!argvHasTypes && !process.env.WYCKOFF_BT_TYPES) {
        console.warn(
          "[wyckoff-report] note: under `node --test`, --flags are ignored on Node 24."
          + " Use: node scripts/wyckoff-backtest-report.js --types Scalping,Intraday,Swing ...",
        );
      }
    }

    console.log(
      `\n[wyckoff-report] starting  source=${CFG.source}  months=${CFG.months}`
      + `  symbol=${CFG.symbol}  types=${CFG.types.join(",")}  model=${CFG.entryModel}`,
    );

    let packed;
    try {
      packed = await runWyckoffCustomBacktest(CFG);
    } catch (err) {
      if (CFG.source === "real") {
        console.error(`\n[wyckoff-report] REAL fetch/backtest failed: ${err.message}`);
        console.error("  Tip: check network, or fall back to mock:");
        console.error("       npm run test:wyckoff:report");
        if (typeof t.skip === "function") {
          t.skip(`real data unavailable: ${err.message}`);
          return;
        }
        console.warn(`[wyckoff-report] skipping hard fail (real unavailable)`);
        return;
      }
      throw err;
    }

    const { result, loadMeta } = packed;
    const report = printReport(CFG, result, loadMeta);
    const saved = savePositionReports(CFG, result, loadMeta, report);

    console.log(`[wyckoff-report] saved single report (${saved.tradeCount} positions)`);
    console.log(`[wyckoff-report] file: ${saved.outFile}`);

    // Hard contracts: engine shape + numeric stats fields present
    assert.ok(result && typeof result === "object");
    assert.ok(Array.isArray(result.trades));
    assert.ok(result.stats && typeof result.stats === "object");
    assert.equal(typeof result.stats.totalTrades, "number");
    assert.ok(result.stats.winRate != null, "winRate missing");
    assert.ok(result.stats.totalReturn != null, "totalReturn missing");
    assert.ok(result.stats.profitFactor != null, "profitFactor missing");
    assert.ok(result.stats.maxDrawdown != null, "maxDrawdown missing");
    assert.ok(Number.isFinite(report.extra.totalPnl), "totalPnl not finite");

    // Single combined report file must exist
    assert.ok(fs.existsSync(saved.outFile), `report missing: ${saved.outFile}`);
    const reportBody = fs.readFileSync(saved.outFile, "utf8");
    assert.ok(reportBody.includes("SUMMARY"), "report missing SUMMARY section");
    assert.ok(reportBody.includes("POSITION INDEX"), "report missing POSITION INDEX");
    assert.ok(reportBody.includes("POSITION DETAILS"), "report missing POSITION DETAILS");
    assert.ok(reportBody.includes("END OF REPORT"), "report missing END OF REPORT");

    console.log(
      `[wyckoff-report] summary  trades=${result.stats.totalTrades}`
      + `  WR=${result.stats.winRate}%`
      + `  PnL=${money(report.extra.totalPnl)}`
      + `  return=${result.stats.totalReturn}%`
      + `  PF=${result.stats.profitFactor}`
      + `  MDD=${result.stats.maxDrawdown}%`,
    );
  });
});
}

// Export helpers for optional programmatic use / future scripts
module.exports = {
  parseCfg,
  runWyckoffCustomBacktest,
  printReport,
  computeExtraStats,
  savePositionReports,
  formatPositionBlock,
  genMock,
};
