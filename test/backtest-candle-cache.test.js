/**
 * backtest-candle-cache.test.js — shared candle pool hit/miss + HistoricalKlines integration
 * Run: node test/backtest-candle-cache.test.js
 */

"use strict";

const assert = require("assert");
const { BacktestCandleCache, MIN_SLICE_COVERAGE, _coverageRatio } = require("../src/server/services/BacktestCandleCache");

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}: ${err.message}`);
  }
}

function makeSeries(tfMs, count, start = Date.parse("2024-01-01T00:00:00Z")) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const ts = start + i * tfMs;
    out.push({
      timestamp: ts,
      date: new Date(ts).toISOString(),
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 10,
    });
  }
  return out;
}

console.log("\n=== Backtest Candle Cache Tests ===\n");

const cache = new BacktestCandleCache();
const tfMs = 900_000;
const series = makeSeries(tfMs, 200);
const startMs = series[0].timestamp;
const endMs = series[series.length - 1].timestamp;

test("series key is exchange:symbol:timeframe", () => {
  assert.strictEqual(cache.seriesKey("Binance", "btcusdt", "15M"), "binance:BTCUSDT:15m");
});

test("miss on empty pool", () => {
  const hit = cache.tryGet("binance", "BTCUSDT", "15m", startMs, endMs);
  assert.strictEqual(hit, null);
  assert.strictEqual(cache.getStats().misses, 1);
});

test("merge + full-range hit reuses candles without refetch", () => {
  cache.merge("binance", "BTCUSDT", "15m", series);
  const hit = cache.tryGet("binance", "BTCUSDT", "15m", startMs, endMs);
  assert.ok(hit?.hit, "expected cache hit");
  assert.strictEqual(hit.source, "session-pool");
  assert.strictEqual(hit.candles.length, series.length);
  assert.ok(hit.coverage >= MIN_SLICE_COVERAGE);
  assert.strictEqual(cache.getStats().hits, 1);
});

test("slice hit for sub-range inside stored series", () => {
  const subStart = series[20].timestamp;
  const subEnd = series[80].timestamp;
  const hit = cache.tryGet("binance", "BTCUSDT", "15m", subStart, subEnd);
  assert.ok(hit?.hit);
  assert.strictEqual(hit.candles[0].timestamp, subStart);
  assert.strictEqual(hit.candles[hit.candles.length - 1].timestamp, subEnd);
});

test("partial miss when requested range extends beyond pool", () => {
  const beyondEnd = endMs + tfMs * 200;
  const partial = cache.tryGet("binance", "BTCUSDT", "15m", startMs, beyondEnd);
  assert.ok(partial, "expected partial response");
  assert.strictEqual(partial.hit, false);
  assert.strictEqual(partial.partial, true);
  assert.ok(partial.missingRanges.length >= 1);
});

test("different symbol is independent miss", () => {
  const beforeMisses = cache.getStats().misses;
  const hit = cache.tryGet("binance", "ETHUSDT", "15m", startMs, endMs);
  assert.strictEqual(hit, null);
  assert.strictEqual(cache.getStats().misses, beforeMisses + 1);
});

test("merge extends pool and subsequent hit covers wider range", () => {
  const extra = makeSeries(tfMs, 30, endMs + tfMs);
  cache.merge("binance", "BTCUSDT", "15m", extra);
  const newEnd = extra[extra.length - 1].timestamp;
  const hit = cache.tryGet("binance", "BTCUSDT", "15m", startMs, newEnd);
  assert.ok(hit?.hit);
  assert.strictEqual(hit.candles.length, series.length + extra.length);
});

test("coverage helper matches slice density", () => {
  const ratio = _coverageRatio(series, startMs, endMs, "15m");
  assert.ok(ratio >= 0.99);
});

// ── HistoricalKlinesService session-pool integration (mocked exchange) ───────
(async () => {
  const name = "fetchHistoricalKlines uses session pool on second identical call";
  try {
    const tf = "1h";
    const tf1h = 3_600_000;
    const candles = makeSeries(tf1h, 120);
    const start = new Date(candles[0].timestamp).toISOString();
    const end = new Date(candles[candles.length - 1].timestamp).toISOString();
    let exchangeCalls = 0;

    const ExchangeService = require("../src/services/ExchangeService");
    ExchangeService.getConnectedExchange = async () => "binance";

    const ccxt = require("ccxt");
    const origCtor = ccxt.binance;
    ccxt.binance = function MockBinance() {
      this.loadMarkets = async () => {};
      this.fetchOHLCV = async (_sym, _tf, since, limit) => {
        exchangeCalls += 1;
        const batch = [];
        let t = since;
        for (let i = 0; i < (limit || 500); i++) {
          if (t > candles[candles.length - 1].timestamp) break;
          batch.push([t, 100, 101, 99, 100.5, 10]);
          t += tf1h;
        }
        return batch;
      };
    };

    // Re-require after mocks so destructured imports pick up stubs.
    const hksPath = require.resolve("../src/server/services/HistoricalKlinesService");
    delete require.cache[hksPath];
    const HistoricalKlinesService = require("../src/server/services/HistoricalKlinesService");
    const sessionCache = require("../src/server/services/BacktestCandleCache");
    const { _clearCaches } = HistoricalKlinesService;

    _clearCaches();
    sessionCache.clear();

    const db = require("../src/infrastructure/db/database");
    const origDbRange = db.getCachedCandlesInRangeForBacktest;
    const origDbRangeLegacy = db.getCachedCandlesInRange;
    const origCacheCandles = db.cacheCandles;
    db.getCachedCandlesInRangeForBacktest = async () => null;
    db.getCachedCandlesInRange = async () => null;
    db.cacheCandles = async () => {};

    const opts = {
      symbol: "BTCUSDT",
      timeframe: tf,
      start,
      end,
      allowClamp: true,
    };

    const first = await HistoricalKlinesService.fetchHistoricalKlines("user-a", opts);
    assert.ok(first.candles.length > 0, "first fetch returns candles");
    assert.ok(exchangeCalls > 0, "first fetch hits exchange");

    const callsAfterFirst = exchangeCalls;
    const second = await HistoricalKlinesService.fetchHistoricalKlines("user-a", opts);
    assert.ok(second.candles.length > 0, "second fetch returns candles");
    assert.strictEqual(exchangeCalls, callsAfterFirst, "second fetch should reuse session pool");
    assert.ok(second.source === "session-pool" || second.cached === true, `source=${second.source}`);

    ccxt.binance = origCtor;
    db.getCachedCandlesInRangeForBacktest = origDbRange;
    db.getCachedCandlesInRange = origDbRangeLegacy;
    db.cacheCandles = origCacheCandles;
    delete require.cache[hksPath];
    _clearCaches();
    sessionCache.clear();

    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  ✗ ${name}: ${err.message}`);
  }

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
