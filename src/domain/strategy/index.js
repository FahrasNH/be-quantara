/**
 * ─────────────────────────────────────────────
 * Strategy System — Main Export
 *
 * Central point for importing strategy-related modules
 * ─────────────────────────────────────────────
 */

// Base class
const StrategyBase = require("./base/StrategyBase");

// Implementations
const AdaptiveFusionStrategy = require("./implementations/AdaptiveFusionStrategy");
const TrendMomentumStrategy  = require("./implementations/TrendMomentumStrategy");
const MeanReversionStrategy  = require("./implementations/MeanReversionStrategy");
const BreakoutRetestStrategy = require("./implementations/BreakoutRetestStrategy");

// Registry & Factory
const { StrategyRegistry, strategyRegistry } = require("./StrategyRegistry");

module.exports = {
  // Classes
  StrategyBase,
  AdaptiveFusionStrategy,
  TrendMomentumStrategy,
  MeanReversionStrategy,
  BreakoutRetestStrategy,
  StrategyRegistry,

  // Singleton instance
  strategyRegistry,

  // Convenience methods
  getStrategy: (key) => strategyRegistry.get(key),
  getDefaultStrategy: () => strategyRegistry.getDefault(),
  listStrategies: () => strategyRegistry.listAll(),
  listEnabledStrategies: () => strategyRegistry.listEnabled(),
  registerStrategy: (key, instance) => strategyRegistry.register(key, instance),
  validateStrategy: (key) => strategyRegistry.validate(key),
};
