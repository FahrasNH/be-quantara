/**
 * Regression: PairClassifier overrides for backtest must stamp pairSlMultiplier
 * once (not also multiply atrMult), and skip when the client already sent them.
 */
"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  applyPairTierToBacktestParams,
  hasExplicitPairTier,
} = require("../src/shared/backtest/applyPairTierToBacktestParams");

describe("applyPairTierToBacktestParams", () => {
  test("stamps pairSlMultiplier without touching atrMult (no double-apply)", () => {
    const { parameters, applied } = applyPairTierToBacktestParams(
      { atrMult: 1.5, riskPerTrade: 0.01 },
      {
        tier: "LIQUID",
        paramOverrides: { slMultiplier: 1.055, positionSizeAdjustment: 1 },
      },
      "MEAN_REVERSION",
    );
    assert.equal(parameters.pairSlMultiplier, 1.055);
    assert.equal(parameters.atrMult, 1.5, "atrMult must stay untouched");
    assert.equal(parameters.pairTier, "LIQUID");
    assert.equal(applied.slMultiplier, 1.055);
  });

  test("scales riskPerTrade when positionSizeAdjustment ≠ 1", () => {
    const { parameters, applied } = applyPairTierToBacktestParams(
      { riskPerTrade: 0.01 },
      { paramOverrides: { positionSizeAdjustment: 0.8 } },
    );
    assert.equal(parameters.riskPerTrade, 0.008);
    assert.equal(applied.positionSizeAdjustment, 0.8);
  });

  test("no-op when classification missing", () => {
    const { parameters, applied } = applyPairTierToBacktestParams({ atrMult: 1.5 }, null);
    assert.equal(parameters.atrMult, 1.5);
    assert.equal(applied, null);
  });
});

describe("hasExplicitPairTier", () => {
  test("detects FE-stamped pairSlMultiplier / pairTier / skip flag", () => {
    assert.equal(hasExplicitPairTier({}), false);
    assert.equal(hasExplicitPairTier({ pairSlMultiplier: 1.055 }), true);
    assert.equal(hasExplicitPairTier({ pairTier: "LIQUID" }), true);
    assert.equal(hasExplicitPairTier({ skipPairTier: true }), true);
  });
});
