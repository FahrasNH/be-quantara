"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  HTF_MODE,
  getHtfMode,
  requiresHtfDirectionalBlock,
  shouldBlockHtfDirectional,
  applySoftBiasConfidencePenalty,
  SOFT_BIAS_PENALTY,
} = require("../src/config/htfMode");

describe("htfMode SSOT", () => {
  it("maps all 12 live strategies", () => {
    assert.equal(getHtfMode("TREND_FOLLOWING"), HTF_MODE.REQUIRED_ALIGN);
    assert.equal(getHtfMode("MARKET_STRUCTURE"), HTF_MODE.REQUIRED_ALIGN);
    assert.equal(getHtfMode("WYCKOFF"), HTF_MODE.SOFT_BIAS);
    assert.equal(getHtfMode("SUPPLY_AND_DEMAND"), HTF_MODE.SOFT_BIAS);
    assert.equal(getHtfMode("SMART_MONEY_CONCEPTS"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("ICT_STYLE_TRADING"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("BREAKOUT_RETEST"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("LIQUIDATION_SQUEEZE"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("AUCTION_MARKET_THEORY"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("VOLUME_SPREAD_ANALYSIS"), HTF_MODE.CONTEXT_ONLY);
    assert.equal(getHtfMode("MEAN_REVERSION"), HTF_MODE.REGIME_GATE);
    assert.equal(getHtfMode("STATISTICAL_ARBITRAGE"), HTF_MODE.REGIME_GATE);
  });

  it("REQUIRED_ALIGN only triggers engine directional block", () => {
    assert.equal(requiresHtfDirectionalBlock("TREND_FOLLOWING"), true);
    assert.equal(requiresHtfDirectionalBlock("SMART_MONEY_CONCEPTS"), false);
    assert.equal(shouldBlockHtfDirectional("BREAKOUT_RETEST", "LONG", "BEARISH"), false);
    assert.equal(shouldBlockHtfDirectional("TREND_FOLLOWING", "LONG", "BEARISH"), true);
  });

  it("SOFT_BIAS penalty subtracts 15 pts on 0–1 confidence", () => {
    const r = applySoftBiasConfidencePenalty(0.8, "LONG", "BEARISH", SOFT_BIAS_PENALTY);
    assert.equal(r.counterHtf, true);
    assert.equal(r.penaltyApplied, 15);
    assert.equal(r.confidence, 0.65);
  });
});
