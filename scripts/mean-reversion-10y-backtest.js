#!/usr/bin/env node
/**
 * MEAN_REVERSION BTC long-history research runner.
 *
 * This runner deliberately uses the project's production backtest engine and
 * the cached Binance Vision spot candles.  It is a research report, not a
 * live-trading recommendation: spot candles are used as a proxy for short
 * trades and no funding stream is available in this data source.
 */

"use strict";

process.env.WYCKOFF_BT_CLI = "1";

const fs = require("fs");
const path = require("path");

const { runMultiTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService");
const { applyStrategyJobDefaults } = require("../src/modules/backtest/services/runBacktestJob");
const { resolveFeeSchedule } = require("../src/shared/constants/exchangeFeeSchedules");

const ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.join(ROOT, "backtest-reports", "wyckoff-10y-data", "parsed");
const REPORT_ROOT = path.join(ROOT, "backtest-reports", "mean-reversion");
const TYPES = ["Scalping", "Intraday", "Swing"];
const TF_BY_TYPE = {
  Scalping: { entry: "5m", trend: "1h" },
  Intraday: { entry: "15m", trend: "1h" },
  Swing: { entry: "4h", trend: "1w" },
};
const DAY_MS = 86_400_000;
const YEAR_DAYS = 365.25;

function argValue(argv, flag, fallback) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1] != null && !String(argv[i + 1]).startsWith("--")) {
    return argv[i + 1];
  }
  return fallback;
}

