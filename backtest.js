// ─────────────────────────────────────────────
// backtest.js — Jalankan backtest historis
//
// Cara pakai:
//   node backtest.js
//   node backtest.js --symbol ETHUSDT --days 365
//   node backtest.js --exchange okx --symbol BTC-USDT-SWAP
//   node backtest.js --exchange okx --symbol ETH-USDT-SWAP --days 180
// ─────────────────────────────────────────────

require("dotenv").config();

const { createExchangeClient, getExchangeInfo, EXCHANGE: DEFAULT_EXCHANGE } = require("./exchange-factory");
const { calcIndicators, detectSignal, calcPositionSize } = require("./indicators");

// Parse args
const args = process.argv.slice(2);
const getArg = (key) => { const i = args.indexOf(key); return i !== -1 ? args[i + 1] : null; };

// --exchange flag override env EXCHANGE
const EXCHANGE_ARG = getArg("--exchange") || DEFAULT_EXCHANGE;
if (EXCHANGE_ARG !== DEFAULT_EXCHANGE) process.env.EXCHANGE = EXCHANGE_ARG;

const exchangeInfo = getExchangeInfo();

// Default symbol tergantung exchange
const DEFAULT_SYMBOL = exchangeInfo.id === "okx"
  ? (process.env.OKX_INST_ID || "BTC-USDT-SWAP")
  : (process.env.SYMBOL       || "BTCUSDT");

const SYMBOL   = getArg("--symbol") || DEFAULT_SYMBOL;
const DAYS     = parseInt(getArg("--days") || "365");
const INTERVAL = getArg("--interval") || process.env.CANDLE_INTERVAL || "4H";
const CAPITAL  = parseFloat(getArg("--capital") || "500");

const PARAMS = {
  emaFast:       parseInt(getArg("--ema-fast")   || process.env.EMA_FAST       || "9"),
  emaSlow:       parseInt(getArg("--ema-slow")   || process.env.EMA_SLOW       || "21"),
  rsiPeriod:     parseInt(getArg("--rsi-period") || process.env.RSI_PERIOD     || "14"),
  rsiOverbought: parseInt(getArg("--rsi-ob")     || process.env.RSI_OVERBOUGHT || "70"),
  rsiOversold:   parseInt(getArg("--rsi-os")     || process.env.RSI_OVERSOLD   || "30"),
  atrPeriod:     parseInt(getArg("--atr-period") || process.env.ATR_PERIOD     || "14"),
  atrMultiplier: parseFloat(getArg("--atr-mult") || process.env.ATR_MULTIPLIER || "2"),
  riskReward:    parseFloat(getArg("--rr")       || process.env.RISK_REWARD    || "3"),
  riskPerTrade:  parseFloat(getArg("--risk")     || process.env.RISK_PER_TRADE || "0.02"),
  useBothSides:  getArg("--both-sides") === "true" || process.env.USE_BOTH_SIDES === "true",
};

// Colors
const C = {
  reset:  "\x1b[0m",  bold:   "\x1b[1m",
  green:  "\x1b[32m", red:    "\x1b[31m",
  yellow: "\x1b[33m", cyan:   "\x1b[36m",
  blue:   "\x1b[34m", gray:   "\x1b[90m",
  white:  "\x1b[37m",
};

function fmt(v, decimals = 2) {
  return typeof v === "number" ? v.toFixed(decimals) : v;
}

function colored(val, positiveGood = true) {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  const color = (n > 0) === positiveGood ? C.green : C.red;
  return `${color}${val}${C.reset}`;
}

// Generate simulasi candles
function generateCandles(n, symbol) {
  const seed = symbol.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  let price = symbol.includes("BTC") ? 28000
    : symbol.includes("ETH") ? 1800
    : symbol.includes("SOL") ? 60
    : symbol.includes("BNB") ? 300 : 1;

  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
  const randn = () => (rand() + rand() + rand() - 1.5) / 1.5;

  const candles = [];
  const now = Date.now();
  const intervalMs = INTERVAL === "1H" ? 3600000 : INTERVAL === "4H" ? 14400000 : 86400000;

  let trend = 0;
  for (let i = n; i >= 0; i--) {
    if (i % 50 === 0) trend = randn() * 0.002;
    const change = trend + randn() * 0.02;
    const open   = price;
    const close  = Math.max(price * (1 + change), price * 0.5);
    const vol    = price * 0.015;
    candles.push({
      timestamp: now - i * intervalMs,
      date: new Date(now - i * intervalMs).toISOString().slice(0, 10),
      open, high: Math.max(open, close) + rand() * vol,
      low: Math.min(open, close) - rand() * vol, close, volume: rand() * 500,
    });
    price = close;
  }
  return candles;
}

