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

// Registry & Factory
const { StrategyRegistry, strategyRegistry } = require("./StrategyRegistry");

module.exports = {
  // Classes
  StrategyBase,
  AdaptiveFusionStrategy,
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
