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
  MIN_HISTORICAL_MS,
  CANDLE_INTERVAL_MS,
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

console.log("✓ historical-klines tests passed");
