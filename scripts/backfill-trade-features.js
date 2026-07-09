#!/usr/bin/env node
/**
 * backfill-trade-features.js — Feature Store (Sprint 1 / FS-5)
 *
 * Reconstructs partial entryContext for historical Trade records where
 * entryContext IS NULL, using historical candle data from Bitget CCXT.
 *
 * What is reconstructed (from candles only):
 *   atr, atrPct, ema9, ema21, ema50, rsi, bbWidth, volumeRatio
 *   + metadata from Trade record: strategyKey, pairTier, leverage, etc.
 *   + backfilled: true flag (distinguishes from live-captured context)
 *
 * What cannot be reconstructed:
 *   spread, fundingRate, signalComponents, confidenceScore (set to 0)
 *
 * Usage:
 *   node scripts/backfill-trade-features.js [--dry-run] [--batch-size=100] [--limit=500]
 *
 * Error handling:
 *   Exchange API errors: retry 3× with 5s delay, then skip + log
 *   Target coverage: ≥80% — failures logged to data/backfill-report.json
 */

"use strict";

const path   = require("path");
const fs     = require("fs");
const prisma = require("../src/infrastructure/db/prismaClient");

// Inline indicator helpers (avoid circular dependencies with BotEngine)
const { calcEMA, calcATR, calcRSI, calcSMA, calcBollingerBands } = require("../src/domain/indicators");

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const DRY_RUN    = args["dry-run"] === true || args["dry-run"] === "true";
const BATCH_SIZE = parseInt(args["batch-size"] ?? "100", 10);
const LIMIT      = parseInt(args["limit"]       ?? "0",   10); // 0 = no limit

// ── Constants ─────────────────────────────────────────────────────────────────
const INTERVAL       = "15m";
const CANDLE_BEFORE  = 50;
const RETRY_COUNT    = 3;
const RETRY_DELAY_MS = 5000;
const REPORT_PATH    = path.join(__dirname, "../data/backfill-report.json");

