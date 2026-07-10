#!/usr/bin/env node
/**
 * backtest-pair-tier.js  (scripts/backtest-pair-tier.js)
 *
 * PAIR-TIER-11 — Backtest validation for VOLATILE/STABLE pairs with tier params
 *
 * Validates that MEAN_REVERSION with VOLATILE tier params achieves:
 *   WLD:  >= 45% win rate
 *   HYPE: >= 35% win rate  (thin order book — lower target)
 *   SOL:  >= 80% win rate maintained  (LIQUID baseline)
 *
 * Usage:
 *   node scripts/backtest-pair-tier.js
 *   node scripts/backtest-pair-tier.js --symbol WLDUSDT --days 60
 *   node scripts/backtest-pair-tier.js --all
 *
 * NOTE: Results use seeded synthetic candles (Ornstein-Uhlenbeck process).
 * Real-market validation required before live — this is a logic sanity check.
 */

'use strict';
require('dotenv').config();

const MeanReversionStrategy = require('../src/domain/strategy/implementations/MeanReversionStrategy');
const { calcIndicators }    = require('../src/domain/indicators');
const { simulateTrade }     = require('./lib/simulator');
const { pairClassifier }    = require('../src/infrastructure/classification/PairClassifier');

// ── CLI ───────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const get  = (f, d) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const flag = (f)    => argv.includes(f);

const RUN_ALL = flag('--all');
const SYMBOL  = get('--symbol', 'WLDUSDT');
const DAYS    = parseInt(get('--days', '60'), 10);
const SEED    = parseInt(get('--seed', '99999'), 10);

const TARGETS = {
  WLDUSDT:  { minWR: 0.45, label: 'WLD (VOLATILE)',  tier: 'VOLATILE' },
  HYPEUSDT: { minWR: 0.35, label: 'HYPE (VOLATILE)', tier: 'VOLATILE' },
  SOLUSDT:  { minWR: 0.80, label: 'SOL (LIQUID)',    tier: 'LIQUID'   },
};

// ── PRNG (mulberry32) for reproducible runs ───────────────────────────────────
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Synthetic candle generator (Ornstein-Uhlenbeck) ──────────────────────────
// VOLATILE pairs: high sigma (large moves), lower theta (slower mean reversion)
// This models WLD/HYPE which make sharp moves but eventually revert
function generateMockCandles(symbol, days, rand) {
  const intervalMin = 15;
  const candles     = [];
  const bars        = (days * 24 * 60) / intervalMin;
  const tier        = pairClassifier.determineTier(symbol);

  const seedPrices  = { BTCUSDT: 43000, ETHUSDT: 2500, SOLUSDT: 150, WLDUSDT: 3.5, HYPEUSDT: 12.0 };
  let price         = seedPrices[symbol] || 1.0;
  let anchor        = price;
  let time          = 1_700_000_000_000 + bars * intervalMin * 60 * 1000;

  // VOLATILE: bigger swings, more overshoot (MR opportunity)
  const sigma = tier === 'VOLATILE' ? 0.022 : tier === 'LIQUID' ? 0.008 : 0.014;
  const theta = tier === 'VOLATILE' ? 0.025 : tier === 'LIQUID' ? 0.030 : 0.025;
  const anchorDrift = 0.00005;

  for (let i = 0; i < bars; i++) {
    anchor += anchor * anchorDrift * (rand() - 0.5);
    price  += theta * (anchor - price) + price * sigma * (rand() * 2 - 1);
    price   = Math.max(price * 0.6, price);
    const atr    = price * (sigma * 2.5);
    const range  = atr * (0.5 + rand() * 1.5);
    const isUp   = rand() > 0.48;
    const open   = price;
    const close  = price + (isUp ? 1 : -1) * range * 0.4 * rand();
    const high   = Math.max(open, close) + range * 0.3 * rand();
    const low    = Math.min(open, close) - range * 0.3 * rand();
    const volume = 800000 * (0.5 + rand());
    candles.push({ timestamp: time, open, high, low, close, volume });
    time  += intervalMin * 60 * 1000;
    price  = close;
  }
  return candles;
}

