/**
 * scalp-geometry-engine.test.js — MR/BR respect typeOverrides slAtrMult/tpAtrMult via opts
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const MeanReversionStrategy = require("../src/core/strategy-engine/implementations/MeanReversionStrategy");
const BreakoutTradingStrategy = require("../src/core/strategy-engine/implementations/BreakoutTradingStrategy");
const { SCALP_GEOMETRY } = require("../src/config/strategyDefaults");

test("MR calculateRiskConfig: Scalping opts yield Planned RR 2.0", () => {
  const mr = new MeanReversionStrategy();
  const rc = mr.calculateRiskConfig(100, 1, "LONG", "Scalping", {
    slMultiplier: SCALP_GEOMETRY.slAtrMult,
    tpMultiplier: SCALP_GEOMETRY.tpAtrMult,
  });
  assert.equal(rc.riskReward, 2);
  assert.equal(rc.slDistance, 1.5);
  assert.equal(rc.tpDistance, 3);
});

test("BR calculateRiskConfig: Scalping opts pass sl/tp multipliers", () => {
  const br = new BreakoutTradingStrategy();
  const rc = br.calculateRiskConfig(100, 1, "LONG", "Scalping", {
    slMultiplier: SCALP_GEOMETRY.slAtrMult,
    tpMultiplier: SCALP_GEOMETRY.tpAtrMult,
  });
  assert.equal(rc.slMultiplier, 1.5);
  assert.equal(rc.tpMultiplier, 3);
  assert.ok(rc.riskReward >= 1.5 && rc.riskReward <= 2.0, `RR ${rc.riskReward} in 1.5–2.0 band`);
});
