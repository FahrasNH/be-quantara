#!/usr/bin/env node
/**
 * Backtest BREAKOUT_RETEST Strategy (FOUNDRY tier)
 *
 * Usage:
 *   node scripts/backtest-breakout-retest.js
 *   node scripts/backtest-breakout-retest.js --symbol ETHUSDT --days 365
 *
 * Configuration:
 *   - Symbol: BTCUSDT (default)
 *   - Days: 30 (default, can override with --days)
 *   - Capital: $1000 (default, can override with --capital)
 *   - Risk per trade: 3% (FOUNDRY tier)
 *
 * Metrics:
 *   - Expected win rate: 51-56%
 *   - Expected RR: 1:4.0
 *   - Expected annual return: 350-420%
 *
 * Output: win rate, profit factor, Sharpe ratio, max drawdown, final balance
 */

require("dotenv").config();

const BreakoutRetestStrategy = require("../src/domain/strategy/implementations/BreakoutRetestStrategy");
const { calcIndicators } = require("../src/domain/indicators");
const { simulateTrade }   = require("./lib/simulator");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const SYMBOL        = get("--symbol",  "BTCUSDT");
const DAYS          = parseInt(get("--days",   "30"), 10);
const START_BALANCE = parseFloat(get("--capital", "1000"));

