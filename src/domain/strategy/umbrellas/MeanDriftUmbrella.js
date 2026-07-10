/**
 * MeanDriftUmbrella.js — MINT Tier umbrella strategy
 *
 * Umbrella key : MD_MR
 * Active now   : MD_MR (MeanReversionStrategy — layered A→B→C pipeline)
 * Future       : MD_BB, MD_RD (possible race participants later)
 *
 * Unlike AF/TS race-to-confirm pools, Mean Drift currently runs a single
 * live key (MD_MR) with internal layers:
 *   A — BB+RSI mean reversion signal
 *   B — ADX Trend Strength Filter regime gate (MD-SUB-01)
 *   C — Order Block + FVG entry/TP precision (MD-SUB-02)
 */

const UmbrellaStrategy     = require("../base/UmbrellaStrategy");
const MeanReversionStrategy = require("../implementations/MeanReversionStrategy");

class MeanDriftUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "MD_MR",
      label:       "Mean Drift",
      description:
        "Precision mean reversion: BB+RSI entry gated by ADX Trend Strength Filter, refined by Order Block/FVG",
      version:     "3.0.0",
      enabled:     true,
      votingThreshold: 0.65,
    });

    this.addComponent("MD_MR", new MeanReversionStrategy());
  }
}

module.exports = MeanDriftUmbrella;
