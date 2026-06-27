/**
 * ─────────────────────────────────────────────
 * StrategyRegistry.js — Factory Pattern for Strategy Management
 *
 * Centralized registry for all trading strategies.
 * Allows runtime strategy loading, registration, and management.
 * ─────────────────────────────────────────────
 */

const AdaptiveFusionStrategy  = require("./implementations/AdaptiveFusionStrategy");
const TrendMomentumStrategy   = require("./implementations/TrendMomentumStrategy");
const MeanReversionStrategy   = require("./implementations/MeanReversionStrategy");
const BreakoutRetestStrategy  = require("./implementations/BreakoutRetestStrategy");
const GrokAiTradingStrategy   = require("./implementations/GrokAiTradingStrategy");

class StrategyRegistry {
  constructor() {
    this.strategies = new Map();
    this.defaultKey = null;

    this._registerBuiltInStrategies();
  }

  _registerBuiltInStrategies() {
    this.register("ADAPTIVE_FUSION",  new AdaptiveFusionStrategy());
    this.register("TREND_MOMENTUM",   new TrendMomentumStrategy());
    this.register("MEAN_REVERSION",   new MeanReversionStrategy());
    this.register("BREAKOUT_RETEST",  new BreakoutRetestStrategy());
    this.register("GROK_AI_TRADING",  new GrokAiTradingStrategy());
    this.defaultKey = "ADAPTIVE_FUSION";
  }

  /**
   * Register a new strategy
   * @param {string} key - Unique strategy identifier
   * @param {StrategyBase} instance - Strategy instance
   */
  register(key, instance) {
    if (!key || typeof key !== "string") {
      throw new Error("Strategy key must be a non-empty string");
    }
    if (!instance || typeof instance.detectSignal !== "function") {
      throw new Error("Strategy must be a StrategyBase instance");
    }

    this.strategies.set(key, instance);

    if (!this.defaultKey) {
      this.defaultKey = key;
    }

    return this;
  }

  /**
   * Get a strategy by key
   * @param {string} key - Strategy identifier
   * @returns {StrategyBase|null}
   */
  get(key) {
    if (!key) return null;
    return this.strategies.get(key) || null;
  }

  /**
   * Get default strategy
   */
  getDefault() {
    return this.defaultKey ? this.get(this.defaultKey) : null;
  }

  /**
   * List all registered strategies
   */
  listAll() {
    return Array.from(this.strategies.values());
  }

  /**
   * List enabled strategies only
   */
  listEnabled() {
    return this.listAll().filter((s) => s.config.enabled);
  }

  /**
   * Check if strategy exists and is enabled
   */
  validate(key) {
    const strategy = this.get(key);

    if (!strategy) {
      return {
        valid: false,
        error: `Strategy "${key}" not found`,
        available: this.getUIChoices(),
      };
    }

    if (!strategy.config.enabled) {
      return {
        valid: false,
        error: `Strategy "${key}" is disabled`,
        available: this.getUIChoices(),
      };
    }

    return { valid: true, strategy };
  }

  /**
   * Get UI choices (for dropdowns, etc)
   */
  getUIChoices() {
    return this.listEnabled().map((s) => ({
      value: s.config.name,
      label: s.config.label,
      description: s.config.description,
      version: s.config.version,
    }));
  }

  /**
   * Get strategy info for API response
   */
  getInfo(key) {
    const strategy = this.get(key);
    if (!strategy) return null;

    return {
      name: strategy.config.name,
      label: strategy.config.label,
      description: strategy.config.description,
      version: strategy.config.version,
      enabled: strategy.config.enabled,
      riskConfig: strategy.getRiskConfig(),
      timeframeConfig: strategy.getTimeframeConfig(),
    };
  }

  /**
   * Count registered strategies
   */
  count() {
    return this.strategies.size;
  }
}

// Create singleton instance
const strategyRegistry = new StrategyRegistry();

module.exports = { StrategyRegistry, strategyRegistry };
