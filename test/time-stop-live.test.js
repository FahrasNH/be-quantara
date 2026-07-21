/**
 * TIME_STOP — live + dry-run parity via maxHoldHours (typeOverrides).
 *
 * Live path previously returned before TIME_STOP; both paths now share
 * _executeTimeStopClose (market close live, simulated close dry-run).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const BotEngine = require("../src/modules/trading/application/BotEngine");
const db = require("../src/infrastructure/db/database");

function basePos(overrides = {}) {
  return {
    id: "ts1",
    dbId: 42,
    side: "LONG",
    entry: 100,
    sl: 98,
    tp: 104,
    size: 1,
    remainingSize: 1,
    marginReserved: 1,
    tradeType: "Scalping",
    openTime: Date.now() - 3 * 3600 * 1000,
    m1: false,
    m2: false,
    m3: false,
    ...overrides,
  };
}

function makeBot({ dryRun, pos, typeOverrides }) {
  const bot = new BotEngine({
    symbol: "BTCUSDT",
    dryRun,
    strategyKey: "ADAPTIVE_FUSION",
    maxHoldHours: 2,
    typeOverrides: typeOverrides ?? {
      Scalping: { maxHoldHours: 2 },
      Intraday: { maxHoldHours: 6 },
      Swing: { maxHoldHours: 120 },
    },
  });
  bot.sessionId = 1;
  bot.config.slPlusEnabled = false;
  bot.state.capital = 1000;
  bot.state.openPositions = [pos];
  bot._resolveFee = async () => 0.01;
  bot._syncSessionStats = () => {};
  bot._releaseMarginIfFlat = () => {};
  bot._notifyClose = () => {};
  bot._notifyError = async () => {};
  bot._updateRiskAfterClose = () => {};
  return bot;
}

test("dry-run: max hold exceeded → TIME_STOP close", async () => {
  const origClose = db.closeTrade;
  db.closeTrade = async () => ({ applied: true });
  try {
    const bot = makeBot({ dryRun: true, pos: basePos() });
    await bot._checkOpenPositions(101, 1, 101, 101);
    assert.equal(bot.state.openPositions.length, 0);
    assert.equal(bot.state.trades.length, 1);
    assert.equal(bot.state.trades[0].reason, "TIME_STOP");
  } finally {
    db.closeTrade = origClose;
  }
});

test("dry-run: within max hold → position stays open", async () => {
  const bot = makeBot({
    dryRun: true,
    pos: basePos({ openTime: Date.now() - 30 * 60 * 1000 }),
  });
  await bot._checkOpenPositions(100.5, 1, 100.5, 100.5);
  assert.equal(bot.state.openPositions.length, 1);
  assert.equal(bot.state.trades.length, 0);
});

test("live: max hold exceeded → market close + TIME_STOP bookkeeping", async () => {
  const origClose = db.closeTrade;
  db.closeTrade = async () => ({ applied: true });
  let closeCalls = 0;
  const pos = basePos();
  const bot = makeBot({ dryRun: false, pos });
  bot.client = {
    getPositions: async () => [{ side: pos.side, markPrice: 101.5, unrealizedPL: 1.5 }],
    closePosition: async () => { closeCalls += 1; },
    getRecentFillPrice: async () => 101.5,
  };
  try {
    await bot._checkOpenPositions(101, 1, 101, 101);
    assert.equal(closeCalls, 1, "live TIME_STOP must call exchange closePosition");
    assert.equal(bot.state.openPositions.length, 0);
    assert.equal(bot.state.trades.length, 1);
    assert.equal(bot.state.trades[0].reason, "TIME_STOP");
    assert.equal(bot.state.trades[0].exit, 101.5);
  } finally {
    db.closeTrade = origClose;
  }
});

test("_resolveMaxHoldHours reads Intraday typeOverrides", () => {
  const bot = makeBot({
    dryRun: true,
    pos: basePos({ tradeType: "Intraday" }),
  });
  assert.equal(bot._resolveMaxHoldHours(bot.state.openPositions[0]), 6);
});
