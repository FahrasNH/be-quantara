/**
 * liveTradeTypeGate.test.js — Sprint 14 live-safety: Scalping stays backtest-only
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  isTypeLiveEligible,
  DEFAULT_LIVE_ELIGIBLE_TYPES,
} = require("#config/liveTradeTypeGate.js");

test("LIVE-GATE: Scalping is not live-eligible (any strategy)", () => {
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", "Scalping"), false);
  assert.equal(isTypeLiveEligible("ADAPTIVE_FUSION", "Scalping"), false);
  assert.equal(isTypeLiveEligible("TREND_FOLLOWING", "Scalping"), false);
});

test("LIVE-GATE: SMART_MONEY_CONCEPTS dry-run only until walk-forward re-validates (Sprint 22)", () => {
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", "Intraday"), false);
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", "Swing"), false);
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", "Scalping"), false);
});

test("LIVE-GATE: other strategies keep Intraday + Swing live-eligible", () => {
  assert.equal(isTypeLiveEligible("TREND_FOLLOWING", "Intraday"), true);
  assert.equal(isTypeLiveEligible("TREND_FOLLOWING", "Swing"), true);
  assert.deepEqual(DEFAULT_LIVE_ELIGIBLE_TYPES, ["Intraday", "Swing"]);
});

test("LIVE-GATE: missing type is not eligible", () => {
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", null), false);
  assert.equal(isTypeLiveEligible("SMART_MONEY_CONCEPTS", ""), false);
});
