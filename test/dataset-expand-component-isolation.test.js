/**
 * Regression: smart-money-concepts dataset-expand must pin SMC-only racers.
 * Without isolation, AdaptiveFusionUmbrella races all three and VSA floods the CSV
 * (116 trades vs UI SMC-only ~25 on a longer window).
 */
"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  buildConfig,
  ensureDatasetComponentIsolation,
} = require("../scripts/dataset-expand/lib/runDatasetExpand");

describe("ensureDatasetComponentIsolation", () => {
  test("SMART_MONEY_CONCEPTS pins afActiveRacers to SMC only", () => {
    const cfg = ensureDatasetComponentIsolation("SMART_MONEY_CONCEPTS", {});
    assert.deepEqual(cfg.afActiveRacers, ["SMART_MONEY_CONCEPTS"]);
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

describe("buildConfig SMC", () => {
  test("non-relax SMART_MONEY_CONCEPTS isolates SMC (FE Advance parity)", () => {
    const cfg = buildConfig("SMART_MONEY_CONCEPTS", "Scalping", false);
    assert.deepEqual(cfg.afActiveRacers, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.selectedComponents, ["SMART_MONEY_CONCEPTS"]);
  });
});
