"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const BotEngine = require("../src/modules/trading/application/BotEngine");

function fakeEngine(pending) {
  const calls = [];
  const engine = Object.create(BotEngine.prototype);
  engine.config = { dryRun: true };
  engine.state = {
    tfPendingOrder: pending,
    lastSignal: pending.side,
    lastPrice: pending.limit,
    openPositions: [],
  };
  engine._log = () => {};
  engine._handleSignal = async (...args) => {
    calls.push(args);
    engine.state.openPositions.push({ side: args[0] });
  };
  return { engine, calls };
}

test("Trend Following retest cannot fill on the breakout candle", async () => {
  const pending = {
    side: "LONG",
    limit: 99,
    atr: 2,
    signalCandleTimestamp: 1_000,
    expiresAt: 10_000,
    signalOptions: { slDist: 4, tpDist: 8 },
    indicatorSnapshot: { strategy: "TREND_FOLLOWING" },
  };
  const { engine, calls } = fakeEngine(pending);

  const sameBar = await engine._processTrendFollowingPending([
    { timestamp: 1_000, low: 98, high: 102 },
  ], 0, 100, 2);

  assert.equal(sameBar.active, true);
  assert.equal(calls.length, 0);
  assert.ok(engine.state.tfPendingOrder);
});

test("Trend Following retest fills later at the bounded limit price", async () => {
  const pending = {
    side: "LONG",
    limit: 99,
    atr: 2,
    signalCandleTimestamp: 1_000,
    expiresAt: 10_000,
    signalOptions: { slDist: 4, tpDist: 8 },
    indicatorSnapshot: { strategy: "TREND_FOLLOWING" },
  };
  const { engine, calls } = fakeEngine(pending);

  const filled = await engine._processTrendFollowingPending([
    { timestamp: 1_005, low: 98.5, high: 101 },
  ], 0, 100, 2);

  assert.equal(filled.active, false);
  assert.equal(filled.filled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "LONG");
  assert.equal(calls[0][1], 99);
  assert.equal(calls[0][4].retestLimit, 99);
  assert.equal(engine.state.tfPendingOrder, null);
});

test("Trend Following retest expires without chasing", async () => {
  const pending = {
    side: "SHORT",
    limit: 101,
    atr: 2,
    signalCandleTimestamp: 1_000,
    expiresAt: 2_000,
  };
  const { engine, calls } = fakeEngine(pending);

  const expired = await engine._processTrendFollowingPending([
    { timestamp: 2_001, low: 99, high: 103 },
  ], 0, 100, 2);

  assert.deepEqual(expired, { active: false, filled: false });
  assert.equal(calls.length, 0);
  assert.equal(engine.state.tfPendingOrder, null);
  assert.equal(engine.state.lastSignal, null);
});
