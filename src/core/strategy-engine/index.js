/**
 * Strategy System — Main Export (v2.0 Umbrella Architecture)
 *
 * Central point for importing strategy-related modules.
 */

// Base classes
const StrategyBase     = require("./base/StrategyBase");
const UmbrellaStrategy = require("./base/UmbrellaStrategy");

// Component implementations
const SmartMoneyConceptsStrategy = require("./implementations/SmartMoneyConceptsStrategy");
const WyckoffStrategy            = require("./implementations/WyckoffStrategy");
const VsaStrategy                = require("./implementations/VsaStrategy");
const TrendFollowingStrategy     = require("./implementations/TrendFollowingStrategy");
const MarketStructureStrategy    = require("./implementations/MarketStructureStrategy");
const VolumeProfileStrategy      = require("./implementations/VolumeProfileStrategy");
const MeanReversionStrategy      = require("./implementations/MeanReversionStrategy");
const SupplyDemandStrategy       = require("./implementations/SupplyDemandStrategy");
const StatisticalArbitrageStrategy = require("./implementations/StatisticalArbitrageStrategy");
const BreakoutTradingStrategy    = require("./implementations/BreakoutTradingStrategy");
const IctStyleStrategy           = require("./implementations/IctStyleStrategy");
const LiquidationSqueezeStrategy = require("./implementations/LiquidationSqueezeStrategy");
const GrokAiTradingStrategy      = require("./implementations/GrokAiTradingStrategy");

// Umbrella wrappers
const AdaptiveFusionUmbrella = require("./umbrellas/AdaptiveFusionUmbrella");
const TrendSurgeUmbrella     = require("./umbrellas/TrendSurgeUmbrella");
const MeanDriftUmbrella      = require("./umbrellas/MeanDriftUmbrella");
const BreakoutStormUmbrella  = require("./umbrellas/BreakoutStormUmbrella");

// Registry
const { StrategyRegistry, strategyRegistry } = require("./StrategyRegistry");

module.exports = {
  // Base classes
  StrategyBase,
  UmbrellaStrategy,

  // Component implementations
  SmartMoneyConceptsStrategy,
  WyckoffStrategy,
  VsaStrategy,
  TrendFollowingStrategy,
  MarketStructureStrategy,
  VolumeProfileStrategy,
  MeanReversionStrategy,
  SupplyDemandStrategy,
  StatisticalArbitrageStrategy,
  BreakoutTradingStrategy,
  IctStyleStrategy,
  LiquidationSqueezeStrategy,
  GrokAiTradingStrategy,

  // Umbrella wrappers
  AdaptiveFusionUmbrella,
  TrendSurgeUmbrella,
  MeanDriftUmbrella,
  BreakoutStormUmbrella,

  // Registry
  StrategyRegistry,
  strategyRegistry,

  // Convenience methods
  getStrategy:           (key) => strategyRegistry.get(key),
  getDefaultStrategy:    ()    => strategyRegistry.getDefault(),
  listStrategies:        ()    => strategyRegistry.listAll(),
  listEnabledStrategies: ()    => strategyRegistry.listEnabled(),
  registerStrategy:      (key, instance) => strategyRegistry.register(key, instance),
  validateStrategy:      (key) => strategyRegistry.validate(key),
};
