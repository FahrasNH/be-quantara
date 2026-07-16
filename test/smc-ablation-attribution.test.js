/**
 * smc-ablation-attribution.test.js — Defect B fix (2026-07-16)
 *
 * The AF umbrella shares ONE SMC component across all racers; its
 * detectSignalMulti runs SMC's sequence every bar (incrementing SMC ablation
 * counters) and getAblation() always delegates to SMC — even for WYCKOFF/VSA-only
 * jobs. So the "Scalping filter funnel" numbers are real SMC counters that must
 * NOT be attributed to a non-SMC racer.
 *
 * smcAblationApplies() is the SSOT gate for the 3 funnel print sites (server job,
 * via-api CLI, inline logger). It must be true ONLY when SMC actually races.
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { smcAblationApplies } = require("../src/modules/backtest/services/RealStrategyBacktestService");

test("emit for pure SMART_MONEY_CONCEPTS and default AF (all racers)", () => {
  assert.equal(smcAblationApplies("SMART_MONEY_CONCEPTS", {}), true);
  assert.equal(smcAblationApplies("ADAPTIVE_FUSION", {}), true);
  assert.equal(smcAblationApplies("ADAPTIVE_FUSION", { afActiveRacers: [] }), true);
});

test("emit when SMC is among the active racers/voters", () => {
  assert.equal(smcAblationApplies("ADAPTIVE_FUSION", { afActiveRacers: ["SMART_MONEY_CONCEPTS", "WYCKOFF"] }), true);
  assert.equal(smcAblationApplies("SMART_MONEY_CONCEPTS", { afActiveVoters: ["SMC"] }), true);
  assert.equal(smcAblationApplies("ADAPTIVE_FUSION", { selectedComponents: ["AF_SMC"] }), true, "legacy AF_SMC alias → SMC");
});

test("DO NOT emit for standalone WYCKOFF / VSA keys", () => {
  assert.equal(smcAblationApplies("WYCKOFF", {}), false);
  assert.equal(smcAblationApplies("VOLUME_SPREAD_ANALYSIS", {}), false);
  assert.equal(smcAblationApplies("WYCKOFF", { afActiveRacers: ["WYCKOFF"] }), false);
});

test("EDGE: FE collapses WYCKOFF → SMC key + afActiveRacers/afActiveVoters:['WYCKOFF'] → NO funnel", () => {
  assert.equal(smcAblationApplies("SMART_MONEY_CONCEPTS", { afActiveRacers: ["WYCKOFF"] }), false);
  assert.equal(smcAblationApplies("SMART_MONEY_CONCEPTS", { afActiveVoters: ["WYCKOFF"] }), false);
  assert.equal(smcAblationApplies("ADAPTIVE_FUSION", { afActiveVoters: ["WYCKOFF", "VOLUME_SPREAD_ANALYSIS"] }), false);
  assert.equal(smcAblationApplies("SMART_MONEY_CONCEPTS", { selectedComponents: ["WYCKOFF"] }), false);
});

test("non SMC/AF keys never emit", () => {
  assert.equal(smcAblationApplies("TREND_FOLLOWING", {}), false);
  assert.equal(smcAblationApplies("MEAN_REVERSION", { afActiveRacers: ["SMART_MONEY_CONCEPTS"] }), false);
});
