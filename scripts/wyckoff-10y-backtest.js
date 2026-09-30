#!/usr/bin/env node
/**
 * Long-history Wyckoff backtest runner.
 *
 * Downloads Binance Vision spot BTCUSDT archives, then replays the real
 * server-side Wyckoff engine one trade leg at a time:
 *   Scalping  5m / 1h
 *   Intraday  15m / 1h
 *   Swing     4h / 1w (1w aggregated from daily candles)
 *
 * The production fetcher intentionally caps short-TF jobs to protect the API.
 * This research runner is deliberately separate and stores raw archives plus
 * parsed caches under backtest-reports/ (already git-ignored in this project).
 *
 * Important data caveat: Binance BTCUSDT spot history starts in Aug 2017.
 * The requested 10-year calendar window therefore has an honest pre-listing
 * gap instead of synthetic candles. Short signals are simulated on spot data;
 * this is not a 10-year perpetual-futures backtest.
 */

"use strict";

process.env.WYCKOFF_BT_CLI = "1";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
  runTripleTypeBacktest,
  _computeTripleStats,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");
const {
  applyStrategyJobDefaults,
} = require("../src/modules/backtest/services/runBacktestJob");
const { STRATEGIES } = require("../src/config/strategyDefaults");

const ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.join(ROOT, "backtest-reports", "wyckoff-10y-data");
const RAW_ROOT = path.join(DATA_ROOT, "raw");
const PARSED_ROOT = path.join(DATA_ROOT, "parsed");
const REPORT_ROOT = path.join(ROOT, "backtest-reports", "wyckoff");

const TF_CONFIG = Object.freeze({
  "5m": { minutes: 5 },
  "15m": { minutes: 15 },
  "1h": { minutes: 60 },
  "4h": { minutes: 240 },
  "1d": { minutes: 1440 },
});

