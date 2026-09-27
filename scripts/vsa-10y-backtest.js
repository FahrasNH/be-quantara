#!/usr/bin/env node
"use strict";

// Research-only runner. Uses the same RealStrategyBacktestService as the API
// and the already parsed Binance Vision BTCUSDT OHLC cache.
process.env.WYCKOFF_BT_CLI = "1";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  runTripleTypeBacktest,
  _computeTripleStats,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");
const { applyStrategyJobDefaults } = require("../src/modules/backtest/services/runBacktestJob");
const { STRATEGIES } = require("../src/config/strategyDefaults");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "backtest-reports/wyckoff-10y-data/parsed");
const FILES = {
  "5m": "BTCUSDT_5m_2016-09-27_2026-09-26.json",
  "15m": "BTCUSDT_15m_2016-09-27_2026-09-26.json",
  "1h": "BTCUSDT_1h_2016-09-27_2026-09-26.json",
  "4h": "BTCUSDT_4h_2016-09-27_2026-09-26.json",
  "1d": "BTCUSDT_1d_2016-09-27_2026-09-26.json",
};
const TYPES = {
  Scalping: { entry: "5m", trend: "1h" },
  Intraday: { entry: "15m", trend: "1h" },
  Swing: { entry: "4h", trend: "1w" },
};

function load(tf) {
  const file = path.join(DATA, FILES[tf]);
  if (!fs.existsSync(file)) throw new Error(`Missing parsed cache: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function mondayUtc(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset);
}

function weekly(daily) {
  const map = new Map();
  for (const c of daily) {
    const key = mondayUtc(c.timestamp);
    const x = map.get(key);
    if (!x) map.set(key, {
      timestamp: key, open: c.open, high: c.high, low: c.low,
      close: c.close, volume: c.volume || 0,
    });
    else {
      x.high = Math.max(x.high, c.high);
      x.low = Math.min(x.low, c.low);
      x.close = c.close;
      x.volume += c.volume || 0;
    }
  }
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function config(type) {
  const defaults = STRATEGIES.VOLUME_SPREAD_ANALYSIS || {};
  const c = applyStrategyJobDefaults("VOLUME_SPREAD_ANALYSIS", {
    activeTypes: [type],
    typeOverrides: defaults.typeOverrides,
    activeComponents: ["VOLUME_SPREAD_ANALYSIS"],
    selectedComponents: ["VOLUME_SPREAD_ANALYSIS"],
  });
  c.activeTypes = [type];
  c.afActiveRacers = ["VOLUME_SPREAD_ANALYSIS"];
  c.afActiveVoters = ["VOLUME_SPREAD_ANALYSIS"];
  c.selectedComponents = ["VOLUME_SPREAD_ANALYSIS"];
  c.simulateFunding = false;
  return c;
}

function metrics(trades, capital) {
  const wins = trades.filter((t) => Number(t.pnl || 0) > 0);
  const losses = trades.filter((t) => Number(t.pnl || 0) <= 0);
  const pnl = trades.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const grossWin = wins.reduce((s, t) => s + Number(t.pnl || 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + Number(t.pnl || 0), 0));
  let equity = capital; let peak = equity; let dd = 0;
  for (const t of [...trades].sort((a, b) => Date.parse(a.closeTime || a.date) - Date.parse(b.closeTime || b.date))) {
    equity += Number(t.pnl || 0); peak = Math.max(peak, equity);
    dd = Math.max(dd, peak ? (peak - equity) / peak : 0);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? +(wins.length / trades.length * 100).toFixed(2) : 0,
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(2) : null,
    pnl: +pnl.toFixed(2),
    finalCapital: +(capital + pnl).toFixed(2),
    maxDrawdownPct: +(dd * 100).toFixed(2),
    fees: +trades.reduce((s, t) => s + Number(t.fee || 0), 0).toFixed(2),
  };
}

async function main() {
  const candles = Object.fromEntries(Object.keys(FILES).map((tf) => [tf, load(tf)]));
  const daily = candles["1d"];
  const results = {};
  for (const [type, tf] of Object.entries(TYPES)) {
    const entry = candles[tf.entry];
    const htf = type === "Swing" ? weekly(daily) : candles[tf.trend];
    const c = config(type);
    console.log(`[vsa-10y] ${type}: entry=${entry.length} htf=${htf.length}`);
    const engine = await runTripleTypeBacktest({
      strategyKey: "VOLUME_SPREAD_ANALYSIS",
      capital: 1000,
      enableFees: true,
      enableSlippage: true,
      typeOrder: [type],
      naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
      entryCandles: { [type]: entry },
      htfCandles: { [type]: htf },
      dailyCandles: daily,
      config: c,
      symbol: "BTCUSDT",
      dataSource: "binance-vision-spot-10y",
      exchangeType: "binance",
      onProgress: (p) => { if (p % 10 === 0) console.log(`[vsa-10y] ${type} ${p}%`); },
    });
    const m = metrics(engine.trades || [], 1000);
    results[type] = { metrics: m, engineStats: engine.stats, trades: engine.trades };
    console.log(`[vsa-10y] ${type}: ${JSON.stringify(m)}`);
  }
  const all = Object.values(results).flatMap((r) => r.trades || []);
  const aggregate = metrics(all, 1000);
  const report = {
    generatedAt: new Date().toISOString(),
    requested: "2016-09-27 → 2026-09-27",
    coverage: "2017-08-17 → 2026-09-26 (Binance BTCUSDT spot listing coverage)",
    source: "Binance Vision spot OHLCV; fees ON; slippage ON; funding OFF",
    results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.metrics])),
    aggregate,
  };
  const out = path.join(ROOT, "backtest-reports/vsa/vsa-10y-latest-rerun.json");
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nVSA BTCUSDT 10Y RERUN\n${JSON.stringify(report, null, 2)}\nReport: ${out}`);
}

main().catch((err) => { console.error(err.stack || err); process.exitCode = 1; });