// ── CORE BACKTEST ──
function runBacktest(candles, params, initialCapital) {
  const { emaFast, emaSlow, rsiOverbought, rsiOversold, atrMultiplier, riskReward, riskPerTrade, useBothSides } = params;

  const indicators = calcIndicators(candles, params);
  let capital = initialCapital;
  let position = null;
  const trades = [];
  const equity = [];
  let peak = initialCapital;
  let maxDD = 0;
  let maxDDStart, maxDDEnd;

  for (let i = emaSlow + 20; i < candles.length - 1; i++) {
    const c = candles[i];
    const price = c.close;
    const atr = indicators.atr[i];

    // Cek exit
    if (position && atr) {
      const hitTP = position.side === "LONG" ? price >= position.tp : price <= position.tp;
      const hitSL = position.side === "LONG" ? price <= position.sl : price >= position.sl;

      // Reverse crossover
      const reversal = (() => {
        const ef = indicators.emaFast, es = indicators.emaSlow;
        if (position.side === "LONG")  return ef[i] < es[i] && ef[i-1] >= es[i-1];
        if (position.side === "SHORT") return ef[i] > es[i] && ef[i-1] <= es[i-1];
        return false;
      })();

      if (hitTP || hitSL || reversal) {
        const exitPrice = hitTP ? position.tp : hitSL ? position.sl : price;
        const pnl = position.side === "LONG"
          ? (exitPrice - position.entry) * position.size
          : (position.entry - exitPrice) * position.size;

        capital += pnl;
        if (capital > peak) peak = capital;
        const dd = (peak - capital) / peak * 100;
        if (dd > maxDD) { maxDD = dd; maxDDEnd = c.date; }

        trades.push({
          openDate:  position.openDate,
          closeDate: c.date,
          side:      position.side,
          entry:     position.entry,
          exit:      exitPrice,
          sl:        position.sl,
          tp:        position.tp,
          size:      position.size,
          pnl:       +pnl.toFixed(4),
          pnlPct:    +((pnl / (position.entry * position.size)) * 100).toFixed(2),
          reason:    hitTP ? "TP" : hitSL ? "SL" : "Reversal",
          capitalAfter: +capital.toFixed(2),
        });
        position = null;
      }
    }

    // Cek entry
    if (!position) {
      const signal = detectSignal(indicators, i, { rsiOverbought, rsiOversold, useBothSides });
      if (signal && atr) {
        const slDist = atr * atrMultiplier;
        const tpDist = slDist * riskReward;
        const sl = signal === "LONG" ? price - slDist : price + slDist;
        const tp = signal === "LONG" ? price + tpDist : price - tpDist;
        const size = calcPositionSize(capital, riskPerTrade, price, sl);
        if (size > 0) {
          position = { side: signal, entry: price, sl, tp, size, openDate: c.date, atr };
          if (capital > peak) peak = capital;
          if (!maxDDStart) maxDDStart = c.date;
        }
      }
    }

    equity.push({ date: c.date, capital: +capital.toFixed(2), price });
  }

  // Stats
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const tpHits = trades.filter(t => t.reason === "TP");
  const slHits = trades.filter(t => t.reason === "SL");
  const revs   = trades.filter(t => t.reason === "Reversal");
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);

  // CAGR — hitung berapa tahun data
  const firstDate = new Date(candles[0].date);
  const lastDate  = new Date(candles[candles.length - 1].date);
  const years     = (lastDate - firstDate) / (365.25 * 24 * 60 * 60 * 1000);
  const cagr      = years > 0 ? (Math.pow((initialCapital + totalPnL) / initialCapital, 1 / years) - 1) * 100 : 0;

  return {
    trades, equity,
    params: { ...params, capital: initialCapital },
    stats: {
      totalTrades:   trades.length,
      wins:          wins.length,
      losses:        losses.length,
      winRate:       trades.length ? (wins.length / trades.length * 100) : 0,
      tpHits:        tpHits.length,
      slHits:        slHits.length,
      reversals:     revs.length,
      grossWin,      grossLoss,
      profitFactor:  grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0,
      avgWin:        wins.length ? grossWin / wins.length : 0,
      avgLoss:       losses.length ? grossLoss / losses.length : 0,
      riskRewardActual: losses.length && wins.length ? (grossWin / wins.length) / (grossLoss / losses.length) : 0,
      totalPnL,
      totalReturn:   (totalPnL / initialCapital) * 100,
      finalCapital:  initialCapital + totalPnL,
      maxDrawdown:   maxDD,
      cagr,
      period:        `${candles[0].date} → ${candles[candles.length - 1].date}`,
    }
  };
}

