#!/usr/bin/env node
/**
 * backtest-af-real.js — Run the REAL (1:1) server-side backtest from the CLI.
 *
 * Uses RealStrategyBacktestService, which replays candles through the same
 * strategy + HTF + risk-gate code as live (AdaptiveStrategyEngine).
 *
 * Usage:
 *   # quick smoke test with synthetic regime-cycling candles:
 *   node scripts/backtest-af-real.js --source mock --days 120
 *
 *   # real candles from DB cache (requires DATABASE_URL + cached klines):
 *   node scripts/backtest-af-real.js --source db --symbol BNBUSDT \
 *        --entry 15m --htf 1h --start 2024-03-17 --end 2026-06-28 --user <userId>
 */

require("dotenv").config();
const { runRealBacktest } = require("../src/server/services/RealStrategyBacktestService");

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const SOURCE = get("--source", "mock");
const SYMBOL = get("--symbol", "BNBUSDT");
const ENTRY_TF = get("--entry", "15m");
const HTF = get("--htf", "1h");
const DAYS = parseInt(get("--days", "120"), 10);
const CAPITAL = parseFloat(get("--capital", "1000"));
const STRAT = get("--strategy", "ADAPTIVE_FUSION");

const TF_MIN = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240, "1d": 1440 };

// ── Synthetic regime-cycling candles (smoke test only) ──────────────────────
function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3500 : 600;
  let price = seed;
  let time = Date.UTC(2024, 2, 17) - 0; // deterministic start
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.floor((24 * 60) / intervalMin); // ~1 day per regime
  const candles = [];
  // deterministic pseudo-random (no Math.random for reproducibility)
  let s = 123456789;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];
    let drift, noiseAmp;
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
    const volume = 1000 + rnd() * 2000;
    candles.push({ timestamp: time, date: new Date(time).toISOString(), open, high, low, close, volume });
    price = close;
    time += intervalMin * 60 * 1000;
  }
  return candles;
}

async function loadCandles(tf) {
  if (SOURCE === "mock") return genMock(SYMBOL, DAYS, TF_MIN[tf] || 15);
  // DB / exchange path
  const HistoricalKlinesService = require("../src/server/services/HistoricalKlinesService");
  const userId = get("--user", null);
  const start = get("--start", null);
  const end = get("--end", null);
  const res = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
    symbol: SYMBOL, timeframe: tf, customStart: start, customEnd: end,
  });
  return res.candles;
}

async function main() {
  console.log(`\n${"═".repeat(64)}`);
  console.log(`  REAL Backtest (1:1 w/ live)  ·  ${STRAT}`);
  console.log(`  ${SYMBOL}  ·  entry ${ENTRY_TF} + HTF ${HTF}  ·  source=${SOURCE}`);
  console.log(`${"═".repeat(64)}`);

  const entryCandles = await loadCandles(ENTRY_TF);
  const htfCandles = HTF && HTF !== "none" ? await loadCandles(HTF) : null;
  console.log(`📊 entry bars: ${entryCandles.length}  |  HTF bars: ${htfCandles?.length ?? 0}\n`);

  const { trades, stats, meta } = await runRealBacktest({
    entryCandles, htfCandles, strategyKey: STRAT, capital: CAPITAL,
    enableFees: true, enableSlippage: false,
  });

  console.log("📋 RESULTS");
  console.log(`─${"─".repeat(50)}`);
  console.log(`  Total Trades  : ${stats.totalTrades}  (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  Win Rate      : ${stats.winRate}%`);
  console.log(`  Net Return    : ${stats.totalReturn}%   (final $${stats.finalCapital})`);
  console.log(`  Profit Factor : ${stats.profitFactor}`);
  console.log(`  Avg Win/Loss  : $${stats.avgWin} / $${stats.avgLoss}  (RR ${stats.riskReward})`);
  console.log(`  Max Drawdown  : ${stats.maxDrawdown}%`);
  console.log(`  Sharpe        : ${stats.sharpe}`);
  console.log(`  Total Fees    : $${stats.totalFees}`);
  // component / direction breakdown
  const byDir = ["LONG", "SHORT"].map(d => {
    const t = trades.filter(x => x.side === d);
    const w = t.filter(x => x.pnl > 0).length;
    return `${d}: ${t.length} (${t.length ? (w / t.length * 100).toFixed(0) : 0}% WR)`;
  });
  const byReason = ["TP", "SL"].map(r => `${r}: ${trades.filter(t => t.reason === r).length}`);
  console.log(`  By Direction  : ${byDir.join("  |  ")}`);
  console.log(`  By Exit       : ${byReason.join("  |  ")}`);
  console.log(`─${"─".repeat(50)}\n`);
  console.log(JSON.stringify({ meta }, null, 0));
}

main().catch(e => { console.error("Backtest error:", e); process.exit(1); });
