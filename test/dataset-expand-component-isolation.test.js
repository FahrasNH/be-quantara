/**
 * Regression: smart-money-concepts dataset-expand must pin SMC-only racers
 * AND send FE Advance factory geometry (not bare BE SSOT).
 *
 * Without isolation, AdaptiveFusionUmbrella races all three and VSA floods the CSV.
 * Without FE geometry, CLI over-fires (~77) vs UI Advance (~25) on the same 90d window.
 */
"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  buildConfig,
  ensureDatasetComponentIsolation,
  FE_ADVANCE_SMC_PARAMS,
} = require("../scripts/dataset-expand/lib/runDatasetExpand");

describe("ensureDatasetComponentIsolation", () => {
  test("SMART_MONEY_CONCEPTS pins afActiveRacers + afActiveVoters to SMC only", () => {
    const cfg = ensureDatasetComponentIsolation("SMART_MONEY_CONCEPTS", {});
    assert.deepEqual(cfg.afActiveRacers, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.afActiveVoters, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.selectedComponents, ["SMART_MONEY_CONCEPTS"]);
  });

  test("respects explicit FOUNDRY multi-racer selection", () => {
    const racers = ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"];
    const cfg = ensureDatasetComponentIsolation("SMART_MONEY_CONCEPTS", {
      selectedComponents: racers,
    });
    assert.equal(cfg.afActiveRacers, undefined);
    assert.deepEqual(cfg.selectedComponents, racers);
  });

  test("TREND_FOLLOWING / MEAN_REVERSION / BREAKOUT_RETEST pin primary racer", () => {
    assert.deepEqual(
      ensureDatasetComponentIsolation("TREND_FOLLOWING", {}).tsActiveRacers,
      ["TREND_FOLLOWING"],
    );
    assert.deepEqual(
      ensureDatasetComponentIsolation("MEAN_REVERSION", {}).mdActiveRacers,
      ["MEAN_REVERSION"],
    );
    assert.deepEqual(
      ensureDatasetComponentIsolation("BREAKOUT_RETEST", {}).bsActiveRacers,
      ["BREAKOUT_RETEST"],
    );
  });
});

describe("buildConfig SMC FE Advance parity", () => {
  test("non-relax SMART_MONEY_CONCEPTS isolates SMC + mirrors FE geometry", () => {
    const cfg = buildConfig("SMART_MONEY_CONCEPTS", "Scalping", false);
    assert.deepEqual(cfg.afActiveRacers, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.afActiveVoters, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.selectedComponents, ["SMART_MONEY_CONCEPTS"]);

    // Lock the knobs that caused CLI 77 ≠ UI 25 (FE Sprint 14 factory reset).
    assert.equal(cfg.smcSweepVolMult, FE_ADVANCE_SMC_PARAMS.smcSweepVolMult);
    assert.equal(cfg.smcOBDispMult, FE_ADVANCE_SMC_PARAMS.smcOBDispMult);
    assert.equal(cfg.smcFvgMinGap, FE_ADVANCE_SMC_PARAMS.smcFvgMinGap);
    assert.equal(cfg.smcDispVolMult, FE_ADVANCE_SMC_PARAMS.smcDispVolMult);
    assert.equal(cfg.smcMinConfidenceA, 60);
    assert.equal(cfg.smcSweepVolMult, 1.3);
    assert.equal(cfg.smcOBDispMult, 1.8);
    assert.equal(cfg.smcFvgMinGap, 0.003);
    // Must NOT wipe BE SSOT atrGateRelative via empty typeOverrides.
    assert.equal(cfg.typeOverrides, undefined);
  });

  test("FE_ADVANCE_SMC_PARAMS stays stricter than bare BE live SSOT geometry", () => {
    // Document the intentional FE↔BE divergence so a future "sync to SSOT"
    // change cannot silently break UI parity without updating this test.
    assert.ok(FE_ADVANCE_SMC_PARAMS.smcSweepVolMult > 0.9, "FE sweep stricter than BE 0.9");
    assert.ok(FE_ADVANCE_SMC_PARAMS.smcOBDispMult > 1.3, "FE OB disp stricter than BE 1.3");
    assert.ok(FE_ADVANCE_SMC_PARAMS.smcFvgMinGap > 0.0015, "FE FVG gap stricter than BE 0.0015");
  });
});