const TYPE_TF = Object.freeze({
  Scalping: { entry: "5m", trend: "1h" },
  Intraday: { entry: "15m", trend: "1h" },
  Swing: { entry: "4h", trend: "1w" },
});

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] != null && !String(argv[i + 1]).startsWith("--")) {
    return argv[i + 1];
  }
  return fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const today = new Date();
  const endDefault = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
  ));
  const endText = String(argValue(argv, "--end", process.env.WYCKOFF_10Y_END || ""));
  const endExclusive = endText
    ? new Date(`${endText.slice(0, 10)}T00:00:00.000Z`)
    : endDefault;
  if (!Number.isFinite(endExclusive.getTime())) throw new Error(`Invalid --end: ${endText}`);

  const startText = String(argValue(argv, "--start", process.env.WYCKOFF_10Y_START || ""));
  const start = startText
    ? new Date(`${startText.slice(0, 10)}T00:00:00.000Z`)
    : new Date(Date.UTC(
      endExclusive.getUTCFullYear() - 10,
      endExclusive.getUTCMonth(),
      endExclusive.getUTCDate(),
    ));
  if (!Number.isFinite(start.getTime())) throw new Error(`Invalid --start: ${startText}`);

  const rawTypes = String(argValue(
    argv,
    "--types",
    process.env.WYCKOFF_10Y_TYPES || "Scalping,Intraday,Swing",
  ));
  const types = rawTypes.split(",").map((s) => s.trim()).filter((s) => TYPE_TF[s]);
  if (!types.length) throw new Error("No valid types. Use Scalping,Intraday,Swing.");

  const capital = Number(argValue(argv, "--capital", process.env.WYCKOFF_10Y_CAPITAL || "1000"));
  if (!(capital > 0)) throw new Error("--capital must be > 0");

  const refresh = ["--refresh", "--download"].some((f) => argv.includes(f));
  const downloadOnly = argv.includes("--download-only");
  const slippage = String(argValue(argv, "--slippage", process.env.WYCKOFF_10Y_SLIPPAGE || "1"));

  return {
    symbol: String(argValue(argv, "--symbol", "BTCUSDT")).toUpperCase(),
    start,
    endExclusive,
    types,
    capital,
    enableFees: String(argValue(argv, "--fees", "1")) !== "0",
    enableSlippage: slippage === "1" || slippage.toLowerCase() === "true",
    refresh,
    downloadOnly,
  };
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthCursor(startMs, endMs) {
  const out = [];
  const start = new Date(startMs);
  const end = new Date(endMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const ey = end.getUTCFullYear();
  const em = end.getUTCMonth();
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return out;
}

function dayCursor(startMs, endMs) {
  const out = [];
  for (let t = startMs; t < endMs; t += 86_400_000) out.push(isoDate(t));
  return out;
}

function ensureDirs() {
  for (const dir of [DATA_ROOT, RAW_ROOT, PARSED_ROOT, REPORT_ROOT]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function rawFile(tf, kind, label) {
  const dir = path.join(RAW_ROOT, tf, kind);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${tf}-${label}.zip`);
}

async function fetchArchive(tf, kind, label, symbol, refresh) {
  const outFile = rawFile(tf, kind, label);
  if (!refresh && fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
    return { status: "cached", tf, kind, label, file: outFile };
  }

  const url = `https://data.binance.vision/data/spot/${kind}/klines/${symbol}/${tf}/${symbol}-${tf}-${label}.zip`;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.status === 404) return { status: "missing", tf, kind, label, url };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length <= 100) throw new Error(`empty archive (${buffer.length} bytes)`);
      fs.writeFileSync(outFile, buffer);
      return { status: "downloaded", tf, kind, label, bytes: buffer.length, file: outFile };
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 800));
    }
  }
  throw new Error(`Failed ${url}: ${lastError?.message || lastError}`);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function downloadData(cfg) {
  const monthly = monthCursor(cfg.start.getTime(), cfg.endExclusive.getTime() - 1);
  const currentMonth = `${cfg.endExclusive.getUTCFullYear()}-${String(cfg.endExclusive.getUTCMonth() + 1).padStart(2, "0")}`;
  const completeMonths = monthly.filter((m) => m !== currentMonth);
  const currentDays = dayCursor(
    Date.UTC(cfg.endExclusive.getUTCFullYear(), cfg.endExclusive.getUTCMonth(), 1),
    cfg.endExclusive.getTime(),
  );
  const tasks = [];
  for (const tf of Object.keys(TF_CONFIG)) {
    for (const label of completeMonths) tasks.push({ tf, kind: "monthly", label });
    for (const label of currentDays) tasks.push({ tf, kind: "daily", label });
  }

  console.log(`[wyckoff-10y] archives: ${tasks.length} requested (${completeMonths.length} monthly + ${currentDays.length} daily per TF)`);
  let done = 0;
  let downloaded = 0;
  let cached = 0;
  let missing = 0;
  await mapLimit(tasks, 8, async (task) => {
    const result = await fetchArchive(task.tf, task.kind, task.label, cfg.symbol, cfg.refresh);
    done += 1;
    if (result.status === "downloaded") downloaded += 1;
    if (result.status === "cached") cached += 1;
    if (result.status === "missing") missing += 1;
    if (done % 20 === 0 || done === tasks.length) {
      console.log(`[wyckoff-10y] download ${done}/${tasks.length} · new=${downloaded} cached=${cached} missing=${missing}`);
    }
  });
  console.log(`[wyckoff-10y] archive download complete · new=${downloaded} cached=${cached} missing=${missing}`);
}

function normalizeTimestamp(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  // Binance Vision changed recent archives from milliseconds to microseconds.
  return n > 100_000_000_000_000 ? Math.floor(n / 1000) : n;
}

function parseCandleLine(line, startMs, endMs) {
  const fields = line.trim().split(",");
  if (fields.length < 6) return null;
  const timestamp = normalizeTimestamp(fields[0]);
  if (timestamp == null || timestamp < startMs || timestamp >= endMs) return null;
  const values = fields.slice(1, 6).map(Number);
  if (!values.every(Number.isFinite)) return null;
  return {
    timestamp,
    open: values[0],
    high: values[1],
    low: values[2],
    close: values[3],
    volume: values[4],
  };
}