function parseDate(value, label) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid ${label}: ${value}`);
  return date;
}

function parseArgs(argv = process.argv.slice(2)) {
  const end = parseDate(argValue(argv, "--end", "2026-09-25"), "--end");
  const start = parseDate(argValue(argv, "--start", "2016-09-25"), "--start");
  const capital = Number(argValue(argv, "--capital", "1000"));
  const bootstrap = Number(argValue(argv, "--bootstrap", "2000"));
  if (!(capital > 0)) throw new Error("--capital must be > 0");
  if (!(bootstrap >= 0)) throw new Error("--bootstrap must be >= 0");
  if (end <= start) throw new Error("--end must be after --start");
  return {
    symbol: String(argValue(argv, "--symbol", "BTCUSDT")).toUpperCase(),
    start,
    endExclusive: end,
    capital,
    enableFees: String(argValue(argv, "--fees", "1")) !== "0",
    enableSlippage: String(argValue(argv, "--slippage", "1")) !== "0",
    dataDir: argValue(argv, "--data-dir", DATA_ROOT),
    bootstrapIterations: bootstrap,
  };
}

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sum(values) {
  return values.reduce((total, value) => total + number(value), 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(sum(values.map((value) => (value - avg) ** 2)) / (values.length - 1));
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function round(value, digits = 2) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function percent(value, digits = 2) {
  return round(number(value) * 100, digits);
}

function tradeTimestamp(trade, field = "closeTime") {
  const raw = trade?.[field] || trade?.date || trade?.openTime;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function loadParsed(tf, cfg) {
  const startLabel = isoDate(cfg.start.getTime());
  const endLabel = isoDate(cfg.endExclusive.getTime() - 1);
  const exact = path.join(cfg.dataDir, `${cfg.symbol}_${tf}_${startLabel}_${endLabel}.json`);
  let file = exact;

  if (!fs.existsSync(file)) {
    const prefix = `${cfg.symbol}_${tf}_`;
    const candidates = fs.readdirSync(cfg.dataDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => ({
        name,
        size: fs.statSync(path.join(cfg.dataDir, name)).size,
      }))
      .sort((a, b) => b.size - a.size);
    file = candidates.length ? path.join(cfg.dataDir, candidates[0].name) : null;
  }

  if (!file || !fs.existsSync(file)) {
    throw new Error(`Parsed ${tf} data not found in ${cfg.dataDir}`);
  }

  const candles = JSON.parse(fs.readFileSync(file, "utf8"));
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return { file, candles };
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

function buildDailyEquity(trades, startMs, endMs, startCapital) {
  const sorted = [...trades].sort((a, b) => (tradeTimestamp(a) || 0) - (tradeTimestamp(b) || 0));
  const equityByDay = new Map();
  let equity = startCapital;
  for (const trade of sorted) {
    equity += number(trade.pnl);
    const ts = tradeTimestamp(trade);
    if (ts != null) equityByDay.set(dayKey(ts), equity);
  }

  const series = [];
  let cursor = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  const endDay = Date.UTC(
    new Date(endMs).getUTCFullYear(),
    new Date(endMs).getUTCMonth(),
    new Date(endMs).getUTCDate(),
  );
  let prior = startCapital;
  while (cursor <= endDay) {
    const key = isoDate(cursor);
    if (equityByDay.has(key)) prior = equityByDay.get(key);
    series.push({ date: key, equity: prior });
    cursor += DAY_MS;
  }
  return series;
}

function maxDrawdown(equityValues) {
  let peak = equityValues[0] || 0;
  let max = 0;
  for (const value of equityValues) {
    peak = Math.max(peak, value);
    if (peak > 0) max = Math.max(max, (peak - value) / peak);
  }
  return max;
}

function streaks(trades) {
  let wins = 0;
  let losses = 0;
  let maxWins = 0;
  let maxLosses = 0;
  for (const trade of trades) {
    if (number(trade.pnl) > 0) {
      wins += 1;
      losses = 0;
      maxWins = Math.max(maxWins, wins);
    } else {
      losses += 1;
      wins = 0;
      maxLosses = Math.max(maxLosses, losses);
    }
  }
  return { maxWinningStreak: maxWins, maxLosingStreak: maxLosses };
}

function wilsonInterval(wins, total) {
  if (!total) return { lowPct: null, highPct: null };
  const z = 1.959963984540054;
  const p = wins / total;
  const denominator = 1 + (z ** 2 / total);
  const center = (p + (z ** 2 / (2 * total))) / denominator;
  const spread = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z ** 2 / (4 * total ** 2)));
  return {
    lowPct: round(Math.max(0, center - spread) * 100, 2),
    highPct: round(Math.min(1, center + spread) * 100, 2),
  };
}

function bootstrapRisk(accountReturns, startCapital, iterations) {
  if (accountReturns.length < 2 || iterations < 1) {
    return { iterations: 0, note: "insufficient closed trades or disabled" };
  }

  let seed = 0x9e3779b9;
  const random = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const finals = [];
  const drawdowns = [];
  let ruin = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let equity = startCapital;
    let peak = equity;
    let mdd = 0;
    for (let i = 0; i < accountReturns.length; i += 1) {
      equity *= 1 + accountReturns[Math.floor(random() * accountReturns.length)];
      peak = Math.max(peak, equity);
      mdd = Math.max(mdd, peak > 0 ? (peak - equity) / peak : 1);
    }
    finals.push(equity);
    drawdowns.push(mdd);
    if (equity <= 0) ruin += 1;
  }

  return {
    iterations,
    probabilityFinalPositivePct: round(finals.filter((value) => value > startCapital).length / iterations * 100, 1),
    probabilityRuinPct: round(ruin / iterations * 100, 1),
    finalCapitalP05: round(percentile(finals, 0.05)),
    finalCapitalP50: round(percentile(finals, 0.50)),
    finalCapitalP95: round(percentile(finals, 0.95)),
    maxDrawdownP50Pct: percent(percentile(drawdowns, 0.50)),
    maxDrawdownP95Pct: percent(percentile(drawdowns, 0.95)),
  };
}

function regimeBreakdown(trades) {
  const out = {};
  for (const trade of trades) {
    const regime = trade.dailyRegime || "UNKNOWN";
    if (!out[regime]) out[regime] = { trades: 0, wins: 0, pnl: 0 };
    out[regime].trades += 1;
    if (number(trade.pnl) > 0) out[regime].wins += 1;
    out[regime].pnl += number(trade.pnl);
  }
  for (const value of Object.values(out)) {
    value.pnl = round(value.pnl);
    value.winRatePct = round(value.wins / value.trades * 100, 2);
  }
  return out;
}

function yearlyBreakdown(trades) {
  const out = {};
  for (const trade of trades) {
    const ts = tradeTimestamp(trade);
    if (ts == null) continue;
    const year = String(new Date(ts).getUTCFullYear());
    if (!out[year]) out[year] = { trades: 0, wins: 0, pnl: 0 };
    out[year].trades += 1;
    if (number(trade.pnl) > 0) out[year].wins += 1;
    out[year].pnl += number(trade.pnl);
  }
  for (const value of Object.values(out)) {
    value.pnl = round(value.pnl);
    value.winRatePct = round(value.wins / value.trades * 100, 2);
  }
  return out;
}

function analyzeTrades(tradesIn, startCapital, periodStartMs, periodEndMs, bootstrapIterations) {
  const trades = [...tradesIn].sort((a, b) => (tradeTimestamp(a, "closeTime") || 0) - (tradeTimestamp(b, "closeTime") || 0));
  let equity = startCapital;
  const accountReturns = [];

  for (const trade of trades) {
    const pnl = number(trade.pnl);
    const before = equity;
    trade.accountReturn = before > 0 ? pnl / before : -1;
    accountReturns.push(trade.accountReturn);
    equity += pnl;
  }

  const wins = trades.filter((trade) => number(trade.pnl) > 0);
  const losses = trades.filter((trade) => number(trade.pnl) <= 0);
  const grossProfit = sum(wins.map((trade) => trade.pnl));
  const grossLoss = Math.abs(sum(losses.map((trade) => trade.pnl)));
  const grossPnl = sum(trades.map((trade) => trade.grossPnl ?? (number(trade.pnl) + number(trade.fee) + number(trade.funding))));
  const fees = sum(trades.map((trade) => trade.fee));
  const funding = sum(trades.map((trade) => trade.funding));
  const daily = buildDailyEquity(trades, periodStartMs, periodEndMs, startCapital);
  const dailyReturns = daily.slice(1).map((point, i) => {
    const prior = daily[i].equity;
    return prior > 0 ? point.equity / prior - 1 : -1;
  });
  const avgDaily = mean(dailyReturns);
  const dailyStd = stddev(dailyReturns);
  const downsideDeviation = Math.sqrt(mean(dailyReturns.map((value) => Math.min(0, value) ** 2)));
  const years = Math.max((periodEndMs - periodStartMs) / (YEAR_DAYS * DAY_MS), 1 / YEAR_DAYS);
  const cagr = equity > 0 ? (equity / startCapital) ** (1 / years) - 1 : -1;
  const mdd = maxDrawdown(daily.map((point) => point.equity));
  const q05 = percentile(accountReturns, 0.05);
  const tail = accountReturns.filter((value) => q05 != null && value <= q05);
  const holdHours = trades.map((trade) => {
    if (Number.isFinite(Number(trade.holdHours))) return Number(trade.holdHours);
    const open = tradeTimestamp(trade, "openTime");
    const close = tradeTimestamp(trade, "closeTime");
    return open != null && close != null ? (close - open) / 3_600_000 : null;
  }).filter((value) => Number.isFinite(value));
  const exposureHours = sum(holdHours);
  const ci = wilsonInterval(wins.length, trades.length);

  let peak = startCapital;
  let ulcerSum = 0;
  for (const point of daily) {
    peak = Math.max(peak, point.equity);
    const drawdown = peak > 0 ? (peak - point.equity) / peak : 1;
    ulcerSum += drawdown ** 2;
  }

  return {
    startCapital: round(startCapital),
    finalCapital: round(equity),
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: round(trades.length ? wins.length / trades.length * 100 : 0, 2),
    winRate95CiPct: ci,
    grossPnl: round(grossPnl),
    netPnl: round(equity - startCapital),
    totalFees: round(fees),
    totalFunding: round(funding),
    costDragPctOfGross: grossPnl ? round((grossPnl - (equity - startCapital)) / Math.abs(grossPnl) * 100, 2) : null,
    grossProfit: round(grossProfit),
    grossLoss: round(grossLoss),
    avgWin: round(wins.length ? grossProfit / wins.length : 0, 4),
    avgLoss: round(losses.length ? grossLoss / losses.length : 0, 4),
    expectancyPerTrade: round(trades.length ? (equity - startCapital) / trades.length : 0, 4),
    expectancyAccountPct: percent(mean(accountReturns), 4),
    profitFactor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : (grossProfit > 0 ? "Inf" : 0),
    cagrPct: percent(cagr, 2),
    maxDrawdownPct: percent(mdd, 2),
    recoveryFactor: mdd > 0 ? round((equity - startCapital) / (startCapital * mdd), 2) : null,
    sharpeDaily: dailyStd > 0 ? round(avgDaily / dailyStd * Math.sqrt(365), 2) : null,
    sortinoDaily: downsideDeviation > 0 ? round(avgDaily / downsideDeviation * Math.sqrt(365), 2) : null,
    calmar: mdd > 0 ? round(cagr / mdd, 2) : null,
    ulcerIndexPct: percent(Math.sqrt(ulcerSum / Math.max(daily.length, 1)), 2),
    var95TradePct: q05 == null ? null : round(Math.max(0, -q05 * 100), 2),
    cvar95TradePct: tail.length ? round(Math.max(0, -mean(tail) * 100), 2) : null,
    averageHoldHours: holdHours.length ? round(mean(holdHours), 2) : null,
    exposurePct: round(exposureHours / ((periodEndMs - periodStartMs) / 3_600_000) * 100, 2),
    longTrades: trades.filter((trade) => String(trade.side).toUpperCase() === "LONG").length,
    shortTrades: trades.filter((trade) => String(trade.side).toUpperCase() === "SHORT").length,
    ...streaks(trades),
    regimes: regimeBreakdown(trades),
    byYear: yearlyBreakdown(trades),
    bootstrap: bootstrapRisk(accountReturns, startCapital, bootstrapIterations),
  };
}

function compactTrade(trade) {
  return {
    openTime: trade.openTime,
    closeTime: trade.closeTime,
    side: trade.side,
    entry: trade.entry,
    exit: trade.exit,
    size: trade.size,
    grossPnl: trade.grossPnl,
    fee: trade.fee,
    funding: trade.funding,
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    result: trade.result,
    reason: trade.reason,
    holdHours: trade.holdHours,
    plannedRR: trade.plannedRR,
    dailyRegime: trade.dailyRegime,
    htfTrend: trade.htfTrend,
    tradeType: trade.tradeType,
  };
}

function money(value) {
  const n = number(value);
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function tableRow(values, widths) {
  return values.map((value, i) => String(value).padEnd(widths[i])).join(" | ");
}

function formatReport(cfg, loaded, result, sourceMeta, feeSchedule) {
  const lines = [];
  lines.push("BTCUSDT MEAN REVERSION — 10-YEAR BACKTEST");
  lines.push("=".repeat(132));
  lines.push(`Generated          : ${new Date().toISOString()}`);
  lines.push(`Requested window   : ${cfg.start.toISOString()} → ${cfg.endExclusive.toISOString()}`);
  lines.push(`Effective data     : ${sourceMeta.firstDate} → ${sourceMeta.lastDate} (${sourceMeta.coverageYears} years)`);
  lines.push(`Pre-listing gap    : ${sourceMeta.gapDays} days before BTCUSDT spot listing (no synthetic candles)`);
  lines.push("Data source        : Binance Vision SPOT OHLCV parsed cache");
  lines.push("Engine             : project RealStrategyBacktestService / runMultiTypeBacktest");
  lines.push("Racer isolation    : MEAN_REVERSION only (selectedComponents=[MEAN_REVERSION])");
  lines.push(`Initial capital    : $${cfg.capital.toFixed(2)} per isolated type account; Total row = ${TYPES.length} accounts`);
  lines.push(`Fees               : ${cfg.enableFees ? `${feeSchedule.label} taker ${(feeSchedule.takerFeeRate * 100).toFixed(4)}%/side` : "OFF"}`);
  lines.push(`Slippage           : ${cfg.enableSlippage ? "ON (project default)" : "OFF"}`);
  lines.push("Funding            : OFF (spot source; no perpetual funding stream)");
  lines.push("Signal / execution : signal evaluated on completed candle; project execution and risk gates retained");
  lines.push("Daily regime       : causal prior-day mapping inside the project engine");
  lines.push("Timeframes         : Scalping 5m/1h · Intraday 15m/1h · Swing 4h/1w");
  lines.push("");

  const widths = [12, 13, 9, 11, 13, 15, 14, 16, 9];
  lines.push("SUMMARY — ISOLATED ACCOUNTS");
  lines.push("-".repeat(132));
  lines.push(tableRow(["Type", "Timeframe", "Trades", "Win Rate", "Net Profit", "Final Capital", "Profit Factor", "Max Drawdown", "Sharpe"], widths));
  lines.push(tableRow(widths.map((width) => "-".repeat(Math.min(width, 12))), widths));
  for (const type of TYPES) {
    const m = result.perType[type].metrics;
    lines.push(tableRow([
      type,
      `${TF_BY_TYPE[type].entry} / ${TF_BY_TYPE[type].trend}`,
      m.totalTrades.toLocaleString("en-US"),
      `${m.winRatePct}%`,
      money(m.netPnl),
      `$${m.finalCapital.toFixed(2)}`,
      m.profitFactor,
      `${m.maxDrawdownPct}%`,
      m.sharpeDaily ?? "n/a",
    ], widths));
  }
  const aggregate = result.aggregate.metrics;
  lines.push(tableRow([
    "Total",
    "—",
    aggregate.totalTrades.toLocaleString("en-US"),
    `${aggregate.winRatePct}%`,
    money(aggregate.netPnl),
    `$${aggregate.finalCapital.toFixed(2)}`,
    aggregate.profitFactor,
    `${aggregate.maxDrawdownPct}%`,
    aggregate.sharpeDaily ?? "n/a",
  ], widths));
  lines.push("");

  for (const type of TYPES) {
    const item = result.perType[type];
    const m = item.metrics;
    lines.push(`${type.toUpperCase()} DETAIL (${TF_BY_TYPE[type].entry}/${TF_BY_TYPE[type].trend})`);
    lines.push("-".repeat(132));
    lines.push(`Bars              : ${item.entryBars.toLocaleString()} entry / ${item.htfBars.toLocaleString()} HTF`);
    lines.push(`Trades            : ${m.totalTrades} (${m.wins}W / ${m.losses}L) · long/short ${m.longTrades}/${m.shortTrades}`);
    lines.push(`Net / gross PnL    : ${money(m.netPnl)} / ${money(m.grossPnl)} · fees ${money(-m.totalFees)} · funding ${money(-m.totalFunding)}`);
    lines.push(`Expectancy         : ${money(m.expectancyPerTrade)} per trade · ${m.expectancyAccountPct}% of account`);
    lines.push(`PF / avg W:L       : ${m.profitFactor} · ${money(m.avgWin)} : -$${number(m.avgLoss).toFixed(4)}`);
    lines.push(`Win-rate 95% CI    : ${m.winRate95CiPct.lowPct ?? "n/a"}%–${m.winRate95CiPct.highPct ?? "n/a"}%`);
    lines.push(`Risk               : MDD ${m.maxDrawdownPct}% · recovery ${m.recoveryFactor ?? "n/a"} · ulcer ${m.ulcerIndexPct}%`);
    lines.push(`Risk-adjusted      : Sharpe ${m.sharpeDaily ?? "n/a"} · Sortino ${m.sortinoDaily ?? "n/a"} · Calmar ${m.calmar ?? "n/a"}`);
    lines.push(`Tail               : VaR95 ${m.var95TradePct ?? "n/a"}% · CVaR95 ${m.cvar95TradePct ?? "n/a"}% · max loss streak ${m.maxLosingStreak}`);
    lines.push(`Holding            : average ${m.averageHoldHours ?? "n/a"}h · exposure ${m.exposurePct}% · cost drag ${m.costDragPctOfGross ?? "n/a"}% of gross`);
    lines.push(`Bootstrap (${m.bootstrap.iterations || 0})    : final P05/P50/P95 $${m.bootstrap.finalCapitalP05 ?? "n/a"}/$${m.bootstrap.finalCapitalP50 ?? "n/a"}/$${m.bootstrap.finalCapitalP95 ?? "n/a"} · ruin ${m.bootstrap.probabilityRuinPct ?? "n/a"}% · MDD P95 ${m.bootstrap.maxDrawdownP95Pct ?? "n/a"}%`);
    lines.push("Yearly net PnL    :");
    for (const [year, value] of Object.entries(m.byYear)) {
      lines.push(`  ${year}: ${money(value.pnl)} · ${value.trades} trades · WR ${value.winRatePct}%`);
    }
    lines.push("");
  }

  lines.push("RESEARCH INTERPRETATION");
  lines.push("-".repeat(132));
  lines.push("- Hasil ini adalah backtest historis BTCUSDT spot pada satu venue; bukan bukti edge universal atau jaminan profit.");
  lines.push("- Short disimulasikan dari candle spot; borrow, margin, liquidation, dan funding perpetual tidak tersedia di sumber ini.");
  lines.push("- Fee dan slippage project aktif sehingga net profit sudah setelah biaya transaksi; spread, latency, dan fill nyata bisa lebih buruk.");
  lines.push("- Parameter yang dipakai adalah defaults MEAN_REVERSION project, bukan parameter yang dioptimalkan khusus untuk hasil 10 tahun ini.");
  lines.push("- Confidence penelitian tetap dibatasi oleh single-asset/single-venue; validasi walk-forward dan out-of-sample lintas aset belum dijalankan oleh runner ini.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function calculateScore(perType) {
  const values = Object.values(perType).map((item) => item.metrics);
  const positive = values.filter((metrics) => metrics.netPnl > 0).length;
  const robustSamples = values.filter((metrics) => metrics.totalTrades >= 100).length;
  const sensiblePf = values.filter((metrics) => number(metrics.profitFactor) >= 1.1).length;
  const controlledRisk = values.filter((metrics) => metrics.maxDrawdownPct <= 30).length;
  const score = Math.min(10, Math.max(0,
    2 + positive * 1.5 + robustSamples * 0.5 + sensiblePf * 0.5 + controlledRisk * 0.25,
  ));
  const confidence = robustSamples === 3 && positive === 3 ? "Medium" : "Low";
  return { score: round(score, 1), confidence };
}

async function main() {
  const cfg = parseArgs();
  fs.mkdirSync(REPORT_ROOT, { recursive: true });

  const loaded = {};
  for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
    loaded[tf] = loadParsed(tf, cfg);
    console.log(`[mean-reversion-10y] loaded ${tf}: ${loaded[tf].candles.length.toLocaleString()} bars`);
  }

  const first = Math.min(...Object.values(loaded).map((item) => item.candles[0].timestamp));
  const last = Math.max(...Object.values(loaded).map((item) => item.candles[item.candles.length - 1].timestamp));
  const sourceMeta = {
    firstDate: new Date(first).toISOString(),
    lastDate: new Date(last).toISOString(),
    coverageYears: round((last - first) / (YEAR_DAYS * DAY_MS), 2),
    gapDays: Math.max(0, Math.round((first - cfg.start.getTime()) / DAY_MS)),
  };

  const daily = loaded["1d"].candles;
  const entryCandles = {
    Scalping: loaded["5m"].candles,
    Intraday: loaded["15m"].candles,
    Swing: loaded["4h"].candles,
  };
  const htfCandles = {
    Scalping: loaded["1h"].candles,
    Intraday: loaded["1h"].candles,
    Swing: aggregateWeekly(daily),
  };

  const config = applyStrategyJobDefaults("MEAN_REVERSION", {
    selectedComponents: ["MEAN_REVERSION"],
    mdActiveRacers: ["MEAN_REVERSION"],
    mdActiveVoters: ["MEAN_REVERSION"],
    mdCombinationMode: "race",
    simulateFunding: false,
  });
  const feeSchedule = resolveFeeSchedule("binance");
  const progress = { Scalping: -1, Intraday: -1, Swing: -1 };
  const started = Date.now();

  console.log("[mean-reversion-10y] running real multi-TF engine…");
  const engine = await runMultiTypeBacktest({
    strategyKey: "MEAN_REVERSION",
    capital: cfg.capital,
    enableFees: cfg.enableFees,
    enableSlippage: cfg.enableSlippage,
    exchangeType: "binance",
    feeSchedule,
    entryCandles,
    htfCandles,
    dailyCandles: daily,
    config,
    naturalTypeOrder: TYPES,
    symbol: cfg.symbol,
    dataSource: "binance-vision-spot-cache",
    onProgress: (pct, _bar, _total, type) => {
      const key = type || "engine";
      const step = Math.floor(number(pct) / 10) * 10;
      if (type && step > (progress[key] ?? -1)) {
        progress[key] = step;
        console.log(`[mean-reversion-10y] ${type} engine ${step}%`);
      }
    },
  }, TYPES);

  const effectiveStart = Math.max(cfg.start.getTime(), first);
  const effectiveEnd = Math.min(cfg.endExclusive.getTime() - 1, last);
  const perType = {};
  for (const type of TYPES) {
    const trades = (engine.trades || []).filter((trade) => trade.tradeType === type || trade.component === type);
    perType[type] = {
      entryBars: entryCandles[type].length,
      htfBars: htfCandles[type].length,
      engineStats: engine.perTypeStats?.[type] || null,
      metrics: analyzeTrades(trades, cfg.capital, effectiveStart, effectiveEnd, cfg.bootstrapIterations),
      trades: trades.map(compactTrade),
    };
  }

  const allTrades = TYPES.flatMap((type) => perType[type].trades);
  const aggregateMetrics = analyzeTrades(
    allTrades,
    cfg.capital * TYPES.length,
    effectiveStart,
    effectiveEnd,
    cfg.bootstrapIterations,
  );
  const result = {
    config: {
      symbol: cfg.symbol,
      requestedStart: cfg.start.toISOString(),
      requestedEndExclusive: cfg.endExclusive.toISOString(),
      effectiveStart: new Date(effectiveStart).toISOString(),
      effectiveEnd: new Date(effectiveEnd).toISOString(),
      capitalPerType: cfg.capital,
      feeSchedule,
      fees: cfg.enableFees,
      slippage: cfg.enableSlippage,
      funding: false,
      strategyKey: "MEAN_REVERSION",
      racerIsolation: ["MEAN_REVERSION"],
      timeframes: TF_BY_TYPE,
      dataSource: "Binance Vision spot OHLCV parsed cache",
      parsedFiles: Object.fromEntries(Object.entries(loaded).map(([tf, item]) => [tf, item.file])),
    },
    sourceMeta,
    engineStats: engine.stats,
    score: calculateScore(perType),
    aggregate: { metrics: aggregateMetrics, trades: allTrades },
    perType,
    elapsedSeconds: round((Date.now() - started) / 1000, 1),
  };

  const report = formatReport(cfg, loaded, result, sourceMeta, feeSchedule);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(REPORT_ROOT, `${stamp}_${cfg.symbol}_10y_binance-spot_mean-reversion`);
  const txtFile = `${base}.txt`;
  const jsonFile = `${base}.json`;
  fs.writeFileSync(txtFile, report, "utf8");
  fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2), "utf8");
  fs.writeFileSync(path.join(ROOT, "MEAN_REVERSION_10Y_REPORT_LATEST.txt"), `${txtFile}\n`, "utf8");

  console.log(`\n${report}`);
  console.log(`[mean-reversion-10y] report: ${txtFile}`);
  console.log(`[mean-reversion-10y] json  : ${jsonFile}`);
}

main().catch((error) => {
  console.error(`[mean-reversion-10y] failed: ${error.stack || error}`);
  process.exitCode = 1;
});
