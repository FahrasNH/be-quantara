// candle-fetch-rate-gate.test.js — HTF cache + global exchange throttle

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const { withExchangeGate, isRateLimitError, _resetGates } = require("../src/infrastructure/exchange/exchangeRateGate");
const { fetchCandlesWithCache, HTF_CACHE_TTL } = require("../src/infrastructure/exchange/candleFetch");

beforeEach(() => _resetGates());

test("isRateLimitError detects OKX 50011 and Bitget 30007", () => {
  assert.ok(isRateLimitError(new Error('okx {"code":"50011"}')));
  assert.ok(isRateLimitError(new Error("Too many requests")));
  assert.ok(isRateLimitError(new Error('bitget {"code":"30007"}')));
  assert.ok(!isRateLimitError(new Error("bad symbol")));
});

test("withExchangeGate serializes calls per exchange (spacing enforced)", async () => {
  const times = [];
  const t0 = Date.now();
  await Promise.all([
    withExchangeGate("okx", async () => { times.push(Date.now() - t0); return 1; }),
    withExchangeGate("okx", async () => { times.push(Date.now() - t0); return 2; }),
    withExchangeGate("okx", async () => { times.push(Date.now() - t0); return 3; }),
  ]);
  times.sort((a, b) => a - b);
  assert.ok(times[1] - times[0] >= 100, "second call waits for spacing");
  assert.ok(times[2] - times[1] >= 100, "third call waits for spacing");
});

test("fetchCandlesWithCache returns fresh cache without calling exchange", async () => {
  const db = require("../src/infrastructure/db/database");
  const origGet = db.getCachedCandles;
  let liveCalls = 0;
  db.getCachedCandles = async () => Array.from({ length: 50 }, (_, i) => ({
    timestamp: i, date: new Date(i).toISOString(),
    open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
  }));
  const client = {
    getCandles: async () => { liveCalls += 1; return []; },
  };
  try {
    const out = await fetchCandlesWithCache(client, {
      exchange: "okx", symbol: "BTCUSDT", interval: "1h",
      cacheTtlSeconds: HTF_CACHE_TTL, minBars: 30,
    });
    assert.strictEqual(liveCalls, 0, "cache hit → no live fetch");
    assert.strictEqual(out.length, 50);
  } finally {
    db.getCachedCandles = origGet;
  }
});

test("fetchCandlesWithCache calls exchange on cache miss and writes cache", async () => {
  const db = require("../src/infrastructure/db/database");
  const origGet = db.getCachedCandles;
  const origSet = db.cacheCandles;
  db.getCachedCandles = async () => null;
  let cached = null;
  db.cacheCandles = async (ex, sym, iv, rows) => { cached = { ex, sym, iv, n: rows.length }; };
  let liveCalls = 0;
  const client = {
    getCandles: async () => {
      liveCalls += 1;
      return Array.from({ length: 60 }, (_, i) => ({
        timestamp: i, date: new Date(i).toISOString(),
        open: 1, high: 2, low: 0.5, close: 1.5, volume: 10,
      }));
    },
  };
  try {
    const out = await fetchCandlesWithCache(client, {
      exchange: "okx", symbol: "SOLUSDT", interval: "1h",
      cacheTtlSeconds: HTF_CACHE_TTL, minBars: 30,
    });
    assert.strictEqual(liveCalls, 1);
    assert.strictEqual(out.length, 60);
    assert.ok(cached && cached.iv === "1h" && cached.n === 60);
  } finally {
    db.getCachedCandles = origGet;
    db.cacheCandles = origSet;
  }
});
