#!/usr/bin/env node
"use strict";

/**
 * Local TREND_FOLLOWING RSI ablation — runs runMultiTypeBacktest with mock candles
 * when exchange/via-api unavailable. Uses same 3 windows × tiers as compare-rsi-ablation.
 *
 * Usage: node scripts/walkforward/trend-following/local-rsi-ablation-engine.js
 */

const fs = require("fs");
const path = require("path");

const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_5 } = require("../lib/windows");
const { DEFAULT_SYMBOLS_5 } = require("../lib/symbols");
const { rsiVariantOutSuffix } = require("../lib/runWalkforwardMain");
const { resolveRsiVariant } = require("../../../src/core/strategy-engine/ts/trendFollowingEntry");
const { buildConfig } = require("../../dataset-expand/lib/runDatasetExpand");
const { naturalTypeOrder } = require("../../dataset-expand/lib/strategyRegistry");
const { runMultiTypeBacktest } = require("../../../src/modules/backtest/services/RealStrategyBacktestService");
const { TYPE_TF } = require("../../../src/modules/backtest/services/runBacktestJob");
const { resolveFeeSchedule } = require("../../../src/shared/constants/exchangeFeeSchedules");

const WINDOWS = GAP_POLICY_5.slice(0, 3);
const VARIANTS = ["a", "b", "c"];
const TIERS = ["Scalping", "Intraday", "Swing"];

const TF_MIN = { "5m": 5, "15m": 15, "4h": 240 };

function genMock(symbol, start, end, intervalMin, seed = 7) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end) + 86400000;
  const bars = Math.max(200, Math.floor((endMs - startMs) / (intervalMin * 60000)));
  const R = ["U", "N", "C", "D", "N"];
  const RL = Math.max(24, Math.floor(bars / 20));
  const out = [];
  let p = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3500 : 600;
  let t = startMs;
  let s = seed + symbol.length;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < bars; i++) {
    const r = R[Math.floor(i / RL) % R.length];
    let d, n;
    if (r === "U") { d = p * 0.0015; n = 0.004; }
    else if (r === "D") { d = -p * 0.0015; n = 0.004; }
    else if (r === "C") { d = (rnd() - 0.5) * p * 0.003; n = 0.014; }
    else { d = (rnd() - 0.45) * p * 0.0008; n = 0.005; }
    const no = (rnd() - 0.5) * p * n * 2;
    const o = p;
    const c = Math.max(p + d + no, 1);
    out.push({
      timestamp: t,
      open: o,
      high: Math.max(o, c) * (1 + rnd() * n),
      low: Math.min(o, c) * (1 - rnd() * n),
      close: c,
      volume: 1000 + rnd() * 4000,
    });
    p = c;
    t += intervalMin * 60000;
  }
  return out;
}

async function runCell(tradeType, variant, win, symbol) {
  const tfs = TYPE_TF[tradeType];
  const entryMin = TF_MIN[tfs.entry] || 15;
  const htfMin = TF_MIN[tfs.trend] || 60;
  const entry = genMock(symbol, win.start, win.end, entryMin, win.id * 10 + symbol.length);
  const htf = genMock(symbol, win.start, win.end, htfMin, win.id * 20 + symbol.length);
  const daily = genMock(symbol, win.start, win.end, 1440, win.id * 30 + symbol.length);

  const cfg = buildConfig("TREND_FOLLOWING", tradeType, false, variant);
  const feeSchedule = resolveFeeSchedule("binance");

  const result = await runMultiTypeBacktest({
    strategyKey: "TREND_FOLLOWING",
    capital: 1000,
    enableFees: true,
    enableSlippage: true,
    exchangeType: "binance",
    feeSchedule,
    config: cfg,
    typeOrder: [tradeType],
    naturalTypeOrder: naturalTypeOrder("TREND_FOLLOWING"),
    entryCandles: { [tradeType]: entry },
    htfCandles: { [tradeType]: htf },
    dailyCandles: daily,
    symbol,
    dataSource: "mock",
  }, [tradeType]);

  const stats = {
    generatedAt: new Date().toISOString(),
    strategyKey: "TREND_FOLLOWING",
    tradeType,
    source: "local-mock-engine",
    rsiVariant: variant,
    window: win.id,
    symbol,
    totalTrades: result.trades?.length ?? 0,
    winRate: result.stats?.winRate,
    totalReturn: result.stats?.totalReturn,
    profitFactor: result.stats?.profitFactor,
    perSymbol: [{
      symbol,
      totalTrades: result.trades?.length ?? 0,
      winRate: result.stats?.winRate,
      totalReturn: result.stats?.totalReturn,
      profitFactor: result.stats?.profitFactor,
      perTypeStats: result.perTypeStats?.[tradeType],
    }],
  };

  const suffix = rsiVariantOutSuffix(variant === "a" ? null : variant);
  const outDir = path.join(
    REPO_ROOT,
    `tmp/tf-rsi-ablation-mock/${tradeType.toLowerCase()}${suffix}`,
    `window-${String(win.id).padStart(2, "0")}`,
    symbol,
  );
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "stats.json"), JSON.stringify(stats, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
    window: win.id,
    symbol,
    tradeType,
    exportVariant: `rsi-${variant}`,
    rsiAblation: resolveRsiVariant(variant),
    note: "Local mock engine ablation (offline)",
  }, null, 2));

  return stats;
}

async function main() {
  console.log("Local mock RSI ablation — 3 windows × 3 tiers × 3 variants");
  for (const tradeType of TIERS) {
    const symbols = tradeType === "Scalping" ? ["BTCUSDT"] : DEFAULT_SYMBOLS_5;
    for (const variant of VARIANTS) {
      for (const win of WINDOWS) {
        for (const symbol of symbols) {
          process.stdout.write(`\n${tradeType} ${variant.toUpperCase()} W${win.id} ${symbol}… `);
          const s = await runCell(tradeType, variant, win, symbol);
          console.log(`trades=${s.totalTrades} NET=${s.totalReturn}%`);
        }
      }
    }
  }
  console.log("\nRun compare: node scripts/walkforward/trend-following/compare-rsi-ablation.js");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { runCell, genMock };
