"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  extractStrategyConfigOverrides,
  mergeBotStartOverrides,
} = require("../src/modules/trading/services/botConfigMerge");

describe("botConfigMerge", () => {
  test("extractStrategyConfigOverrides reads nested strategy params", () => {
    const out = extractStrategyConfigOverrides(
      {
        SMART_MONEY_CONCEPTS: { smcMinConfidenceA: 70, atrMinMult: 0.2 },
        MEAN_REVERSION: { rsiLongMin: 20 },
      },
      "SMART_MONEY_CONCEPTS",
    );
    assert.equal(out.smcMinConfidenceA, 70);
    assert.equal(out.atrMinMult, 0.2);
    assert.equal(out.rsiLongMin, undefined);
  });

  test("mergeBotStartOverrides applies strategy params before explicit bot fields", () => {
    const merged = mergeBotStartOverrides({
      dbConfigOverrides: {
        MEAN_REVERSION: { capital: 999, rsiLongMin: 18, atrMinMult: 0.3 },
      },
      strategyKey: "MEAN_REVERSION",
      explicit: {
        capital: 500,
        dryRun: true,
        tpMode: "partial",
        strategyKey: "MEAN_REVERSION",
        symbol: "BTCUSDT",
      },
    });
    assert.equal(merged.rsiLongMin, 18);
    assert.equal(merged.atrMinMult, 0.3);
    assert.equal(merged.capital, 500);
    assert.equal(merged.dryRun, true);
    assert.equal(merged.tpMode, "partial");
    assert.equal(merged.symbol, "BTCUSDT");
  });

  test("mergeBotStartOverrides ignores unknown flat root keys", () => {
    const merged = mergeBotStartOverrides({
      dbConfigOverrides: { flatKnob: 1 },
      strategyKey: "MEAN_REVERSION",
      explicit: { strategyKey: "MEAN_REVERSION" },
    });
    assert.equal(merged.flatKnob, undefined);
  });
});
