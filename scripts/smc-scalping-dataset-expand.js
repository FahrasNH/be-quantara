#!/usr/bin/env node
/**
 * smc-scalping-dataset-expand.js — Sprint 13 task 4
 *
 * Batch SMART_MONEY_CONCEPTS Scalping backtests across multiple symbols × 12 months to grow
 * the ML / forensic CSV dataset (target 300+ trades).
 *
 * Usage (from be-bot-trading/):
 *   node scripts/smc-scalping-dataset-expand.js
 *   node scripts/smc-scalping-dataset-expand.js --symbols BTCUSDT,ETHUSDT,SOLUSDT \
 *        --days 365 --source mock --out /tmp/smc-scalp-dataset
 *
 *   # Real candles (needs DATABASE_URL + cached klines + --user):
 *   node scripts/smc-scalping-dataset-expand.js --source db --user <userId> \
 *        --start 2025-07-13 --end 2026-07-13
 *
 * Writes:
 *   <out>/trades.csv          — combined trade CSV (ML columns included)
 *   <out>/stats.json          — per-symbol + aggregate summary
 *
 * Config tweaks applied for denser-but-still-gated samples:
 *   - Scalping typeOverrides from legacyStrategies (RR 2.0, maxHold 6h, session,
 *     CHOP LONG block, OB retest) — same SSOT as staging backtest UI.
 *   - Optional --relax to lower confidence floors for research volume only.
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const { toCsv, TRADE_EXPORT_COLUMNS } = require("#shared/csv/tradeExportCsv.js");
const { SMC_ML_CSV_COLUMNS } = require("../src/core/strategy-engine/af/smcEntry");
const { STRATEGIES } = require("#config/strategyDefaults.js");

/** ML dataset CSV = CORE identity/PnL + SMC ML feature columns (not human report CSV). */
const ML_DATASET_COLUMNS = [
  ...TRADE_EXPORT_COLUMNS.filter(([k]) =>
    ["id", "symbol", "side", "strategy", "component", "entryPrice", "exitPrice", "pnl", "fee", "pnlNet", "result", "atr", "entryReasons", "openTime", "closeTime"].includes(k)
  ),
  ...SMC_ML_CSV_COLUMNS,
];

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const has = (flag) => args.includes(flag);

const SYMBOLS = get("--symbols", "BTCUSDT,ETHUSDT,SOLUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = parseInt(get("--days", "365"), 10);
const SOURCE = get("--source", "mock");
const CAPITAL = parseFloat(get("--capital", "10000"));
const OUT_DIR = get("--out", path.join(process.cwd(), "tmp", "smc-scalp-dataset"));
const RELAX = has("--relax");

const TF_MIN = { "15m": 15, "4h": 240, "1d": 1440 };

function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3500 : symbol.startsWith("SOL") ? 140 : 600;
  let price = seed;
  let time = Date.UTC(2025, 6, 13);
  const candles = [];
  let s = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 1234567);
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.floor((24 * 60) / intervalMin);
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];
    let drift, noiseAmp;
    switch (regime) {
      case "STRONG_UP": drift = price * 0.0012; noiseAmp = 0.004; break;
      case "STRONG_DOWN": drift = -price * 0.0012; noiseAmp = 0.004; break;
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
      open, high, low, close,
      volume: 1000 + rnd() * 2000,
    });
    price = close;
    time += intervalMin * 60 * 1000;
  }
  return candles;
}

async function loadCandles(symbol, tf) {
  if (SOURCE === "mock") return genMock(symbol, DAYS, TF_MIN[tf] || 15);
  const HistoricalKlinesService = require("../src/server/services/HistoricalKlinesService");
  const userId = get("--user", null);
  const start = get("--start", null);
  const end = get("--end", null);
  const res = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
    symbol,
    timeframe: tf,
    customStart: start,
    customEnd: end,
    days: DAYS,
  });
  return res.candles;
}

function buildConfig() {
  const base = { ...(STRATEGIES.ADAPTIVE_FUSION || STRATEGIES.SMART_MONEY_CONCEPTS) };
  const scalp = { ...(base.typeOverrides?.Scalping || {}) };
  if (RELAX) {
    // Research-only denser sample — do NOT use for live promotion.
    scalp.smcMinConfidenceALong = 70;
    scalp.smcMinConfidenceAShort = 65;
    scalp.smcSessionFilter = false;
  }
  return {
    ...base,
    strategyKey: "SMART_MONEY_CONCEPTS",
    typeOverrides: {
      ...(base.typeOverrides || {}),
      Scalping: scalp,
    },
    // Flatten Scalping knobs for detectors that read top-level flags
    ...scalp,
    activeComponents: ["Scalping"],
  };
}