// ── PRINT REPORT ──
function printReport(result, symbol, interval) {
  const { stats, trades, params } = result;
  const s = stats;

  const line = "═".repeat(60);
  const thin = "─".repeat(60);

  console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.bold}${C.yellow}  BACKTEST REPORT — ${symbol} (${interval})${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}`);

  console.log(`\n${C.bold}  PARAMETER STRATEGI${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);
  console.log(`  EMA Fast/Slow   : ${params.emaFast} / ${params.emaSlow}`);
  console.log(`  RSI (OB/OS)     : ${params.rsiPeriod} (${params.rsiOverbought}/${params.rsiOversold})`);
  console.log(`  ATR SL          : ${params.atrMultiplier}x ATR`);
  console.log(`  Take Profit     : ${params.atrMultiplier * params.riskReward}x ATR (R:R 1:${params.riskReward})`);
  console.log(`  Risk/trade      : ${(params.riskPerTrade * 100).toFixed(0)}% modal`);
  console.log(`  Sides           : ${params.useBothSides ? "LONG + SHORT" : "LONG only"}`);
  console.log(`  Periode         : ${s.period}`);

  console.log(`\n${C.bold}  HASIL KESELURUHAN${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);
  console.log(`  Modal Awal      : $${fmt(params.capital)}`);
  console.log(`  Modal Akhir     : ${colored("$" + fmt(s.finalCapital), true)}`);
  console.log(`  Total Return    : ${colored(fmt(s.totalReturn) + "%", true)}`);
  console.log(`  CAGR            : ${colored(fmt(s.cagr) + "%/tahun", true)}`);
  console.log(`  Max Drawdown    : ${colored(fmt(s.maxDrawdown) + "%", false)}`);
  console.log(`  Profit Factor   : ${colored(fmt(s.profitFactor), true)}`);

  console.log(`\n${C.bold}  STATISTIK TRADE${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);
  console.log(`  Total Trades    : ${s.totalTrades}`);
  console.log(`  Wins / Losses   : ${C.green}${s.wins}W${C.reset} / ${C.red}${s.losses}L${C.reset}`);
  console.log(`  Win Rate        : ${colored(fmt(s.winRate) + "%", true)}`);
  console.log(`  Exit TP/SL/Rev  : ${s.tpHits} TP | ${s.slHits} SL | ${s.reversals} Reversal`);
  console.log(`  Avg Win         : ${C.green}+$${fmt(s.avgWin)}${C.reset}`);
  console.log(`  Avg Loss        : ${C.red}-$${fmt(s.avgLoss)}${C.reset}`);
  console.log(`  R:R Aktual      : 1 : ${colored(fmt(s.riskRewardActual), true)}`);
  console.log(`  Gross Win       : ${C.green}+$${fmt(s.grossWin)}${C.reset}`);
  console.log(`  Gross Loss      : ${C.red}-$${fmt(s.grossLoss)}${C.reset}`);

  // Top 5 trades
  const best  = [...trades].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const worst = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 3);

  console.log(`\n${C.bold}  3 TRADE TERBAIK${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);
  best.forEach(t => {
    console.log(`  ${t.openDate} | ${t.side.padEnd(5)} | Entry $${fmt(t.entry)} → $${fmt(t.exit)} | ${C.green}+$${fmt(t.pnl)} (+${fmt(t.pnlPct)}%)${C.reset} | ${t.reason}`);
  });

  console.log(`\n${C.bold}  3 TRADE TERBURUK${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);
  worst.forEach(t => {
    console.log(`  ${t.openDate} | ${t.side.padEnd(5)} | Entry $${fmt(t.entry)} → $${fmt(t.exit)} | ${C.red}-$${fmt(Math.abs(t.pnl))} (${fmt(t.pnlPct)}%)${C.reset} | ${t.reason}`);
  });

  console.log(`\n${C.bold}  EQUITY CURVE (ASCII)${C.reset}`);
  console.log(`${C.gray}${thin}${C.reset}`);

  // Mini ASCII chart
  const eqValues = result.equity.filter((_, i) => i % Math.ceil(result.equity.length / 40) === 0).map(e => e.capital);
  const minEq = Math.min(...eqValues);
  const maxEq = Math.max(...eqValues);
  const range = maxEq - minEq || 1;
  const height = 8;
  const chart = Array.from({ length: height }, () => new Array(eqValues.length).fill(" "));

  eqValues.forEach((v, x) => {
    const y = height - 1 - Math.round(((v - minEq) / range) * (height - 1));
    chart[y][x] = "●";
  });

  chart.forEach((row, i) => {
    const label = i === 0 ? `$${fmt(maxEq, 0)}` : i === height - 1 ? `$${fmt(minEq, 0)}` : "      ";
    const color = i < height / 2 ? C.green : C.red;
    console.log(`  ${C.gray}${label.padEnd(8)}${C.reset} ${color}${row.join("")}${C.reset}`);
  });

  console.log(`\n${C.bold}${C.cyan}${line}${C.reset}`);
  console.log(`${C.gray}  ⚠️  Hasil backtest adalah simulasi historis, BUKAN jaminan profit masa depan.${C.reset}`);
  console.log(`${C.bold}${C.cyan}${line}${C.reset}\n`);
}