async function parseZipFile(file, startMs, endMs, out) {
  await new Promise((resolve, reject) => {
    const child = spawn("unzip", ["-p", file], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const rl = require("readline").createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const candle = parseCandleLine(line, startMs, endMs);
      if (candle) out.push(candle);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`unzip failed (${code}): ${stderr.trim()}`));
    });
  });
}

function parsedFile(tf, cfg) {
  return path.join(
    PARSED_ROOT,
    `${cfg.symbol}_${tf}_${isoDate(cfg.start.getTime())}_${isoDate(cfg.endExclusive.getTime() - 1)}.json`,
  );
}

async function loadTf(tf, cfg) {
  const outFile = parsedFile(tf, cfg);
  if (!cfg.refresh && fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
    const data = JSON.parse(fs.readFileSync(outFile, "utf8"));
    console.log(`[wyckoff-10y] parsed cache ${tf}: ${data.length.toLocaleString()} bars`);
    return data;
  }

  const files = [];
  for (const kind of ["monthly", "daily"]) {
    const dir = path.join(RAW_ROOT, tf, kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".zip")).sort()) {
      files.push(path.join(dir, name));
    }
  }
  if (!files.length) throw new Error(`No raw archives found for ${tf}`);

  const candles = [];
  for (let i = 0; i < files.length; i += 1) {
    await parseZipFile(files[i], cfg.start.getTime(), cfg.endExclusive.getTime(), candles);
    if ((i + 1) % 20 === 0 || i + 1 === files.length) {
      console.log(`[wyckoff-10y] parse ${tf}: ${i + 1}/${files.length} archives · ${candles.length.toLocaleString()} bars`);
    }
  }

  candles.sort((a, b) => a.timestamp - b.timestamp);
  const deduped = [];
  let previous = null;
  for (const candle of candles) {
    if (candle.timestamp === previous) {
      deduped[deduped.length - 1] = candle;
    } else {
      deduped.push(candle);
      previous = candle.timestamp;
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(deduped), "utf8");
  console.log(`[wyckoff-10y] parsed ${tf}: ${deduped.length.toLocaleString()} bars → ${outFile}`);
  return deduped;
}

function mondayUtc(ms) {
  const date = new Date(ms);
  const day = date.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
}

