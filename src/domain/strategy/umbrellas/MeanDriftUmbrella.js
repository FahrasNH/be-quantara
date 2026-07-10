/**
 * MeanDriftUmbrella.js — MINT Tier umbrella strategy
 *
 * Umbrella key : MD_MR
 * Active now   : MD_MR (MeanReversionStrategy)
 * Future       : MD_BB, MD_RD
 */

const UmbrellaStrategy     = require("../base/UmbrellaStrategy");
const MeanReversionStrategy = require("../implementations/MeanReversionStrategy");

class MeanDriftUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "MD_MR",
      label:       "Mean Drift",
      description: "Precision mean reversion with Bollinger Bands and RSI extremes",
      version:     "2.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this.addComponent("MD_MR", new MeanReversionStrategy());
  }
}

module.exports = MeanDriftUmbrella;
