"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildTrendFollowingMtfContext,
} = require("../src/core/strategy-engine/ts/trendFollowingMtf");

test("Trend Following MTF context maps only completed 5m→15m candles", () => {
  const entry = Array.from({ length: 9 }, (_, i) => ({
    timestamp: Date.UTC(2025, 0, 1) + i * 5 * 60_000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: 10,
  }));
  const context = buildTrendFollowingMtfContext(entry, {
    entryInterval: "5m",
    mtfInterval: "15m",
  });

  assert.equal(context.candles.length, 3);
  assert.deepEqual(context.indexByEntry, [-1, -1, 0, 0, 0, 1, 1, 1, 2]);
  assert.equal(context.candles[0].open, entry[0].open);
  assert.equal(context.candles[0].close, entry[2].close);
  assert.equal(context.candles[0].volume, 30);
});

test("Trend Following MTF context preserves same-TF bars as completed", () => {
  const entry = Array.from({ length: 3 }, (_, i) => ({
    timestamp: Date.UTC(2025, 0, 1) + i * 15 * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
  const context = buildTrendFollowingMtfContext(entry, {
    entryInterval: "15m",
    mtfInterval: "15m",
  });
  assert.deepEqual(context.indexByEntry, [0, 1, 2]);
});
