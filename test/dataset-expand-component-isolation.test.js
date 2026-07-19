/**
 * Regression: dataset-expand buildConfig pins single-racer isolation for all 12
 * keys and does NOT override BE strategyDefaults geometry (SSOT for UI/live/dry-run).
 */
"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  buildConfig,
  ensureDatasetComponentIsolation,
} = require("../scripts/dataset-expand/lib/runDatasetExpand");
const { DATASET_EXPAND_STRATEGIES } = require("../scripts/dataset-expand/lib/strategyRegistry");
const { STRATEGIES } = require("../src/config/strategyDefaults");

const PRIMARY_ISOLATION = {
  SMART_MONEY_CONCEPTS: { af: ["SMART_MONEY_CONCEPTS"] },
  TREND_FOLLOWING: { ts: ["TREND_FOLLOWING"] },
  MEAN_REVERSION: { md: ["MEAN_REVERSION"] },
  BREAKOUT_RETEST: { bs: ["BREAKOUT_RETEST"] },
};

const SECONDARY_ISOLATION = {
  WYCKOFF: { af: ["WYCKOFF"] },
  VOLUME_SPREAD_ANALYSIS: { af: ["VOLUME_SPREAD_ANALYSIS"] },
  MARKET_STRUCTURE: { ts: ["MARKET_STRUCTURE"] },
  AUCTION_MARKET_THEORY: { ts: ["AUCTION_MARKET_THEORY"] },
  SUPPLY_AND_DEMAND: { md: ["SUPPLY_AND_DEMAND"] },
  STATISTICAL_ARBITRAGE: { md: ["STATISTICAL_ARBITRAGE"] },
  ICT_STYLE_TRADING: { bs: ["ICT_STYLE_TRADING"] },
  LIQUIDATION_SQUEEZE: { bs: ["LIQUIDATION_SQUEEZE"] },
};

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

  test("all 12 dataset-expand keys pin their own racer when unset", () => {
    for (const { key } of DATASET_EXPAND_STRATEGIES) {
      const cfg = ensureDatasetComponentIsolation(key, {});
      assert.deepEqual(cfg.selectedComponents, [key], `${key} selectedComponents`);
      const expect = PRIMARY_ISOLATION[key] || SECONDARY_ISOLATION[key];
      assert.ok(expect, `missing isolation expectation for ${key}`);
      if (expect.af) {
        assert.deepEqual(cfg.afActiveRacers, expect.af, `${key} afActiveRacers`);
      }
      if (expect.ts) {
        assert.deepEqual(cfg.tsActiveRacers, expect.ts, `${key} tsActiveRacers`);
      }
      if (expect.md) {
        assert.deepEqual(cfg.mdActiveRacers, expect.md, `${key} mdActiveRacers`);
      }
      if (expect.bs) {
        assert.deepEqual(cfg.bsActiveRacers, expect.bs, `${key} bsActiveRacers`);
      }
    }
  });
});

describe("buildConfig BE SSOT parity (no FE geometry override)", () => {
  test("non-relax SMART_MONEY_CONCEPTS isolates only — no smc* overrides", () => {
    const cfg = buildConfig("SMART_MONEY_CONCEPTS", "Scalping", false);
    assert.deepEqual(cfg.afActiveRacers, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.afActiveVoters, ["SMART_MONEY_CONCEPTS"]);
    assert.deepEqual(cfg.selectedComponents, ["SMART_MONEY_CONCEPTS"]);
    // Geometry comes from BE resolveStrategyDefaults at job merge — CLI must not
    // stamp research-only FE knobs (former FE_ADVANCE_SMC_PARAMS).
    assert.equal(cfg.smcSweepVolMult, undefined);
    assert.equal(cfg.smcOBDispMult, undefined);
    assert.equal(cfg.smcFvgMinGap, undefined);
    assert.equal(cfg.smcDispVolMult, undefined);
    assert.equal(cfg.typeOverrides, undefined);
  });

  test("buildConfig for each of 12 keys isolates + leaves geometry to BE SSOT", () => {
    for (const { key } of DATASET_EXPAND_STRATEGIES) {
      const cfg = buildConfig(key, "Scalping", false);
      assert.deepEqual(cfg.selectedComponents, [key], `${key} isolation`);
      assert.equal(cfg.typeOverrides, undefined, `${key} must not send typeOverrides`);
      // Must not poison empty overrides or FE-only geometry stamps.
      assert.equal(cfg.smcSweepVolMult, undefined, `${key} no smcSweep override`);
      assert.equal(cfg.maxVolumeRatio, undefined, `${key} no BR floor override`);
      assert.equal(cfg.bbStdDevA, undefined, `${key} no MR bb override`);
    }
  });

  test("BE SSOT entry knobs locked (FE Advance must mirror these)", () => {
    const smc = STRATEGIES.SMART_MONEY_CONCEPTS;
    assert.equal(smc.smcSweepVolMult, 0.9);
    assert.equal(smc.typeOverrides.Scalping.smcSweepVolMult, 1.2);
    assert.equal(smc.typeOverrides.Intraday.smcSweepVolMult, undefined);
    assert.equal(smc.typeOverrides.Swing.smcSweepVolMult, undefined);
    assert.equal(smc.smcOBDispMult, 1.3);
    assert.equal(smc.smcFvgMinGap, 0.0015);
    assert.equal(smc.smcDispVolMult, 1.8);

    const tf = STRATEGIES.TREND_FOLLOWING;
    assert.equal(tf.adxMinStrength, 25);
    assert.equal(tf.atrMultiplier, 1.5);
    assert.equal(tf.htfTrendStrengthMin, undefined);

    const mr = STRATEGIES.MEAN_REVERSION;
    assert.equal(mr.bbStdDevA, 1.5);
    assert.equal(mr.bbStdDevB, 2.0);
    assert.equal(mr.minVolRatio, 0.7);

    const br = STRATEGIES.BREAKOUT_RETEST;
    assert.equal(br.lookbackBars, 20);
    assert.equal(br.maxVolumeRatio, 3.55);
    assert.equal(br.minRetestBars, 16);
    assert.equal(br.minBbWidthPct, 0.0076);
    assert.equal(br.minAtrPct, 0.25);
  });
});
