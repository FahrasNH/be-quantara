"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  AMT_SCALPING_SHELVED,
  resolveTradeType,
  isAmtScalpingShelved,
  filterDisabledTradeTypes,
} = require("../src/config/tradeTypeAvailability");
const {
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileComponent,
  evaluateVolumeProfileEntry,
} = require("../src/core/strategy-engine/ts/volumeProfileEntry");
const TrendSurgeUmbrella = require("../src/core/strategy-engine/umbrellas/TrendSurgeUmbrella");
const { STRATEGY_SUPPORTED_TYPES } = require("../src/shared/constants/strategySupportedTypes");
const { MULTI_TYPE_STRATEGY_MAP } = require("../src/modules/backtest/services/runBacktestJob");

describe("AMT Scalping availability", () => {
  test("resolves Scalping from explicit type and 5m runtime config", () => {
    assert.equal(AMT_SCALPING_SHELVED, true);
    assert.equal(resolveTradeType({ tradeType: "A" }), "Scalping");
    assert.equal(resolveTradeType({ activeComponents: ["Scalping"] }), "Scalping");
    assert.equal(resolveTradeType({ entryTf: "5m" }), "Scalping");
    assert.equal(isAmtScalpingShelved({ interval: "5m" }), true);
    assert.equal(isAmtScalpingShelved({ interval: "15m" }), false);
  });

  test("AMT backtest catalog exposes only Intraday and Swing", () => {
    assert.deepEqual(STRATEGY_SUPPORTED_TYPES.AUCTION_MARKET_THEORY, ["Intraday", "Swing"]);
    assert.deepEqual(MULTI_TYPE_STRATEGY_MAP.AUCTION_MARKET_THEORY, ["Intraday", "Swing"]);
    assert.deepEqual(
      filterDisabledTradeTypes("AUCTION_MARKET_THEORY", ["Scalping", "Intraday", "Swing"]),
      ["Intraday", "Swing"],
    );
    assert.deepEqual(
      filterDisabledTradeTypes("TREND_FOLLOWING", ["Scalping", "Intraday", "Swing"]),
      ["Scalping", "Intraday", "Swing"],
    );
  });

  test("all direct AMT evaluator paths fail closed for Scalping", () => {
    const config = { tradeType: "Scalping" };
    const ablation = { evaluated: 0, rejScalpingShelved: 0 };
    const entry = evaluateVolumeProfileEntry({}, 0, { ...config, ablation });
    const component = evaluateVolumeProfileComponent({}, 0, config);
    const precision = evaluateVolumeProfilePrecision({}, 0, "LONG", config);

    assert.equal(entry.reason, "amt_scalping_shelved");
    assert.equal(entry.signal, null);
    assert.equal(component.reason, "amt_scalping_shelved");
    assert.equal(precision.reason, "amt_scalping_shelved");
    assert.equal(precision.allowed, false);
    assert.equal(ablation.evaluated, 1);
    assert.equal(ablation.rejScalpingShelved, 1);
  });

  test("Trend Surge removes only AMT from its Scalping race leg", () => {
    const umbrella = new TrendSurgeUmbrella();
    let vpCalled = false;
    umbrella._tf.detectSignal = () => "LONG";
    umbrella._tf.getLastSignalMeta = () => ({ confidence: 0.6, reason: "tf" });
    umbrella._ms.detectSignal = () => null;
    umbrella._ms.getLastSignalMeta = () => ({ confidence: 0, reason: "ms_no_signal" });
    umbrella._vp.detectSignal = () => {
      vpCalled = true;
      return "SHORT";
    };

    const signal = umbrella.detectSignal({ closes: [100] }, 0, {
      entryTf: "5m",
      tradeType: "Scalping",
      tsCombinationMode: "race",
      selectedComponents: ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"],
    });

    assert.equal(signal, "LONG");
    assert.equal(vpCalled, false);
    assert.deepEqual(umbrella.getLastRaceMeta().activeRacers, ["TREND_FOLLOWING", "MARKET_STRUCTURE"]);
    assert.equal(umbrella.getLastRaceMeta().signalComponents.AUCTION_MARKET_THEORY, "DISABLED");
  });
});
