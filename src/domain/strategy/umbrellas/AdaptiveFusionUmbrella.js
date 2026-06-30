/**
 * AdaptiveFusionUmbrella.js — FOUNDRY Tier umbrella strategy
 *
 * Umbrella key : AF_SAC
 * Active now   : AF_SAC (SmartMoneyConceptsStrategy)
 * Future       : AF_LS, AF_OBR
 *
 * Delegates all signal generation to its active component.
 * When additional components are added, voting logic in
 * UmbrellaStrategy.detectSignal() handles aggregation automatically.
 */

const UmbrellaStrategy           = require("../base/UmbrellaStrategy");
const SmartMoneyConceptsStrategy = require("../implementations/SmartMoneyConceptsStrategy");

class AdaptiveFusionUmbrella extends UmbrellaStrategy {
  constructor() {
    super({
      name:        "AF_SAC",
      label:       "Adaptive Fusion",
      description: "Smart Money Concepts: Liquidity Sweep · Order Block · FVG (Scalping / Intraday / Swing)",
      version:     "2.0.0",
      enabled:     true,
      // 1 component active → threshold irrelevant, but kept for future
      votingThreshold: 0.60,
    });

    this.addComponent("AF_SAC", new SmartMoneyConceptsStrategy());
  }
}

module.exports = AdaptiveFusionUmbrella;