// ── Run a single backtest ─────────────────────────────────────────────────────
function runBacktest(symbol, days, seed) {
  const rand       = makeRng(seed + symbol.charCodeAt(0));
  const candles    = generateMockCandles(symbol, days, rand);
  const pairClass  = pairClassifier.classify(symbol);
  const overrides  = pairClass.paramOverrides;

  const strategy   = new MeanReversionStrategy();
  const indicators = calcIndicators(candles);

  let balance      = 10000;
  let wins = 0, losses = 0;
  const equity     = [balance];

  for (let i = 50; i < candles.length - 1; i++) {
    // Build config matching what BotEngine would send for this pair tier
    const config = {
      balance,
      tierOverrides: {
        slMultiplier:            overrides.slMultiplier,
        positionSizeAdjustment:  overrides.positionSizeAdjustment,
        regimeFilterRequired:    overrides.regimeFilterRequired,
      },
    };

    const signal = strategy.detectSignal(indicators, i, config);
    if (!signal) continue;

    const entryPrice = candles[i + 1].open;
    const atr        = indicators.atr?.[i] ?? entryPrice * 0.01;
    const slMult     = overrides.slMultiplier ?? 1.0;
    const posFactor  = overrides.positionSizeAdjustment ?? 1.0;
    const riskConfig = strategy.calculateRiskConfig(entryPrice, atr * slMult, signal);

    const tradeResult = simulateTrade(
      candles.slice(i + 1, i + 1 + 40),
      signal,
      entryPrice,
      riskConfig.stopLoss,
      riskConfig.takeProfit,
      balance * 0.01 * posFactor,
    );

    if (!tradeResult) continue;

    if (tradeResult.pnl > 0) {
      wins++;
    } else {
      losses++;
    }
    balance += tradeResult.pnl;
    equity.push(balance);
  }

  const totalTrades = wins + losses;
  const winRate     = totalTrades > 0 ? wins / totalTrades : 0;
  const totalReturn = ((balance - 10000) / 10000) * 100;
  const maxDD       = equity.reduce((dd, eq, i) => {
    const peak = Math.max(...equity.slice(0, i + 1));
    return Math.max(dd, (peak - eq) / peak);
  }, 0);

  return { symbol, tier: pairClass.tier, totalTrades, wins, losses, winRate, totalReturn, maxDD, balance };
}

// ── Print result ──────────────────────────────────────────────────────────────
function printResult(result, target) {
  const passed = result.winRate >= target.minWR;
  const wr     = (result.winRate * 100).toFixed(1);
  const ret    = result.totalReturn.toFixed(2);
  const dd     = (result.maxDD * 100).toFixed(1);
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`\n${status}  ${target.label}`);
  console.log(`  Trades:   ${result.totalTrades}  (${result.wins}W / ${result.losses}L)`);
  console.log(`  Win Rate: ${wr}%  (target ≥ ${(target.minWR * 100).toFixed(0)}%)`);
  console.log(`  Return:   ${ret}%`);
  console.log(`  Max DD:   ${dd}%`);
  return passed;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const symbols = RUN_ALL ? Object.keys(TARGETS) : [SYMBOL.toUpperCase()];
  let allPass = true;

  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║     PAIR-TIER Backtest Validation (PAIR-TIER-11)      ║`);
  console.log(`╚══════════════════════════════════════════════════════╝`);
  console.log(`  Seed: ${SEED} | Days: ${DAYS} per symbol\n`);

  for (const sym of symbols) {
    const target = TARGETS[sym];
    if (!target) {
      console.log(`⚠  No target defined for ${sym} — skipping`);
      continue;
    }
    console.log(`Running backtest for ${sym} (${DAYS} days, ${target.tier})...`);
    const result = runBacktest(sym, DAYS, SEED);
    const pass   = printResult(result, target);
    if (!pass) allPass = false;
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(allPass ? '✅ All targets met' : '❌ Some targets not met — review tier param overrides');
  console.log('NOTE: Synthetic data only — run live shadow trade for real validation (PAIR-TIER-12).\n');
  process.exit(allPass ? 0 : 1);
}

main();