// ── MAIN ──
async function main() {
  const exchLabel = exchangeInfo.label;
  console.log(`\n${C.cyan}${C.bold}  Menjalankan backtest [${exchLabel}] ${SYMBOL} — ${INTERVAL} — ${DAYS} hari...${C.reset}\n`);

  let candles;

  // Coba ambil data dari exchange yang dipilih
  const apiKeyEnv = exchangeInfo.id === "okx" ? process.env.OKX_API_KEY : process.env.BITGET_API_KEY;
  const hasApiKey = apiKeyEnv && apiKeyEnv !== "your_api_key_here";

  if (hasApiKey || exchangeInfo.id === "okx") {
    // OKX market data endpoint publik (tidak butuh API key)
    try {
      const client = createExchangeClient();
      const limit  = Math.min(DAYS * (INTERVAL === "4H" ? 6 : INTERVAL === "1H" ? 24 : 1), 300);
      candles = await client.getCandles(SYMBOL, INTERVAL, limit);
      console.log(`  Data dari ${exchLabel}: ${candles.length} candles`);
    } catch (err) {
      console.log(`  Gagal dari ${exchLabel} (${err.message}), pakai data simulasi`);
    }
  }

  if (!candles) {
    const n = DAYS * (INTERVAL === "4H" ? 6 : INTERVAL === "1H" ? 24 : 1);
    candles = generateCandles(n, SYMBOL);
    console.log(`  Data simulasi: ${candles.length} candles`);
  }

  const result = runBacktest(candles, PARAMS, CAPITAL);
  printReport(result, SYMBOL, INTERVAL);

  // Export CSV jika ada --export
  if (args.includes("--export")) {
    const fs = require("fs");
    const csv = ["date,side,entry,exit,pnl,pnlPct,reason,capitalAfter"]
      .concat(result.trades.map(t =>
        `${t.openDate},${t.side},${t.entry},${t.exit},${t.pnl},${t.pnlPct},${t.reason},${t.capitalAfter}`
      )).join("\n");
    const filename = `backtest_${SYMBOL}_${INTERVAL}_${Date.now()}.csv`;
    fs.writeFileSync(filename, csv);
    console.log(`  📄 Hasil diekspor ke: ${filename}\n`);
  }
}

main().catch(err => {
  console.error(`${C.red}Error: ${err.message}${C.reset}`);
  process.exit(1);
});
