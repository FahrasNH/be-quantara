/**
 * TrendSurgeUmbrella.js — FORGE Tier umbrella strategy
 *
 * Umbrella key : TS_TF
 * Active now   : TS_TF (TrendFollowingStrategy)
 * Future       : TS_EW (Elliott Wave), TS_PA (Price Action)
 */

const UmbrellaStrategy       = require("../base/UmbrellaStrategy");
const TrendFollowingStrategy = require("../implementations/TrendFollowingStrategy");

class TrendSurgeUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "TS_TF",
      label:       "Trend Surge",
      description: "Trend following via EMA/SMA, Donchian Channel, ADX, and ATR. Enters on confirmed breakout with pullback retest.",
      version:     "1.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this.addComponent("TS_TF", new TrendFollowingStrategy());
  }
}

module.exports = TrendSurgeUmbrella;
