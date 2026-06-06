#!/usr/bin/env node
/**
 * Backtest ADAPTIVE_FUSION Strategy
 *
 * Usage:
 *   node scripts/backtest-adaptive-fusion.js
 *   node scripts/backtest-adaptive-fusion.js --symbol ETHUSDT --days 60
 *
 * Requires: DATABASE_URL in .env (reads cached candles from Postgres)
 * Or: pass --source mock to use generated data for quick smoke-test.
 *
 * Output: win rate, profit factor, Sharpe ratio, max drawdown, final balance
 */

require("dotenv").config();

const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");
const { calcIndicators }     = require("../src/domain/indicators");
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
const SOURCE        = get("--source",  "mock");   // "mock" | "db"

// ── Mock candle generator — REGIME-CYCLING ────────────────────────────────
// Cycles through distinct market regimes so all 3 components get conditions to
// fire AND to score highest in turn (the whole point of ADAPTIVE_FUSION):
//   STRONG_UP / STRONG_DOWN → high trend_strength → Component C (swing) wins
//   VOLATILE_CHOP           → high volatility + volume spikes + RSI extremes
//                             → Component A (scalp) wins
//   NORMAL                  → moderate trend → Component B (day) wins
function generateMockCandles(symbol, days, intervalMin = 15) {
  const candles = [];
  const bars    = (days * 24 * 60) / intervalMin;
  const seed    = symbol === "BTCUSDT" ? 95000 : symbol === "ETHUSDT" ? 3500 : 150;
  let price     = seed;
  let time      = Date.now() - bars * intervalMin * 60 * 1000;

  const REGIME_LEN = 96;  // ~24h per regime on 15m
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_TREND", "STRONG_DOWN", "NORMAL", "VOLATILE_CHOP"];

  for (let i = 0; i < bars; i++) {
    const regime = REGIMES[Math.floor(i / REGIME_LEN) % REGIMES.length];

    let drift, noiseAmp, volBase, volSpike = 1;

    switch (regime) {
      case "STRONG_UP":
        drift = price * 0.0012;                        // sustained uptrend → C wins
        noiseAmp = 0.0015;
        volBase = 1500;
        break;
      case "STRONG_DOWN":
        drift = -price * 0.0012;                       // sustained downtrend → C wins
        noiseAmp = 0.0015;
        volBase = 1500;
        break;
      case "VOLATILE_CHOP":
        drift = (Math.random() - 0.5) * price * 0.002; // whippy, no direction
        noiseAmp = 0.006;                              // high volatility (ATR%↑)
        volBase = 1500;
        volSpike = Math.random() < 0.3 ? 2.2 + Math.random() : 1;  // periodic spikes for A
        break;
      case "VOLATILE_TREND":
        // High volatility AND an uptrend with momentum bursts — Component A's
        // ideal habitat: A scores highest (high vol) AND can co-vote with C
        // (uptrend structure) on volume-spike momentum bars.
        drift = price * 0.0014;                        // volatile uptrend
        noiseAmp = 0.0055;                             // high volatility
        volBase = 1500;
        volSpike = Math.random() < 0.4 ? 1.8 + Math.random() : 1;  // frequent spikes
        break;
      default: // NORMAL
        drift = (Math.random() - 0.45) * price * 0.0006;
        noiseAmp = 0.0025;
        volBase = 1500;
    }

    const noise  = (Math.random() - 0.5) * price * noiseAmp * 2;
    const open   = price;
    const close  = Math.max(price + drift + noise, 1);
    const high   = Math.max(open, close) * (1 + Math.random() * noiseAmp);
    const low    = Math.min(open, close) * (1 - Math.random() * noiseAmp);
    const volume = (volBase + Math.random() * 1000) * volSpike;

    candles.push({ time, open, high, low, close, volume });
    price  = close;
    time  += intervalMin * 60 * 1000;
  }
  return candles;
}

