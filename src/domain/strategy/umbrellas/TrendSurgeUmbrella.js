/**
 * TrendSurgeUmbrella.js — FORGE Tier umbrella strategy
 *
 * Umbrella key : TS_TM
 * Active now   : TS_TM (TrendMomentumStrategy)
 * Future       : TS_EE, TS_MTF
 */

const UmbrellaStrategy      = require("../base/UmbrellaStrategy");
const TrendMomentumStrategy = require("../implementations/TrendMomentumStrategy");

class TrendSurgeUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "TS_TM",
      label:       "Trend Surge",
      description: "Momentum-driven trend following with EMA + RSI confirmation",
      version:     "2.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this.addComponent("TS_TM", new TrendMomentumStrategy());
  }
}

module.exports = TrendSurgeUmbrella;
