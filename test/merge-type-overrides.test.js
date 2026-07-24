"use strict";

/**
 * Regression: partial/empty client typeOverrides must not wipe SSOT atrGateRelative.
 * Root cause of via-api SMC Scalping 100% ATR gate rejects after deploy 3236842.
 */

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mergeTypeOverrides,
  mergeBacktestCfg,
  resolveBacktestStrategyDefaults,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");
const { resolveStrategyDefaults } = require("../src/config/strategyDefaults");

describe("mergeTypeOverrides", () => {
  test("empty override keeps base Scalping atrGateRelative", () => {
    const base = {
      Scalping: { atrMinMult: 0.15, atrGateRelative: true, atrRelMin: 0.4, atrRelMax: 4.0 },
      Intraday: { atrMinMult: 0.4 },
      Swing: { atrMinMult: 0.8 },
    };
    const merged = mergeTypeOverrides(base, {});
    assert.equal(merged.Scalping.atrGateRelative, true);
    assert.equal(merged.Scalping.atrMinMult, 0.15);
    assert.equal(merged.Intraday.atrMinMult, 0.4);
    assert.equal(merged.Swing.atrMinMult, 0.8);
  });

  test("partial Scalping {} keeps atrGateRelative (dataset-expand bug)", () => {
    const base = {
      Scalping: { atrMinMult: 0.15, atrGateRelative: true, atrRelMin: 0.4, atrRelMax: 4.0 },
      Intraday: { atrMinMult: 0.4 },
    };
    const merged = mergeTypeOverrides(base, { Scalping: {} });
    assert.equal(merged.Scalping.atrGateRelative, true);
    assert.equal(merged.Scalping.atrMinMult, 0.15);
    assert.equal(merged.Intraday.atrMinMult, 0.4);
  });

  test("client override wins on conflict", () => {
    const merged = mergeTypeOverrides(
      { Scalping: { atrMinMult: 0.15, atrGateRelative: true } },
      { Scalping: { atrMinMult: 0.2 } },
    );
    assert.equal(merged.Scalping.atrMinMult, 0.2);
    assert.equal(merged.Scalping.atrGateRelative, true);
  });
});

describe("mergeBacktestCfg preserves SMC SSOT under FE/CLI poison payloads", () => {
  const feeModel = { makerFeeRate: 0.0002, fundingRate8h: 0 };

  test("FE typeOverrides:{} + atrGateRelative:false still yields relative Scalping gate after leg spread", () => {
    const base = resolveStrategyDefaults("SMART_MONEY_CONCEPTS");
    const cfg = mergeBacktestCfg(base, {
      atrGateRelative: false,
      typeOverrides: {},
      smcMinConfidenceA: 60,
    }, feeModel);

    assert.equal(cfg.typeOverrides.Scalping.atrGateRelative, true);
    assert.equal(cfg.typeOverrides.Scalping.atrMinMult, 0.287);

    const typeConfig = {
      ...cfg,
      ...(cfg.typeOverrides.Scalping || {}),
    };
    assert.equal(typeConfig.atrGateRelative, true);

    const compAtr = cfg.typeOverrides.Scalping || {};
    const gateRelative = compAtr.atrGateRelative ?? typeConfig.atrGateRelative ?? false;
    assert.equal(gateRelative, true);
  });

  test("dataset-expand { Scalping: {} } does not fall back to absolute 0.8 floor", () => {
    const base = resolveStrategyDefaults("SMART_MONEY_CONCEPTS");
    const cfg = mergeBacktestCfg(base, { typeOverrides: { Scalping: {} } }, feeModel);
    assert.equal(cfg.typeOverrides.Scalping.atrGateRelative, true);
    assert.equal(cfg.typeOverrides.Intraday.atrMinMult, 0.4);
    assert.equal(cfg.typeOverrides.Swing.atrMinMult, 0.8);
  });
});

describe("resolveBacktestStrategyDefaults — Sprint 23 VSA leg merge", () => {
  test("FE collapse VSA-only → SMART_MONEY_CONCEPTS engine gets VSA typeOverrides", () => {
    const cfg = resolveBacktestStrategyDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["VOLUME_SPREAD_ANALYSIS"],
      selectedComponents: ["VOLUME_SPREAD_ANALYSIS"],
    });
    assert.equal(cfg.typeOverrides.Scalping.vsaScalpingShelved, true);
    assert.equal(cfg.typeOverrides.Scalping.vsaSessionFilter, true);
    assert.equal(cfg.typeOverrides.Swing.vsaSwingLongOnly, true);
    assert.equal(cfg.typeOverrides.Swing.vsaMinConfidenceSwing, 60);
  });

  test("full FOUNDRY AF merges VSA gates into SMC base without dropping smc knobs", () => {
    const cfg = resolveBacktestStrategyDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
      selectedComponents: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
    });
    assert.equal(cfg.typeOverrides.Scalping.smcSessionFilter, true);
    assert.equal(cfg.typeOverrides.Scalping.vsaScalpingShelved, true);
    assert.equal(cfg.typeOverrides.Swing.vsaSwingLongOnly, true);
  });

  test("SMC-only job does not inject VSA shelve gate", () => {
    const cfg = resolveBacktestStrategyDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["SMART_MONEY_CONCEPTS"],
      selectedComponents: ["SMART_MONEY_CONCEPTS"],
    });
    assert.equal(cfg.typeOverrides.Scalping.smcSessionFilter, true);
    assert.equal(cfg.typeOverrides.Scalping.vsaScalpingShelved, undefined);
  });

  test("standalone VOLUME_SPREAD_ANALYSIS key unchanged", () => {
    const cfg = resolveBacktestStrategyDefaults("VOLUME_SPREAD_ANALYSIS", {});
    assert.equal(cfg.typeOverrides.Scalping.vsaScalpingShelved, true);
  });
});
