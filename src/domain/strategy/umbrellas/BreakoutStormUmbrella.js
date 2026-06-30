/**
 * BreakoutStormUmbrella.js — VAULT Tier umbrella strategy
 *
 * Umbrella key : BS_BR
 * Active now   : BS_BR (BreakoutRetestStrategy)
 * Future       : BS_VS, BS_LB
 */

const UmbrellaStrategy       = require("../base/UmbrellaStrategy");
const BreakoutRetestStrategy = require("../implementations/BreakoutRetestStrategy");

class BreakoutStormUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "BS_BR",
      label:       "Breakout Storm",
      description: "Breakout mastery: key-level breakout + retest confirmation",
      version:     "2.0.0",
      enabled:     true,
      votingThreshold: 0.70,
    });

    this.addComponent("BS_BR", new BreakoutRetestStrategy());
  }
}

module.exports = BreakoutStormUmbrella;
