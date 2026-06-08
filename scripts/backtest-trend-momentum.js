#!/usr/bin/env node
/**
 * Backtest TREND_MOMENTUM Strategy (MINT tier)
 *
 * Usage:
 *   node scripts/backtest-trend-momentum.js
 *   node scripts/backtest-trend-momentum.js --days 365 --capital 10000000
 *
 * Target: 54-58% win rate, 100-180% annual return, <15% max drawdown
 */

require("dotenv").config();

const TrendMomentumStrategy = require("../src/domain/strategy/implementations/TrendMomentumStrategy");
const { calcIndicators } = require("../src/domain/indicators");
const { simulateTrade }   = require("./lib/simulator");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const SYMBOL        = get("--symbol",  "BTCUSDT");
const DAYS          = parseInt(get("--days",   "60"), 10);
const START_BALANCE = parseFloat(get("--capital", "10000000"));
const SEED          = parseInt(get("--seed", "12345"), 10);

// PRNG deterministik (mulberry32) → backtest REPRODUCIBLE (sebelumnya Math.random
// membuat tiap run memakai data berbeda; metrik tak bisa dibandingkan antar-run).
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRng(SEED);

// ── Mock candle generator with REALISTIC alternating regimes ──────────────
// Cycles through bull-trend → chop → bear-trend → chop so the strategy faces
// both winning and losing setups (avoids the monotonic-uptrend artifact that
// inflates win rate). Trends also fail sometimes (whipsaws) for realism.
function generateMockCandles(symbol, days, intervalMin = 5) {
  const candles = [];
  const bars    = (days * 24 * 60) / intervalMin;
  const seed    = symbol === "BTCUSDT" ? 42000 : symbol === "ETHUSDT" ? 2500 : 150;
  let price     = seed;
  let time      = Date.now() - bars * intervalMin * 60 * 1000;

  // Regime cycle: each regime lasts ~120 bars (10h on 5m)
  const REGIME_LEN = 120;
  const REGIMES = ["BULL", "CHOP", "BEAR", "CHOP"];

  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];

    let drift;        // directional bias
    let noise = (rand() - 0.5) * price * 0.0012;  // base noise

    if (regime === "BULL") {
      drift = price * 0.0004;                              // upward bias
      // Occasional pullback/whipsaw (20% of bars push against trend)
      if (rand() < 0.2) drift = -price * 0.0006;
    } else if (regime === "BEAR") {
      drift = -price * 0.0004;                             // downward bias
      if (rand() < 0.2) drift = price * 0.0006;     // bear rally trap
    } else {
      drift = 0;                                           // chop: no bias
      noise = (rand() - 0.5) * price * 0.0008;      // tighter range
    }

    const change = drift + noise;
    const open   = price;
    const close  = Math.max(price + change, 1);
    const high   = Math.max(open, close) * (1 + rand() * 0.0025);
    const low    = Math.min(open, close) * (1 - rand() * 0.0025);

    const volume = regime === "CHOP"
      ? (800 + rand() * 2000)
      : (1000 + rand() * 3000) * 1.2;

    candles.push({ time, open, high, low, close, volume });
    price  = close;
    time  += intervalMin * 60 * 1000;
  }
  return candles;
}