function aggregateWeekly(daily) {
  const weeks = new Map();
  for (const candle of daily) {
    const key = mondayUtc(candle.timestamp);
    const existing = weeks.get(key);
    if (!existing) {
      weeks.set(key, {
        timestamp: key,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      });
    } else {
      existing.high = Math.max(existing.high, candle.high);
      existing.low = Math.min(existing.low, candle.low);
      existing.close = candle.close;
      existing.volume += candle.volume || 0;
    }
  }
  return [...weeks.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function buildWyckoffConfig(typeOrder) {
  const defaults = STRATEGIES.WYCKOFF || {};
  const config = applyStrategyJobDefaults("WYCKOFF", {
    activeTypes: typeOrder,
    entryModel: "balanced",
    allowHtfSideways: defaults.allowHtfSideways,
    sidewaysShortOnly: defaults.sidewaysShortOnly,
    allowHtfSidewaysLong: defaults.allowHtfSidewaysLong,
    requireHtfAlign: defaults.requireHtfAlign !== false,
    volumeConfirmMult: defaults.volumeConfirmMult,
    longVolumeConfirmMult: defaults.longVolumeConfirmMult,
    shortVolumeConfirmMult: defaults.shortVolumeConfirmMult,
    cooldownBars: defaults.cooldownBars,
    atrMinMult: defaults.atrMinMult,
    riskPerTrade: defaults.riskPerTrade ?? 0.008,
    typeRiskWeights: defaults.typeRiskWeights,
    riskSizingBasis: defaults.riskSizingBasis,
    maxDailyLossPct: defaults.maxDailyLossPct,
    maxTradesPerDay: defaults.maxTradesPerDay,
    typeOverrides: defaults.typeOverrides,
    wyckoff: {
      entryModel: "balanced",
      allowHtfSideways: defaults.allowHtfSideways,
      sidewaysShortOnly: defaults.sidewaysShortOnly,
      allowHtfSidewaysLong: defaults.allowHtfSidewaysLong,
      requireHtfAlign: defaults.requireHtfAlign !== false,
      volumeConfirmMult: defaults.volumeConfirmMult,
      longVolumeConfirmMult: defaults.longVolumeConfirmMult,
      shortVolumeConfirmMult: defaults.shortVolumeConfirmMult,
      cooldownBars: defaults.cooldownBars,
    },
  });
  config.entryModel = "balanced";
  config.afActiveRacers = ["WYCKOFF"];
  config.selectedComponents = ["WYCKOFF"];
  return config;
}

function progressLogger(type) {
  let last = -1;
  return (pct, bar, total) => {
    if (pct !== last && (pct % 10 === 0 || pct === 99)) {
      last = pct;
      console.log(`[wyckoff-10y] ${type} engine ${pct}% (${bar.toLocaleString()}/${total.toLocaleString()})`);
    }
  };
}

function extraMetrics(trades, startCapital, startMs, endMs) {
  const list = [...(trades || [])].sort((a, b) => new Date(a.closeTime || a.date) - new Date(b.closeTime || b.date));
  const pnl = list.reduce((sum, t) => sum + Number(t.pnl || 0), 0);
  const fees = list.reduce((sum, t) => sum + Number(t.fee || 0), 0);
  const funding = list.reduce((sum, t) => sum + Number(t.funding || 0), 0);
  const wins = list.filter((t) => Number(t.pnl || 0) > 0);
  const losses = list.filter((t) => Number(t.pnl || 0) <= 0);
  const finalCapital = startCapital + pnl;
  const years = Math.max((endMs - startMs) / (365.25 * 86_400_000), 1 / 365.25);
  const cagr = finalCapital > 0 ? (finalCapital / startCapital) ** (1 / years) - 1 : null;

  let equity = startCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let losingStreak = 0;
  let winningStreak = 0;
  let maxLosingStreak = 0;
  let maxWinningStreak = 0;
  for (const trade of list) {
    const value = Number(trade.pnl || 0);
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
    if (value > 0) { winningStreak += 1; losingStreak = 0; }
    else { losingStreak += 1; winningStreak = 0; }
    maxWinningStreak = Math.max(maxWinningStreak, winningStreak);
    maxLosingStreak = Math.max(maxLosingStreak, losingStreak);
  }

  const holds = list.map((t) => {
    if (Number.isFinite(Number(t.holdHours))) return Number(t.holdHours);
    const a = Date.parse(t.openTime);
    const b = Date.parse(t.closeTime || t.date);
    return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 3_600_000 : null;
  }).filter((v) => Number.isFinite(v));

  const byYear = {};
  for (const t of list) {
    const year = String(new Date(t.closeTime || t.date).getUTCFullYear());
    if (!byYear[year]) byYear[year] = { trades: 0, wins: 0, pnl: 0 };
    byYear[year].trades += 1;
    if (Number(t.pnl || 0) > 0) byYear[year].wins += 1;
    byYear[year].pnl += Number(t.pnl || 0);
  }
  for (const v of Object.values(byYear)) {
    v.winRate = v.trades ? +(v.wins / v.trades * 100).toFixed(1) : 0;
    v.pnl = +v.pnl.toFixed(2);
  }

  return {
    trades: list.length,
    wins: wins.length,
    losses: losses.length,
    winRate: list.length ? +(wins.length / list.length * 100).toFixed(2) : 0,
    grossProfit: +wins.reduce((s, t) => s + Number(t.pnl || 0), 0).toFixed(2),
    grossLoss: +Math.abs(losses.reduce((s, t) => s + Number(t.pnl || 0), 0)).toFixed(2),
    pnl: +pnl.toFixed(2),
    fees: +fees.toFixed(2),
    funding: +funding.toFixed(2),
    finalCapital: +finalCapital.toFixed(2),
    expectancyPerTrade: list.length ? +(pnl / list.length).toFixed(4) : 0,
    cagrPct: cagr == null ? null : +(cagr * 100).toFixed(2),
    maxDrawdownPct: +(maxDrawdown * 100).toFixed(2),
    maxWinningStreak,
    maxLosingStreak,
    averageHoldHours: holds.length ? +(holds.reduce((s, v) => s + v, 0) / holds.length).toFixed(2) : null,
    longTrades: list.filter((t) => String(t.side).toUpperCase() === "LONG").length,
    shortTrades: list.filter((t) => String(t.side).toUpperCase() === "SHORT").length,
    byYear,
  };
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function bootstrapRisk(trades, startCapital, iterations = 1000) {
  const returns = (trades || []).map((t) => Number(t.pnl || 0));
  if (returns.length < 2) return { iterations: 0, note: "insufficient closed trades" };
  let seed = 0x9e3779b9;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const finals = [];
  const drawdowns = [];
  let ruin = 0;
  for (let it = 0; it < iterations; it += 1) {
    let equity = startCapital;
    let peak = equity;
    let mdd = 0;
    for (let i = 0; i < returns.length; i += 1) {
      equity += returns[Math.floor(rand() * returns.length)];
      peak = Math.max(peak, equity);
      mdd = Math.max(mdd, peak > 0 ? (peak - equity) / peak : 0);
    }
    finals.push(equity);
    drawdowns.push(mdd * 100);
    if (equity <= 0) ruin += 1;
  }
  return {
    iterations,
    probabilityFinalPositivePct: +(finals.filter((v) => v > startCapital).length / iterations * 100).toFixed(1),
    probabilityRuinPct: +(ruin / iterations * 100).toFixed(1),
    finalCapitalP05: +percentile(finals, 0.05).toFixed(2),
    finalCapitalP50: +percentile(finals, 0.50).toFixed(2),
    finalCapitalP95: +percentile(finals, 0.95).toFixed(2),
    maxDrawdownP50Pct: +percentile(drawdowns, 0.50).toFixed(2),
    maxDrawdownP95Pct: +percentile(drawdowns, 0.95).toFixed(2),
  };
}

function formatMoney(value) {
  return `${value >= 0 ? "+" : ""}$${Number(value).toFixed(2)}`;
}

function formatReport(cfg, sourceMeta, results, aggregate) {
  const lines = [
    "WYCKOFF BTCUSDT LONG-HISTORY BACKTEST",
    "=".repeat(76),
    `Generated       : ${new Date().toISOString()}`,
    `Requested window: ${cfg.start.toISOString()} → ${cfg.endExclusive.toISOString()} (10-year calendar request)`,
    `Data source     : Binance Vision SPOT OHLCV`,
    `Coverage        : ${sourceMeta.firstDate} → ${sourceMeta.lastDate} (${sourceMeta.coverageYears} years)`,
    `Data gap        : ${sourceMeta.gapDays} days before first BTCUSDT listing data; no synthetic candles`,
    `Capital         : $${cfg.capital}`,
    `Fees            : ${cfg.enableFees ? "ON (Binance USDT-M schedule used by project)" : "OFF"}`,
    `Slippage        : ${cfg.enableSlippage ? "ON (project default 0.05% for market exits)" : "OFF"}`,
    `Timeframes      : Scalping 5m/1h · Intraday 15m/1h · Swing 4h/1w`,
    "",
    "AGGREGATE (sum of independent legs; sizing kept at project natural 3-leg risk ladder)",
    "-".repeat(76),
    `Trades          : ${aggregate.metrics.trades} (${aggregate.metrics.wins}W / ${aggregate.metrics.losses}L)`,
    `Win rate        : ${aggregate.metrics.winRate}%`,
    `PnL             : ${formatMoney(aggregate.metrics.pnl)} · final $${aggregate.metrics.finalCapital.toFixed(2)}`,
    `Profit factor   : ${aggregate.metrics.grossLoss > 0 ? (aggregate.metrics.grossProfit / aggregate.metrics.grossLoss).toFixed(2) : "n/a"}`,
    `Expectancy/trade: ${formatMoney(aggregate.metrics.expectancyPerTrade)}`,
    `Max drawdown    : ${aggregate.metrics.maxDrawdownPct}%`,
    `CAGR            : ${aggregate.metrics.cagrPct == null ? "n/a" : `${aggregate.metrics.cagrPct}%`}`,
    `Fees / funding  : $${aggregate.metrics.fees.toFixed(2)} / $${aggregate.metrics.funding.toFixed(2)}`,
    "",
  ];

  for (const type of cfg.types) {
    const item = results[type];
    if (!item) continue;
    const m = item.metrics;
    const s = item.engine.stats || {};
    lines.push(`${type.toUpperCase()} (${TYPE_TF[type].entry}/${TYPE_TF[type].trend})`);
    lines.push("-".repeat(76));
    lines.push(`Bars            : ${item.entryBars.toLocaleString()} entry / ${item.htfBars.toLocaleString()} HTF`);
    lines.push(`Trades          : ${m.trades} (${m.wins}W / ${m.losses}L)`);
    lines.push(`Win rate        : ${m.winRate}%`);
    lines.push(`PnL             : ${formatMoney(m.pnl)} · final $${m.finalCapital.toFixed(2)}`);
    lines.push(`Profit factor   : ${s.profitFactor ?? "n/a"} · expectancy ${formatMoney(m.expectancyPerTrade)}`);
    lines.push(`Max drawdown    : ${m.maxDrawdownPct}% · Sharpe (engine) ${s.sharpe ?? "n/a"}`);
    lines.push(`Avg hold        : ${m.averageHoldHours == null ? "n/a" : `${m.averageHoldHours}h`} · max losing streak ${m.maxLosingStreak}`);
    lines.push(`Long / short    : ${m.longTrades} / ${m.shortTrades}`);
    lines.push(`Fees / funding  : $${m.fees.toFixed(2)} / $${m.funding.toFixed(2)}`);
    lines.push(`Bootstrap 5–95% : final $${item.bootstrap.finalCapitalP05 ?? "n/a"}–$${item.bootstrap.finalCapitalP95 ?? "n/a"} · MDD P95 ${item.bootstrap.maxDrawdownP95Pct ?? "n/a"}%`);
    lines.push("Yearly net PnL  :");
    for (const [year, y] of Object.entries(m.byYear)) {
      lines.push(`  ${year}: ${formatMoney(y.pnl)} · ${y.trades} trades · WR ${y.winRate}%`);
    }
    lines.push("");
  }

  lines.push("INTERPRETATION / LIMITATIONS");
  lines.push("-".repeat(76));
  lines.push("- Source is Binance spot; SHORT trades are simulated and do not prove spot shortability.");
  lines.push("- Funding is disabled for spot-source data; project fee schedule is retained for fee sensitivity.");
  lines.push("- Results are historical simulations, not a guarantee of future returns or live fill quality.");
  lines.push("- Pre-listing period is excluded; use a multi-exchange stitched dataset for a literal 10-year BTC history.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function runOneType(type, cfg, candles, dailyCandles) {
  const tfs = TYPE_TF[type];
  const entry = candles[tfs.entry];
  const htf = type === "Swing" ? aggregateWeekly(dailyCandles) : candles[tfs.trend];
  if (!entry?.length || !htf?.length) throw new Error(`Missing candles for ${type}`);

  const config = buildWyckoffConfig([type]);
  // Spot OHLCV has no perpetual funding stream. Keep exchange fee schedule for
  // project parity but disable funding accrual in this spot-source research run.
  config.simulateFunding = false;
  const started = Date.now();
  console.log(`[wyckoff-10y] run ${type}: ${entry.length.toLocaleString()} entry bars, ${htf.length.toLocaleString()} HTF bars`);
  const engine = await runTripleTypeBacktest({
    strategyKey: "WYCKOFF",
    capital: cfg.capital,
    enableFees: cfg.enableFees,
    enableSlippage: cfg.enableSlippage,
    typeOrder: [type],
    naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
    entryCandles: { [type]: entry },
    htfCandles: { [type]: htf },
    dailyCandles,
    config,
    symbol: cfg.symbol,
    dataSource: "binance-vision-spot-10y",
    exchangeType: "binance",
    onProgress: progressLogger(type),
  });
  const metrics = extraMetrics(engine.trades, cfg.capital, cfg.start.getTime(), cfg.endExclusive.getTime());
  const bootstrap = bootstrapRisk(engine.trades, cfg.capital, 1000);
  console.log(`[wyckoff-10y] done ${type} in ${((Date.now() - started) / 1000).toFixed(1)}s · trades=${metrics.trades} pnl=${formatMoney(metrics.pnl)} mdd=${metrics.maxDrawdownPct}%`);
  return {
    type,
    entryBars: entry.length,
    htfBars: htf.length,
    engine,
    metrics,
    bootstrap,
  };
}

async function main() {
  const cfg = parseArgs();
  ensureDirs();
  console.log(`[wyckoff-10y] requested ${cfg.start.toISOString()} → ${cfg.endExclusive.toISOString()}`);
  await downloadData(cfg);
  if (cfg.downloadOnly) return;

  const needed = new Set(["1d"]);
  for (const type of cfg.types) {
    needed.add(TYPE_TF[type].entry);
    if (TYPE_TF[type].trend !== "1w") needed.add(TYPE_TF[type].trend);
  }
  const candles = {};
  for (const tf of needed) candles[tf] = await loadTf(tf, cfg);
  const dailyCandles = candles["1d"];
  const first = Math.min(...Object.values(candles).filter((a) => a.length).map((a) => a[0].timestamp));
  const last = Math.max(...Object.values(candles).filter((a) => a.length).map((a) => a[a.length - 1].timestamp));
  const sourceMeta = {
    firstDate: new Date(first).toISOString(),
    lastDate: new Date(last).toISOString(),
    coverageYears: +((last - first) / (365.25 * 86_400_000)).toFixed(2),
    gapDays: Math.max(0, Math.round((first - cfg.start.getTime()) / 86_400_000)),
  };

  const results = {};
  for (const type of cfg.types) results[type] = await runOneType(type, cfg, candles, dailyCandles);
  const allTrades = cfg.types.flatMap((type) => results[type].engine.trades || []);
  allTrades.sort((a, b) => new Date(a.closeTime || a.date) - new Date(b.closeTime || b.date));
  const aggregateEngineStats = _computeTripleStats(allTrades, cfg.capital).stats;
  const aggregateMetrics = extraMetrics(allTrades, cfg.capital, cfg.start.getTime(), cfg.endExclusive.getTime());
  const aggregate = {
    engineStats: aggregateEngineStats,
    metrics: aggregateMetrics,
    bootstrap: bootstrapRisk(allTrades, cfg.capital, 1000),
    trades: allTrades,
  };
  const report = formatReport(cfg, sourceMeta, results, aggregate);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(REPORT_ROOT, `${stamp}_BTCUSDT_10y_binance-spot_wyckoff`);
  const txtFile = `${base}.txt`;
  const jsonFile = `${base}.json`;
  fs.writeFileSync(txtFile, report, "utf8");
  fs.writeFileSync(jsonFile, JSON.stringify({
    config: {
      start: cfg.start.toISOString(),
      endExclusive: cfg.endExclusive.toISOString(),
      capital: cfg.capital,
      fees: cfg.enableFees,
      slippage: cfg.enableSlippage,
      source: "Binance Vision spot",
    },
    sourceMeta,
    aggregate: { engineStats: aggregate.engineStats, metrics: aggregate.metrics, bootstrap: aggregate.bootstrap },
    perType: Object.fromEntries(Object.entries(results).map(([type, item]) => [type, {
      entryBars: item.entryBars,
      htfBars: item.htfBars,
      engineStats: item.engine.stats,
      perTypeStats: item.engine.perTypeStats,
      metrics: item.metrics,
      bootstrap: item.bootstrap,
      trades: item.engine.trades,
    }])),
  }), "utf8");
  fs.writeFileSync(path.join(ROOT, "WYCKOFF_10Y_REPORT_LATEST.txt"), `${txtFile}\n`, "utf8");
  console.log(`\n${report}`);
  console.log(`[wyckoff-10y] report: ${txtFile}`);
  console.log(`[wyckoff-10y] json  : ${jsonFile}`);
}

main().catch((err) => {
  console.error(`[wyckoff-10y] failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