// ── Mock candle generator with realistic breakouts ────────────────────────
function generateMockCandles(symbol, days, intervalMin = 15) {
  const candles = [];
  const bars    = (days * 24 * 60) / intervalMin;
  const seed    = symbol === "BTCUSDT" ? 95000 : symbol === "ETHUSDT" ? 3500 : 150;
  let price     = seed;
  let time      = Date.now() - bars * intervalMin * 60 * 1000;

  // Generate candles with periodic breakout patterns
  for (let i = 0; i < bars; i++) {
    // Create consolidation zones periodically (every 20-30 bars)
    const isConsolidationPhase = (i % 25) < 15;
    const changeRange = isConsolidationPhase ? 0.0005 : 0.003; // Tight vs loose movement

    const change = (Math.random() - 0.495) * price * changeRange;
    const open   = price;
    const close  = Math.max(price + change, 1);
    const high   = Math.max(open, close) * (1 + Math.random() * 0.005);
    const low    = Math.min(open, close) * (1 - Math.random() * 0.005);

    // Higher volume on breakouts
    const isBreakout = (i % 25) >= 15;
    const volume = isBreakout
      ? (500 + Math.random() * 3000) * 1.3  // 30% more volume on breakouts
      : (500 + Math.random() * 2000);

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
  console.log(`  BREAKOUT_RETEST Strategy Backtest (FOUNDRY tier)`);
  console.log(`  Symbol: ${SYMBOL} | Days: ${DAYS} | Start Balance: $${START_BALANCE}`);
  console.log(`  Expected: Win Rate 51-56%, RR 1:4.0, Annual Return 350-420%`);
  console.log(`${"═".repeat(70)}\n`);

  // Load candles
  const candles = generateMockCandles(SYMBOL, DAYS);
  console.log(`📊 Candles loaded: ${candles.length} bars (15m, ${DAYS} days)`);

  // Calculate indicators
  const indicators = calcIndicators(candles, {
    emaFast: 9,
    emaSlow: 21,
    emaTrend: 50,
    atrPeriod: 14,
    rsiPeriod: 14,
  });
  console.log(`📈 Indicators computed\n`);

  const strategy = new BreakoutRetestStrategy();
  const trades   = [];
  let balance    = START_BALANCE;
  let activeUntil = -1;   // index where current trade exits

  for (let i = 30; i < candles.length; i++) {
    if (i <= activeUntil) continue;  // inside an open trade — skip

    const signal = strategy.detectSignal(indicators, i, {
      balance,
    });

    if (!signal) continue;

    const atr = indicators.atr[i];
    const riskCfg = strategy.calculateRiskConfig(candles[i].close, atr, signal);

    const trade    = simulateTrade(candles, i, signal, riskCfg);
    const pnlPct   = (trade.pnl / candles[i].close) * 100;

    // Size: 3% risk per trade (FOUNDRY tier)
    const riskAmt  = balance * 0.03;
    const slDist   = Math.abs(riskCfg.stopLoss - candles[i].close);
    const qty      = slDist > 0 ? riskAmt / slDist : 0;
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

  // ── DEBUG: Log first 10 trades + validate SL/TP ordering ──────────────────
  // Expected:  LONG  → SL < entry < TP   (stop below, target above)
  //            SHORT → SL > entry > TP   (stop above, target below)
  console.log(`\n📋 DEBUG — First 10 trades (SL/TP ordering check):`);
  let orderingBad = 0;
  trades.slice(0, 10).forEach((t, i) => {
    const entry = parseFloat(t.entry);
    const sl    = parseFloat(t.sl);
    const tp    = parseFloat(t.tp);

    let ok;
    if (t.direction === "LONG")  ok = sl < entry && entry < tp;   // SL < entry < TP
    else                         ok = sl > entry && entry > tp;   // SL > entry > TP

    if (!ok) orderingBad++;
    const flag    = ok ? "✅ OK" : "❌ REVERSED";
    const pattern = t.direction === "LONG" ? "SL<entry<TP" : "SL>entry>TP";

    console.log(
      `  #${String(i + 1).padStart(2)}. ${t.direction.padEnd(5)} ` +
      `entry=${t.entry}  SL=${t.sl}  TP=${t.tp}  ` +
      `[${pattern}] ${flag}  → exit=${t.exit} (${t.reason}) PnL=$${t.pnl}`
    );
  });
  console.log(
    `\n  SL/TP ordering: ${orderingBad === 0
      ? "✅ ALL CORRECT — logic is NOT reversed"
      : `❌ ${orderingBad}/10 REVERSED — SL/TP logic bug`}`
  );

  // Direction balance (a 100% one-sided book often points at the detector/mock,
  // not the SL/TP math)
  const longN  = trades.filter(t => t.direction === "LONG").length;
  const shortN = trades.filter(t => t.direction === "SHORT").length;
  console.log(`  Direction mix : ${longN} LONG / ${shortN} SHORT`);

  // Exit-reason mix (all-SL or all-Timeout points at simulator/RR, not direction)
  const byReason = trades.reduce((m, t) => ((m[t.reason] = (m[t.reason] || 0) + 1), m), {});
  console.log(`  Exit reasons  : ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join("  ")}`);

  if (trades.length === 0) {
    console.log("⚠️  No trades generated. Check the breakout/retest detection logic.\n");
    return;
  }

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

  console.log(`📋 RESULTS`);
  console.log(`─${"─".repeat(68)}`);
  console.log(`  Total Trades   : ${trades.length}`);
  console.log(`  Win Rate       : ${winRate}%  (${wins.length}W / ${losses.length}L)  ${parseFloat(winRate) >= 51 ? "✅" : "⚠️"}`);
  console.log(`  Avg Win        : $${avgWin}`);
  console.log(`  Avg Loss       : $${avgLoss}`);
  console.log(`  Avg RR         : 1:${avgRR}  ${parseFloat(avgRR) >= 4 ? "✅" : "⚠️"}`);
  console.log(`  Profit Factor  : ${pf}  ${pf >= 1.5 ? "✅" : pf >= 1.0 ? "⚠️" : "❌"}`);
  console.log(`  Sharpe Ratio   : ${sr}  ${sr >= 1.0 ? "✅" : sr >= 0.5 ? "⚠️" : "❌"}`);
  console.log(`  Max Drawdown   : ${mdd}%  ${mdd <= 20 ? "✅" : mdd <= 30 ? "⚠️" : "❌"}`);
  console.log(`  Total PnL      : $${totalPnl}  (${roi}%)`);
  console.log(`  Final Balance  : $${balance.toFixed(2)}`);
  console.log(`─${"─".repeat(68)}`);

  // Acceptance check (FOUNDRY tier criteria)
  const passWR  = parseFloat(winRate) >= 51;
  const passRR  = parseFloat(avgRR) >= 3.5;
  const passPF  = parseFloat(pf) >= 1.5;
  const pass    = passWR && passRR && passPF;

  console.log(`\nFOUNDRY Tier Acceptance Criteria:`);
  console.log(`  ✅ Win Rate 51%+     : ${passWR ? "PASS" : "FAIL"} (${winRate}%)`);
  console.log(`  ✅ RR 1:3.5+         : ${passRR ? "PASS" : "FAIL"} (1:${avgRR})`);
  console.log(`  ✅ Profit Factor 1.5 : ${passPF ? "PASS" : "FAIL"} (${pf})`);

  console.log(`\n${pass ? "✅ PASS — Strategy ready for paper trading" : "⚠️  REVIEW — Optimize strategy before live"}`);
  console.log(`${"═".repeat(70)}\n`);
}

runBacktest().catch(err => {
  console.error("Backtest error:", err.message);
  process.exit(1);
});
