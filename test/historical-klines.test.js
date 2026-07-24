/**
 * historical-klines.test.js — unit tests Phase 2 backtest klines helpers
 */

"use strict";

const assert = require("assert");
const {
  dedupeAndValidate,
  fillGaps,
  clampDateRange,
  periodToRange,
  estimateBarCount,
  enforceBarLimit,
  findMissingRanges,
  coverageRatio,
  MIN_HISTORICAL_MS,
  CANDLE_INTERVAL_MS,
  MAX_BARS,
} = require("../src/server/services/HistoricalKlinesService");

// ── dedupeAndValidate ────────────────────────────────────────────────────────
{
  const raw = [
    { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { timestamp: 1000, open: 1, high: 2, low: 0.5, close: 1.6, volume: 11 },
    { timestamp: 2000, open: 2, high: 3, low: 1.5, close: 2.5, volume: 5 },
    { timestamp: 3000, open: NaN, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const out = dedupeAndValidate(raw);
  assert.strictEqual(out.length, 2, "dedupe removes invalid + duplicate ts");
  assert.strictEqual(out[0].close, 1.6, "last duplicate wins");
  assert.strictEqual(out[1].timestamp, 2000);
}

// ── fillGaps ─────────────────────────────────────────────────────────────────
{
  const tfMs = CANDLE_INTERVAL_MS["1h"];
  const candles = [
    { timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { timestamp: tfMs * 3, open: 103, high: 104, low: 102, close: 103, volume: 2 },
  ];
  const filled = fillGaps(candles, "1h");
  assert.strictEqual(filled.length, 4, "fills 2 missing 1h bars");
  assert.strictEqual(filled[1].filled, true);
  assert.strictEqual(filled[1].close, 100);
  assert.strictEqual(filled[1].open, 100);
}

// ── clampDateRange ───────────────────────────────────────────────────────────
{
  const listing = Date.parse("2024-06-01T00:00:00.000Z");
  const { startMs, endMs } = clampDateRange({
    startMs: MIN_HISTORICAL_MS,
    endMs: Date.parse("2025-01-01T00:00:00.000Z"),
    listingMs: listing,
    autoListing: true,
  });
  assert.strictEqual(startMs, listing, "autoListing clamps to listing date");
  assert.ok(endMs > startMs);
}

{
  const future = Date.now() + 86_400_000;
  const { endMs } = clampDateRange({ startMs: MIN_HISTORICAL_MS, endMs: future });
  assert.ok(endMs <= Date.now(), "end clamped to now");
}

{
  const bad = clampDateRange({ startMs: Date.now(), endMs: Date.now() - 1000 });
  assert.ok(bad.startMs < bad.endMs, "invalid range repaired");
}

// ── periodToRange ────────────────────────────────────────────────────────────
{
  const r3 = periodToRange("3m");
  assert.ok(r3.endMs - r3.startMs >= 89 * 86_400_000);
  assert.strictEqual(periodToRange("500"), null);
  const custom = periodToRange("custom", "2023-01-01", "2023-06-01");
  assert.ok(custom.startMs >= Date.parse("2023-01-01T00:00:00.000Z"));
}

// ── estimateBarCount / enforceBarLimit ───────────────────────────────────────
{
  const end = Date.now();
  const start = end - 365 * 86_400_000;
  const bars12m1d = estimateBarCount(start, end, "1d");
  assert.ok(bars12m1d >= 360 && bars12m1d <= 370, "12m daily ~365 bars");

  const ok = enforceBarLimit(start, end, "1d", "12m");
  assert.strictEqual(ok.clamped, false);

  const hugeStart = end - MAX_BARS * CANDLE_INTERVAL_MS["15m"] * 2;
  assert.throws(
    () => enforceBarLimit(hugeStart, end, "15m", "12m"),
    (e) => e.code === "TOO_MANY_BARS"
  );

  const clamped = enforceBarLimit(hugeStart, end, "15m", "max");
  assert.strictEqual(clamped.clamped, true);
  assert.ok(clamped.bars <= MAX_BARS);
}

// ── findMissingRanges ────────────────────────────────────────────────────────
{
  const tfMs = CANDLE_INTERVAL_MS["1h"];
  const candles = [
    { timestamp: tfMs * 10, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    { timestamp: tfMs * 11, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  ];
  const ranges = findMissingRanges(candles, 0, tfMs * 20, "1h");
  assert.strictEqual(ranges.length, 2, "gap at start and end");
}

// ── coverageRatio ────────────────────────────────────────────────────────────
{
  const tfMs = CANDLE_INTERVAL_MS["1h"];
  const end = tfMs * 10;
  const start = 0;
  const candles = Array.from({ length: 9 }, (_, i) => ({
    timestamp: i * tfMs,
    open: 1, high: 1, low: 1, close: 1, volume: 1,
  }));
  const ratio = coverageRatio(candles, start, end, "1h");
  assert.ok(ratio >= 0.85, "9/10 bars = 90% coverage");
}

// ── gap-fill restores uniform index↔time spacing (SAC-FIX cross-exchange) ─────
// The sequence engine reasons on ARRAY INDICES (freshness: sweepAge = lastIdx-sweepIdx),
// which is only valid if bar[i+1].timestamp - bar[i].timestamp == tfMs for every i.
// This guards the fix that removed the ">10k bars → skip gap-fill" shortcut, which had
// left index/time misaligned differently per exchange (root of Binance/Bitget/OKX divergence).
{
  const tfMs = CANDLE_INTERVAL_MS["5m"];
  // Sparse series with two gaps (missing bars 2-4 and 6)
  const sparse = [0, 1, 5, 7, 8].map((i) => ({
    timestamp: i * tfMs, open: 100, high: 101, low: 99, close: 100, volume: 5,
  }));
  const filled = fillGaps(sparse, "5m");
  // Every adjacent pair must be exactly tfMs apart — uniform spacing restored
  for (let i = 1; i < filled.length; i++) {
    assert.strictEqual(
      filled[i].timestamp - filled[i - 1].timestamp, tfMs,
      `bar ${i} not uniformly spaced after gap-fill`
    );
  }
  // Span 0..8 = 9 slots → 9 bars
  assert.strictEqual(filled.length, 9, "gap-fill produces contiguous 9-bar series");
  // Filled bars are flat + zero-volume so the strategy ignores them (no fake signals)
  const synthetic = filled.filter((c) => c.filled);
  assert.ok(synthetic.length === 4, "4 synthetic bars inserted");
  assert.ok(synthetic.every((c) => c.volume === 0), "synthetic bars are zero-volume");
  assert.ok(synthetic.every((c) => c.high === c.low && c.open === c.close), "synthetic bars are flat");
}

console.log("✓ historical-klines tests passed");

// ── in-flight fetch coalescing (singleflight) ───────────────────────────────
(async () => {
  const {
    _coalesceRangeFetch,
    _rangeFetchKey,
    _clearCaches,
  } = require("../src/server/services/HistoricalKlinesService");

  let calls = 0;
  const key = _rangeFetchKey("binance", "BTC/USDT:USDT", "1h", 1000, 2000);
  _clearCaches();

  const slow = () => new Promise((resolve) => {
    calls += 1;
    setTimeout(() => resolve("ok"), 30);
  });

  const [a, b] = await Promise.all([
    _coalesceRangeFetch(key, slow),
    _coalesceRangeFetch(key, slow),
  ]);

  assert.strictEqual(calls, 1, "concurrent identical range fetches coalesce to one call");
  assert.strictEqual(a, "ok");
  assert.strictEqual(b, "ok");
  console.log("✓ coalesceRangeFetch deduplicates concurrent range fetches");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