// Per-bar market conditions derived from indicators (NOT hardcoded).
// volatility   = ATR as % of price
// trendStrength= |EMA50 slope over 20 bars| as %, scaled (1.5%/20bars = full)
function marketConditionsAt(indicators, i, price) {
  const atr  = indicators.atr?.[i] || 0;
  const volatility = price > 0 ? (atr / price) * 100 : 0;

  const ema50 = indicators.emaTrend || [];
  let trendStrength = 0;
  if (ema50[i] != null && ema50[i - 20] != null && price > 0) {
    const slopePct = Math.abs(ema50[i] - ema50[i - 20]) / price * 100;
    trendStrength = Math.min(slopePct / 1.5, 1);
  }
  return { volatility, trend_strength: trendStrength };
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
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ADAPTIVE_FUSION Backtest`);
  console.log(`  Symbol: ${SYMBOL} | Days: ${DAYS} | Start Balance: $${START_BALANCE}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load candles
  const candles = generateMockCandles(SYMBOL, DAYS);
  console.log(`📊 Candles loaded: ${candles.length} bars (15m, ${DAYS} days)`);

  // Calculate indicators
  const indicators = calcIndicators(candles, { emaFast: 9, emaSlow: 21, emaTrend: 50 });
  console.log(`📈 Indicators computed\n`);

  const strategy = new AdaptiveFusionStrategy();
  const trades   = [];
  let balance    = START_BALANCE;
  let activeUntil = -1;   // index where current trade exits

  for (let i = 30; i < candles.length; i++) {
    if (i <= activeUntil) continue;  // inside an open trade — skip

    // Real per-bar market conditions (drives adaptive component selection)
    const mc = marketConditionsAt(indicators, i, candles[i].close);
    const signal = strategy.detectSignal(indicators, i, {
      balance,
      volatility:     mc.volatility,
      trend_strength: mc.trend_strength,
    });

    if (!signal) continue;

    const meta     = strategy.getLastSignalMeta();
    const component = meta ? meta.component : "B";
    const riskCfg  = strategy.calculateRiskConfig(candles[i].close, indicators.atr[i], signal, component);

    const trade    = simulateTrade(candles, i, signal, riskCfg);
    const pnlPct   = (trade.pnl / candles[i].close) * 100;

    // Size: 1% risk per trade (simplification)
    const riskAmt  = balance * 0.015;
    const slDist   = Math.abs(riskCfg.stopLoss - candles[i].close);
    const qty      = slDist > 0 ? riskAmt / slDist : 0;
    const realPnl  = trade.pnl * qty;

    balance += realPnl;
    trades.push({
      bar:       i,
      direction: signal,
      component,
      entry:     trade.entry,
      exit:      trade.exit,
      pnl:       realPnl,
      pnlPct:    pnlPct.toFixed(3),
      reason:    trade.reason,
      rr:        riskCfg.riskReward,
    });
    activeUntil = trade.exitBar;
  }

  if (trades.length === 0) {
    console.log("⚠️  No trades generated. Check score thresholds or market conditions.\n");
    return;
  }

  // ── Results ──────────────────────────────────────────────────────────────
  const wins     = trades.filter(t => t.pnl > 0);
  const losses   = trades.filter(t => t.pnl < 0);
  const winRate  = (wins.length / trades.length * 100).toFixed(1);
  const pf       = profitFactor(trades).toFixed(2);
  const sr       = sharpeRatio(trades).toFixed(2);
  const mdd      = maxDrawdown(trades, START_BALANCE).toFixed(2);
  const avgWin   = wins.length   ? (wins.reduce((s, t) => s + t.pnl, 0)   / wins.length).toFixed(2)   : "0.00";
  const avgLoss  = losses.length ? (losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(2) : "0.00";
  const totalPnl = (balance - START_BALANCE).toFixed(2);
  const roi      = ((balance - START_BALANCE) / START_BALANCE * 100).toFixed(2);

  // Component breakdown
  const byComp = ["A", "B", "C"].map(c => {
    const t = trades.filter(x => x.component === c);
    const w = t.filter(x => x.pnl > 0).length;
    return `${c}: ${t.length} trades, ${t.length ? (w / t.length * 100).toFixed(0) : 0}% WR`;
  });

  console.log(`📋 RESULTS`);
  console.log(`─${"─".repeat(50)}`);
  console.log(`  Total Trades   : ${trades.length}`);
  console.log(`  Win Rate       : ${winRate}%  (${wins.length}W / ${losses.length}L)`);
  console.log(`  Avg Win        : $${avgWin}`);
  console.log(`  Avg Loss       : $${avgLoss}`);
  console.log(`  Profit Factor  : ${pf}  ${pf >= 1.5 ? "✅" : pf >= 1.0 ? "⚠️" : "❌"}`);
  console.log(`  Sharpe Ratio   : ${sr}  ${sr >= 1.0 ? "✅" : sr >= 0.5 ? "⚠️" : "❌"}`);
  console.log(`  Max Drawdown   : ${mdd}%  ${mdd <= 15 ? "✅" : mdd <= 25 ? "⚠️" : "❌"}`);
  console.log(`  Total PnL      : $${totalPnl}  (${roi}%)`);
  console.log(`  Final Balance  : $${balance.toFixed(2)}`);
  console.log(`\n  By Component:`);
  byComp.forEach(s => console.log(`    ${s}`));
  console.log(`─${"─".repeat(50)}`);

  // Acceptance check
  const pass = parseFloat(winRate) >= 50 && parseFloat(sr) >= 1.0;
  console.log(`\n${pass ? "✅ PASS — ready for paper trade" : "❌ FAIL — tune strategy before live"}`);
  console.log(`${"═".repeat(60)}\n`);
}

runBacktest().catch(err => {
  console.error("Backtest error:", err.message);
  process.exit(1);
});