function mapTradeRow(t, symbol, idx) {
  return {
    id: `${symbol}-${idx + 1}`,
    sessionId: `EXPAND-${symbol}`,
    symbol,
    side: t.side,
    strategy: "SMART_MONEY_CONCEPTS",
    status: "Closed",
    entryPrice: t.entry,
    exitPrice: t.exit,
    sl: t.sl,
    tp: t.tp,
    size: t.size,
    pnl: t.grossPnl ?? t.pnl,
    fee: t.fee,
    funding: t.funding ?? 0,
    pnlNet: t.pnl,
    pnlPct: t.pnlPct,
    plannedRR: t.plannedRR,
    actualRR: "",
    duration: "",
    reason: t.reason,
    exitReason: t.reason,
    entryReasons: t.entryReasons,
    confidence: t.confidence,
    marketCond: t.marketCond ?? "NORMAL",
    htfTrend: t.htfTrend,
    dailyRegime: t.dailyRegime ?? "UNKNOWN",
    component: t.component || "Scalping",
    tradeType: t.tradeType || "Scalping",
    atr: t.atr,
    entryRsi: t.entryRsi,
    sweepStrength: t.sweepStrength,
    fvgSizeAtr: t.fvgSizeAtr,
    obDistanceAtr: t.obDistanceAtr,
    displacementPct: t.displacementPct,
    htfAdx: t.htfAdx,
    hourUtc: t.hourUtc,
    volumeRatio: t.volumeRatio,
    bbWidth: t.bbWidth,
    confSweepStrength: t.confSweepStrength,
    confFvgSize: t.confFvgSize,
    confDisplacementPct: t.confDisplacementPct,
    confHtfAlignment: t.confHtfAlignment,
    dryRun: true,
    mode: "backtest",
    exchange: "binance",
    openTime: t.openTime,
    closeTime: t.closeTime || t.date,
    isPartial: false,
    result: t.result,
  };
}

async function runSymbol(symbol, cfg) {
  console.log(`\n══ ${symbol} ══`);
  const entry = await loadCandles(symbol, "15m");
  const htf = await loadCandles(symbol, "4h");
  const daily = await loadCandles(symbol, "1d");
  console.log(`  candles entry=${entry.length} htf=${htf.length} daily=${daily.length}`);

  const result = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: CAPITAL,
    enableFees: true,
    enableSlippage: true,
    config: cfg,
    typeOrder: ["Scalping"],
    naturalTypeOrder: ["Scalping", "Swing"],
    entryCandles: { Scalping: entry },
    htfCandles: { Scalping: htf },
    dailyCandles: daily,
    symbol,
  });

  const trades = result.trades || [];
  console.log(`  trades=${trades.length} WR=${result.stats?.winRate} PF=${result.stats?.profitFactor}`);
  return { symbol, trades, stats: result.stats };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cfg = buildConfig();
  const allRows = [];
  const perSymbol = [];

  for (const symbol of SYMBOLS) {
    const { trades, stats } = await runSymbol(symbol, cfg);
    perSymbol.push({
      symbol,
      totalTrades: trades.length,
      wins: stats?.wins,
      losses: stats?.losses,
      winRate: stats?.winRate,
      profitFactor: stats?.profitFactor,
      totalReturn: stats?.totalReturn,
    });
    trades.forEach((t, i) => allRows.push(mapTradeRow(t, symbol, i)));
  }

  const csvPath = path.join(OUT_DIR, "trades.csv");
  const statsPath = path.join(OUT_DIR, "stats.json");
  fs.writeFileSync(csvPath, toCsv(allRows, ML_DATASET_COLUMNS));
  const summary = {
    generatedAt: new Date().toISOString(),
    source: SOURCE,
    days: DAYS,
    symbols: SYMBOLS,
    relax: RELAX,
    totalTrades: allRows.length,
    targetMet: allRows.length >= 300,
    perSymbol,
    recipe: {
      strategy: "SMART_MONEY_CONCEPTS",
      entryTf: "15m",
      trendTf: "4h",
      period: "12m (or --days)",
      notes: [
        "Uses staging Scalping typeOverrides (RR 2.0, maxHold 6h, session 21-23 UTC, CHOP LONG block, OB retest).",
        "Pass --relax for research-only denser samples (lower conf floors, session off).",
        "For real exchange data use --source db --user <id> --start/--end.",
      ],
    },
  };
  fs.writeFileSync(statsPath, JSON.stringify(summary, null, 2));

  console.log("\n══ SUMMARY ══");
  console.log(`  Total trades: ${allRows.length} (target 300+ → ${summary.targetMet ? "YES" : "not yet — try --relax or more symbols"})`);
  console.log(`  CSV:   ${csvPath}`);
  console.log(`  Stats: ${statsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