// ── Exchange factory (public endpoints, no API key needed for candles) ────────
let _ccxt = null;
async function getCcxt() {
  if (_ccxt) return _ccxt;
  const ccxt = require("ccxt");
  _ccxt = new ccxt.bitget({ enableRateLimit: true });
  return _ccxt;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** last non-null in array */
function lastNN(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

/** Normalise Bitget symbol for CCXT (e.g. "BTCUSDT" → "BTC/USDT:USDT") */
function normSymbol(raw) {
  if (raw.includes("/")) return raw;
  // Strip :USDT suffix if present
  const base = raw.replace(/:USDT$/, "");
  // Insert / before USDT
  const match = base.match(/^([A-Z]+)(USDT|BUSD|BTC|ETH)$/i);
  if (match) return `${match[1]}/${match[2].toUpperCase()}:USDT`;
  return raw;
}

/**
 * Fetch historical candles with retry.
 * Returns array of { timestamp, open, high, low, close, volume } or null on failure.
 */
async function fetchCandlesWithRetry(exchange, symbol, since, retries = RETRY_COUNT) {
  const ccxtSymbol = normSymbol(symbol);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const ohlcv = await exchange.fetchOHLCV(ccxtSymbol, INTERVAL, since, CANDLE_BEFORE + 10);
      return ohlcv.map(c => ({
        timestamp: c[0],
        open:      c[1],
        high:      c[2],
        low:       c[3],
        close:     c[4],
        volume:    c[5],
      }));
    } catch (err) {
      if (attempt < retries) {
        console.warn(`  [backfill] Exchange error (attempt ${attempt}/${retries}): ${err.message} — retrying in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Reconstruct partial entryContext from candle data.
 * Returns an entryContext object tagged with backfilled:true.
 */
function reconstructEntryContext(trade, candles) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const lastIdx = candles.length - 1;
  const price   = closes[lastIdx] || trade.entry || 1;

  const atrArr  = calcATR(highs, lows, closes, 14);
  const ema9Arr = calcEMA(closes, 9);
  const ema21Arr= calcEMA(closes, 21);
  const ema50Arr= calcEMA(closes, 50);
  const rsiArr  = calcRSI(closes, 14);
  const bb      = calcBollingerBands(closes, 20, 2);
  const volSMA  = calcSMA(volumes, 20);

  const atr    = lastNN(atrArr) ?? 0;
  const ema9   = lastNN(ema9Arr)  ?? price;
  const ema21  = lastNN(ema21Arr) ?? price;
  const ema50  = lastNN(ema50Arr) ?? price;
  const rsi    = lastNN(rsiArr)   ?? 50;

  const bbUpper  = lastNN(bb.upper);
  const bbLower  = lastNN(bb.lower);
  const bbMiddle = lastNN(bb.middle);
  const bbWidth  = (bbUpper && bbLower && bbMiddle && bbMiddle !== 0)
    ? ((bbUpper - bbLower) / bbMiddle) * 100
    : 0;

  const volCurrent = volumes[lastIdx] ?? 0;
  const volAvg     = lastNN(volSMA) ?? 1;

  // Infer htfRegime from EMA alignment
  let htfRegime = "ranging";
  if (ema9 > ema21 && ema21 > ema50)  htfRegime = "trending_up";
  else if (ema9 < ema21 && ema21 < ema50) htfRegime = "trending_down";
  else if (atr > 0 && (atr / price) > 0.02) htfRegime = "volatile";

  // Infer tradeType from firedByStrategy / strategyKey
  const stratKey = trade.firedByStrategy ?? trade.strategyKey ?? "UNKNOWN";
  const tradeType = stratKey.toUpperCase().includes("SCALP") ? "Scalping"
    : stratKey.toUpperCase().includes("SWING") ? "Swing"
    : "Intraday";

  return {
    capturedAt:       new Date(trade.enteredAt).toISOString(),
    htfRegime,
    atr:              +atr.toFixed(6),
    atrPct:           +(atr / price * 100).toFixed(4),
    ema9:             +ema9.toFixed(6),
    ema21:            +ema21.toFixed(6),
    ema50:            +ema50.toFixed(6),
    adx:              null,
    rsi:              +rsi.toFixed(2),
    bbWidth:          +bbWidth.toFixed(4),
    volume24h:        volCurrent,
    volumeRatio:      +(volCurrent / volAvg).toFixed(4),
    spread:           0,
    fundingRate:      null,
    strategyKey:      stratKey,
    tradeType,
    confidenceScore:  0,
    signalComponents: {},
    pairTier:         "LIQUID",
    leverage:         1,
    capitalAllocated: 0,
    backfilled:       true,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Backfill Trade Features (Sprint 1 / FS-5)     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  if (DRY_RUN) console.log("  [DRY RUN] — no writes to database\n");

  // Ensure data/ directory exists for the report
  const dataDir = path.join(__dirname, "../data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const exchange = await getCcxt();

  let cursor   = undefined;
  let total    = 0;
  let success  = 0;
  let failed   = 0;
  const failedList = [];

  while (true) {
    const batch = await prisma.trade.findMany({
      where:   { entryContext: null },
      take:    BATCH_SIZE,
      skip:    cursor ? 1 : 0,
      cursor:  cursor ? { id: cursor } : undefined,
      orderBy: { enteredAt: "asc" },
      select:  {
        id:              true,
        symbol:          true,
        side:            true,
        entry:           true,
        enteredAt:       true,
        firedByStrategy: true,
        strategyKey:     true,
      },
    });

    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    total += batch.length;

    console.log(`\nProcessing batch of ${batch.length} trades (total seen: ${total})`);

    for (const trade of batch) {
      const since = new Date(trade.enteredAt).getTime() - CANDLE_BEFORE * 15 * 60 * 1000;

      try {
        const candles = await fetchCandlesWithRetry(exchange, trade.symbol, since);

        if (!candles || candles.length < 15) {
          throw new Error(`Insufficient candles: ${candles?.length ?? 0}`);
        }

        const entryContext = reconstructEntryContext(trade, candles);

        if (!DRY_RUN) {
          await prisma.trade.update({
            where: { id: trade.id },
            data:  { entryContext },
          });
        }

        success++;
        process.stdout.write(".");
      } catch (err) {
        failed++;
        failedList.push({ tradeId: trade.id, symbol: trade.symbol, error: err.message });
        process.stdout.write("F");
      }

      // Throttle to respect exchange rate limits
      await sleep(200);
    }

    if (LIMIT > 0 && total >= LIMIT) {
      console.log(`\n[backfill] Reached limit of ${LIMIT} trades — stopping`);
      break;
    }
  }

  const coverage = total > 0 ? ((success / total) * 100).toFixed(1) : "N/A";

  console.log("\n\n══════════════════════════════════════════════════");
  console.log(`  Total trades processed : ${total}`);
  console.log(`  Success                : ${success}`);
  console.log(`  Failed                 : ${failed}`);
  console.log(`  Coverage               : ${coverage}%`);
  console.log(`  Target (≥80%)          : ${parseFloat(coverage) >= 80 ? "✅ MET" : "⚠️  NOT MET"}`);
  console.log("══════════════════════════════════════════════════");

  // Write report
  const report = {
    generatedAt:      new Date().toISOString(),
    dryRun:           DRY_RUN,
    totalProcessed:   total,
    successCount:     success,
    failedCount:      failed,
    coveragePct:      parseFloat(coverage) || 0,
    targetMet:        parseFloat(coverage) >= 80,
    failures:         failedList,
  };

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n  Report written to: ${REPORT_PATH}`);

  await prisma.$disconnect();
  process.exit(failed > 0 && parseFloat(coverage) < 80 ? 1 : 0);
}

// Guard: only run when executed directly (not when require()'d in tests)
if (require.main === module) {
  main().catch(err => {
    console.error("[backfill] Fatal error:", err);
    prisma.$disconnect().finally(() => process.exit(1));
  });
}

module.exports = { reconstructEntryContext, normSymbol };