// ── Metrics ───────────────────────────────────────────────────────────────
function profitFactor(trades) {
  const gross_win  = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const gross_loss = Math.abs(trades.filter(t => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  return gross_loss === 0 ? Infinity : gross_win / gross_loss;
}

function sharpeRatio(trades, riskFreeDaily = 0) {
  if (trades.length < 2) return 0;
  const returns = trades.map(t => t.pnl);
  const avg     = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std     = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
  return std === 0 ? 0 : ((avg - riskFreeDaily) / std) * Math.sqrt(252);
}

function maxDrawdown(trades, startBalance) {
  let peak = startBalance;
  let bal  = startBalance;
  let mdd  = 0;
  for (const t of trades) {
    bal  += t.pnl;
    peak  = Math.max(peak, bal);
    mdd   = Math.max(mdd, (peak - bal) / peak);
  }
  return mdd * 100;
}

// ── Main backtest ─────────────────────────────────────────────────────────
async function runBacktest() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  TREND_MOMENTUM Strategy Backtest (MINT tier)`);
  console.log(`  Symbol: ${SYMBOL} | Days: ${DAYS} | Start Balance: $${START_BALANCE}`);
  console.log(`  Expected: Win Rate 54-58%, RR 1:1.92, Annual Return 100-180%`);
  console.log(`${"═".repeat(70)}\n`);

  // Load candles
  const candles = generateMockCandles(SYMBOL, DAYS);
  console.log(`📊 Candles loaded: ${candles.length} bars (5m, ${DAYS} days)`);

  // Calculate indicators
  const indicators = calcIndicators(candles, {
    emaFast: 9,
    emaSlow: 21,
    emaTrend: 50,
    atrPeriod: 14,
    rsiPeriod: 14,
  });
  console.log(`📈 Indicators computed\n`);

  const strategy = new TrendMomentumStrategy();
  const trades   = [];
  let balance    = START_BALANCE;
  let activeUntil = -1;

  for (let i = 50; i < candles.length; i++) {
    if (i <= activeUntil) continue;

    const signal = strategy.detectSignal(indicators, i, { balance });

    if (!signal) continue;

    const atr = indicators.atr[i];
    const riskCfg = strategy.calculateRiskConfig(candles[i].close, atr, signal);

    const trade    = simulateTrade(candles, i, signal, riskCfg);
    const pnlPct   = (trade.pnl / candles[i].close) * 100;

    // Size via strategy.calculatePositionSize() — caps notional at balance×leverage
    // (FIX #7: consistent, leverage-aware sizing — no runaway compounding)
    const qty      = strategy.calculatePositionSize(
      balance, candles[i].close, riskCfg.stopLoss, 0.02, strategy.config.leverage
    );
    const realPnl  = trade.pnl * qty;

    balance += realPnl;
    trades.push({
      bar:       i,
      direction: signal,
      entry:     trade.entry.toFixed(2),
      exit:      trade.exit.toFixed(2),
      sl:        riskCfg.stopLoss.toFixed(2),
      tp:        riskCfg.takeProfit.toFixed(2),
      pnl:       realPnl.toFixed(2),
      pnlPct:    pnlPct.toFixed(3),
      reason:    trade.reason,
      rr:        riskCfg.riskReward,
    });
    activeUntil = trade.exitBar;
  }

  if (trades.length === 0) {
    console.log("⚠️  No trades generated. Check the strategy conditions.\n");
    return;
  }

  // Log first 5 trades
  console.log(`\n📋 First 5 trades (detailed):`);
  trades.slice(0, 5).forEach((t, i) => {
    console.log(`  ${i+1}. ${t.direction} @ ${t.entry} | SL=${t.sl} TP=${t.tp} | Exit=${t.exit} (${t.reason}) | PnL=$${t.pnl}`);
  });

  // ── Results ──────────────────────────────────────────────────────────────
  const wins     = trades.filter(t => parseFloat(t.pnl) > 0);
  const losses   = trades.filter(t => parseFloat(t.pnl) < 0);
  const winRate  = (wins.length / trades.length * 100).toFixed(1);
  const pf       = profitFactor(trades.map(t => ({ pnl: parseFloat(t.pnl) }))).toFixed(2);
  const sr       = sharpeRatio(trades.map(t => ({ pnl: parseFloat(t.pnl) }))).toFixed(2);
  const mdd      = maxDrawdown(trades.map(t => ({ pnl: parseFloat(t.pnl) })), START_BALANCE).toFixed(2);
  const avgWin   = wins.length
    ? (wins.reduce((s, t) => s + parseFloat(t.pnl), 0) / wins.length).toFixed(2)
    : "0.00";
  const avgLoss  = losses.length
    ? (losses.reduce((s, t) => s + parseFloat(t.pnl), 0) / losses.length).toFixed(2)
    : "0.00";
  const totalPnl = (balance - START_BALANCE).toFixed(2);
  const roi      = ((balance - START_BALANCE) / START_BALANCE * 100).toFixed(2);
  const avgRR    = trades.length
    ? (trades.reduce((s, t) => s + t.rr, 0) / trades.length).toFixed(2)
    : "0.00";

  console.log(`\n📋 RESULTS`);
  console.log(`─${"─".repeat(68)}`);
  console.log(`  Total Trades   : ${trades.length}`);
  console.log(`  Win Rate       : ${winRate}%  (${wins.length}W / ${losses.length}L)  ${parseFloat(winRate) >= 54 ? "✅" : "⚠️"}`);
  console.log(`  Avg Win        : $${avgWin}`);
  console.log(`  Avg Loss       : $${avgLoss}`);
  console.log(`  Avg RR         : 1:${avgRR}  ${parseFloat(avgRR) >= 1.9 ? "✅" : "⚠️"}`);
  console.log(`  Profit Factor  : ${pf}  ${pf >= 1.5 ? "✅" : pf >= 1.0 ? "⚠️" : "❌"}`);
  console.log(`  Sharpe Ratio   : ${sr}  ${sr >= 1.0 ? "✅" : sr >= 0.5 ? "⚠️" : "❌"}`);
  console.log(`  Max Drawdown   : ${mdd}%  ${mdd <= 15 ? "✅" : mdd <= 25 ? "⚠️" : "❌"}`);
  console.log(`  Total PnL      : $${totalPnl}  (${roi}%)`);
  console.log(`  Final Balance  : $${balance.toFixed(2)}`);
  console.log(`─${"─".repeat(68)}`);

  // Acceptance check (MINT tier criteria)
  const passWR  = parseFloat(winRate) >= 54;
  const passRR  = parseFloat(avgRR) >= 1.8;
  const passPF  = parseFloat(pf) >= 1.5;
  const passMDD = parseFloat(mdd) <= 15;
  const pass    = passWR && passRR && passPF && passMDD;

  console.log(`\nMINT Tier Acceptance Criteria:`);
  console.log(`  ✅ Win Rate 54%+     : ${passWR ? "PASS" : "FAIL"} (${winRate}%)`);
  console.log(`  ✅ RR 1:1.8+         : ${passRR ? "PASS" : "FAIL"} (1:${avgRR})`);
  console.log(`  ✅ Profit Factor 1.5 : ${passPF ? "PASS" : "FAIL"} (${pf})`);
  console.log(`  ✅ Max Drawdown <15% : ${passMDD ? "PASS" : "FAIL"} (${mdd}%)`);

  console.log(`\n${pass ? "✅ PASS — Strategy ready for paper trading" : "⚠️  REVIEW — Optimize strategy before live"}`);
  console.log(`${"═".repeat(70)}\n`);
}

runBacktest().catch(err => {
  console.error("Backtest error:", err.message);
  process.exit(1);
});
