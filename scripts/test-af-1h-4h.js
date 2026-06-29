#!/usr/bin/env node
/**
 * test-af-1h-4h.js — Quick test of AF with 1h entry / 4h HTF
 *
 * Run: node scripts/test-af-1h-4h.js
 * This tests the fix for entry TF mismatch (was 15m/1h, now 1h/4h)
 */

require("dotenv").config();
const { runRealBacktest } = require("../src/server/services/RealStrategyBacktestService");

function genMock(symbol, days, intervalMin) {
  const bars = Math.floor((days * 24 * 60) / intervalMin);
  const seed = symbol.startsWith("BTC") ? 65000 : symbol.startsWith("ETH") ? 3500 : 600;
  let price = seed;
  let time = Date.UTC(2024, 2, 17);
  const REGIMES = ["STRONG_UP", "NORMAL", "VOLATILE_CHOP", "STRONG_DOWN", "NORMAL"];
  const REGIME_LEN = Math.floor((24 * 60) / intervalMin);
  const candles = [];
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

async function main() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  TEST: Adaptive Fusion v3.3 (1h entry / 4h HTF)`);
  console.log(`${"═".repeat(70)}\n`);

  // Test 1h entry candles (vs old 15m)
  const entryCandles = genMock("BNBUSDT", 120, 60); // 1h bars
  const htfCandles = genMock("BNBUSDT", 120, 240);   // 4h bars (vs old 1h)

  console.log(`📊 Entry bars (1h): ${entryCandles.length}  |  HTF bars (4h): ${htfCandles.length}`);
  console.log(`   (Old: 15m entry = ${Math.floor(120*24*60/15)} bars, 1h HTF = ${Math.floor(120*24*60/60)} bars)`);
  console.log(`   (New: 1h entry = ${entryCandles.length} bars, 4h HTF = ${htfCandles.length} bars)\n`);

  const { trades, stats, meta } = runRealBacktest({
    entryCandles,
    htfCandles,
    strategyKey: "ADAPTIVE_FUSION",
    capital: 1000,
    enableFees: true,
    enableSlippage: false,
  });

  console.log("📋 RESULTS");
  console.log(`${"─".repeat(70)}`);
  console.log(`  Total Trades  : ${stats.totalTrades}  (${stats.wins}W / ${stats.losses}L)`);
  console.log(`  Win Rate      : ${stats.winRate}%`);
  console.log(`  Net Return    : ${stats.totalReturn}%   (final $${stats.finalCapital})`);
  console.log(`  Profit Factor : ${stats.profitFactor}`);
  console.log(`  Avg Win/Loss  : $${stats.avgWin} / $${stats.avgLoss}  (RR ${stats.riskReward})`);
  console.log(`  Max Drawdown  : ${stats.maxDrawdown}%`);
  console.log(`  Total Fees    : $${stats.totalFees}`);

  const byDir = ["LONG", "SHORT"].map(d => {
    const t = trades.filter(x => x.side === d);
    const w = t.filter(x => x.pnl > 0).length;
    return `${d}: ${t.length} (${t.length ? (w / t.length * 100).toFixed(0) : 0}% WR)`;
  });
  const byReason = ["TP", "SL"].map(r => `${r}: ${trades.filter(t => t.reason === r).length}`);
  console.log(`  By Direction  : ${byDir.join("  |  ")}`);
  console.log(`  By Exit       : ${byReason.join("  |  ")}`);
  console.log(`${"─".repeat(70)}\n`);

  if (stats.totalTrades > 0) {
    console.log("✅ TEST PASSED: Got some trades to analyze");
    console.log(`   Win rate: ${stats.winRate}% (expected: > 40% for 1h/4h setup)`);
    if (stats.winRate > 40) {
      console.log(`   🎯 GOOD: WR improved! 1h/4h setup is working better than 0% on 15m`);
    } else {
      console.log(`   ⚠️  NEEDS WORK: Still < 40% WR, may need further refinement`);
    }
  } else {
    console.log("⚠️ No trades generated. Check if market conditions allow entry.");
  }
  console.log(`\n`);
}

main().catch(e => { console.error("Error:", e); process.exit(1); });
