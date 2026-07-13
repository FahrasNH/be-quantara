#!/usr/bin/env node
/**
 * smc-swing-dataset-expand.js — Sprint 13 Swing expand-dataset task
 *
 * Batch AF_SMC Swing backtests across multiple symbols × 12 months to grow
 * the ML / forensic CSV dataset (target 300+ trades). Walk-forward per window
 * is the caller's responsibility — this script dumps multi-symbol samples.
 *
 * Usage (from be-bot-trading/):
 *   node scripts/smc-swing-dataset-expand.js
 *   node scripts/smc-swing-dataset-expand.js --symbols BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT \
 *        --days 365 --source mock --out /tmp/smc-swing-dataset
 *
 *   # Real candles (needs DATABASE_URL + cached klines + --user):
 *   node scripts/smc-swing-dataset-expand.js --source db --user <userId> \
 *        --start 2025-07-13 --end 2026-07-13
 *
 * Writes:
 *   <out>/trades.csv          — combined trade CSV (ML columns included)
 *   <out>/stats.json          — per-symbol + aggregate summary
 *
 * Config: Swing typeOverrides from legacyStrategies (RR 2.5, maxHold 240h,
 * OB retest, funding guard) — same SSOT as staging backtest UI.
 * Optional --relax lowers confidence floor for research volume only.
 *
 * Rule (Notion): do not promote live rules until positive in ≥3/4 windows.
 */

"use strict";

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const { toCsv, TRADE_EXPORT_COLUMNS } = require("../src/domain/tradeExportCsv");
const { STRATEGIES } = require("../src/domain/legacyStrategies");

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
const OUT_DIR = get("--out", path.join(process.cwd(), "tmp", "smc-swing-dataset"));
const RELAX = has("--relax");

const TF_MIN = { "4h": 240, "1d": 1440, "1w": 10080 };

function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3500 : symbol.startsWith("SOL") ? 140 : 600;
  let price = seed;
  let time = Date.UTC(2025, 6, 13);
  const candles = [];
  let s = symbol.split("").reduce((a, c) => a + c.charCodeAt(0), 1234567);
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.floor((24 * 60) / intervalMin) || 1;
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];
    let drift, noiseAmp;
    switch (regime) {
      case "STRONG_UP": drift = price * 0.002; noiseAmp = 0.008; break;
      case "STRONG_DOWN": drift = -price * 0.002; noiseAmp = 0.008; break;
      case "VOLATILE_CHOP": drift = (rnd() - 0.5) * price * 0.006; noiseAmp = 0.02; break;
      default: drift = (rnd() - 0.45) * price * 0.0015; noiseAmp = 0.01;
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
  if (SOURCE === "mock") return genMock(symbol, DAYS, TF_MIN[tf] || 240);
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
  const base = { ...(STRATEGIES.AF_SMC || STRATEGIES.SMART_MONEY_CONCEPTS) };
  const swing = { ...(base.typeOverrides?.Swing || {}) };
  if (RELAX) {
    // Research-only denser sample — do NOT use for live promotion.
    swing.sacMinConfidenceC = 55;
    swing.smcFundingGuard = false;
  }
  return {
    ...base,
    strategyKey: "AF_SMC",
    typeOverrides: {
      ...(base.typeOverrides || {}),
      Swing: swing,
    },
    ...swing,
    sacMinConfidenceC: RELAX ? 55 : (base.sacMinConfidenceC ?? 65),
    activeComponents: ["Swing"],
  };
}

function mapTradeRow(t, symbol, idx) {
  return {
    id: `${symbol}-${idx + 1}`,
    sessionId: `EXPAND-SWING-${symbol}`,
    symbol,
    side: t.side,
    strategy: "AF_SMC",
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
    component: t.component || "Swing",
    tradeType: t.tradeType || "Swing",
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
    fundingRateAtEntry: t.fundingRateAtEntry,
    fundingForecast24h: t.fundingForecast24h,
    holdHours: t.holdHours,
    confSweepStrength: t.confSweepStrength,
    confFvgSize: t.confFvgSize,
    confDisplacementPct: t.confDisplacementPct,
    confHtfAlignment: t.confHtfAlignment,
    confMitigationDepth: t.confMitigationDepth,
    confObConfluence: t.confObConfluence,
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
  console.log(`\n══ ${symbol} (Swing 4h/1w) ══`);
  const entry = await loadCandles(symbol, "4h");
  const htf = await loadCandles(symbol, "1w");
  const daily = await loadCandles(symbol, "1d");
  console.log(`  candles entry=${entry.length} htf=${htf.length} daily=${daily.length}`);

  const result = await runTripleTypeBacktest({
    strategyKey: "AF_SMC",
    capital: CAPITAL,
    enableFees: true,
    enableSlippage: true,
    config: cfg,
    typeOrder: ["Swing"],
    naturalTypeOrder: ["Scalping", "Swing"],
    entryCandles: { Swing: entry },
    htfCandles: { Swing: htf },
    dailyCandles: daily,
    symbol,
  });

  const trades = result.trades || [];
  console.log(`  trades=${trades.length} WR=${result.stats?.winRate} PF=${result.stats?.profitFactor}`);
  if (result.meta?.costModel) {
    console.log(`  costModel: ${JSON.stringify(result.meta.costModel)}`);
  }
  return { symbol, trades, stats: result.stats, costModel: result.meta?.costModel };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const cfg = buildConfig();
  const allRows = [];
  const perSymbol = [];

  for (const symbol of SYMBOLS) {
    const { trades, stats, costModel } = await runSymbol(symbol, cfg);
    perSymbol.push({
      symbol,
      totalTrades: trades.length,
      wins: stats?.wins,
      losses: stats?.losses,
      winRate: stats?.winRate,
      profitFactor: stats?.profitFactor,
      totalReturn: stats?.totalReturn,
      costModel,
    });
    trades.forEach((t, i) => allRows.push(mapTradeRow(t, symbol, i)));
  }

  const csvPath = path.join(OUT_DIR, "trades.csv");
  const statsPath = path.join(OUT_DIR, "stats.json");
  fs.writeFileSync(csvPath, toCsv(allRows, TRADE_EXPORT_COLUMNS));
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
      strategy: "AF_SMC",
      entryTf: "4h",
      trendTf: "1w",
      period: "12m (or --days)",
      notes: [
        "Uses staging Swing typeOverrides (RR 2.5, maxHold 240h, OB retest, funding guard).",
        "Pass --relax for research-only denser samples (lower conf floor, funding guard off).",
        "Walk-forward: split by calendar year and require ≥3/4 windows profitable before live promotion.",
        "For real exchange data use --source db --user <id> --start/--end.",
        "swingMarketingBlocked=true until 2023 window revalidated after fast-fail fix.",
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
