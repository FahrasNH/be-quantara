/**
 * ─────────────────────────────────────────────
 * StrategyBase.js — Abstract Base Class for Trading Strategies
 *
 * All trading strategies must extend this class and implement
 * the required methods. This ensures consistency and allows
 * the bot to work with any strategy interchangeably.
 * ─────────────────────────────────────────────
 */

class StrategyBase {
  constructor(config = {}) {
    if (new.target === StrategyBase) {
      throw new TypeError("Cannot instantiate abstract class StrategyBase");
    }

    this.config = {
      name: config.name || "UNKNOWN_STRATEGY",
      label: config.label || "Unknown Strategy",
      description: config.description || "",
      version: config.version || "1.0.0",
      enabled: config.enabled !== false,
      ...config,
    };
  }

  /**
   * ─────────────────────────────────────────────
   * REQUIRED METHODS (must be implemented by subclass)
   * ─────────────────────────────────────────────
   */

  /**
   * Rank this strategy based on current market conditions
   * Returns: 0-100 score (higher = better fit for current market)
   *
   * @param {Object} marketConditions - { volatility, trend_strength, volume, etc }
   * @returns {number} 0-100 ranking score
   */
  rankByMarketConditions(marketConditions = {}) {
    throw new Error(`${this.config.name}.rankByMarketConditions() not implemented`);
  }

  /**
   * Check if strategy can activate given current state
   * Returns: { allowed: boolean, reason: string }
   *
   * @param {number} balance - Current account balance
   * @param {string} htfTrend - Higher timeframe trend (BULLISH|BEARISH|NEUTRAL)
   * @param {number} volatility - Current volatility level
   * @returns {Object} { allowed: bool, reason: string }
   */
  canActivate(balance, htfTrend, volatility) {
    throw new Error(`${this.config.name}.canActivate() not implemented`);
  }

  /**
   * Detect entry signal based on indicators
   * Returns: "LONG" | "SHORT" | null
   *
   * @param {Object} indicators - { closes, ema, rsi, atr, etc }
   * @param {number} lastIdx - Current candle index
   * @param {Object} config - Strategy configuration
   * @returns {string|null} "LONG" or "SHORT" or null (no signal)
   */
  detectSignal(indicators, lastIdx, config = {}) {
    throw new Error(`${this.config.name}.detectSignal() not implemented`);
  }

  /**
   * Get risk management configuration for this strategy
   * Returns: { riskPerTrade, maxDailyLoss, maxTradesPerDay, etc }
   *
   * @returns {Object} Risk configuration object
   */
  getRiskConfig() {
    throw new Error(`${this.config.name}.getRiskConfig() not implemented`);
  }

  /**
   * Get timeframe configuration for this strategy
   * Returns: { interval, higherTf, checkInterval }
   *
   * @returns {Object} Timeframe configuration
   */
  getTimeframeConfig() {
    throw new Error(`${this.config.name}.getTimeframeConfig() not implemented`);
  }

  /**
   * Validate if market conditions are suitable for entry
   * Returns: { valid: boolean, reason: string }
   *
   * @param {number} price - Current price
   * @param {number} atr - Current ATR
   * @param {number} volume - Current volume
   * @param {number} volSMA - Volume SMA
   * @returns {Object} { valid: bool, reason: string }
   */
  validateEntry(price, atr, volume, volSMA) {
    throw new Error(`${this.config.name}.validateEntry() not implemented`);
  }

  /**
   * ─────────────────────────────────────────────
   * OPTIONAL LIFECYCLE HOOKS
   * ─────────────────────────────────────────────
   */

  /**
   * Called when this strategy becomes active
   */
  onStrategyActivated() {}

  /**
   * Called when this strategy is deactivated
   */
  onStrategyDeactivated() {}

  /**
   * Called before entry signal is executed
   * Return false to veto the trade
   */
  onBeforeEntry(signal, price, atr) {
    return true;
  }

  /**
   * Called after trade exits
   */
  onAfterExit(trade) {}

  /**
   * ─────────────────────────────────────────────
   * UTILITY METHODS (can be used by subclasses)
   * ─────────────────────────────────────────────
   */

  /**
   * Get metadata about this strategy
   */
  getMetadata() {
    return {
      name: this.config.name,
      label: this.config.label,
      description: this.config.description,
      version: this.config.version,
      enabled: this.config.enabled,
    };
  }

  /**
   * Validate required indicator data exists
   */
  validateIndicators(indicators, requiredFields = []) {
    const defaults = ["closes", "atr", "rsi"];
    const fieldsToCheck = requiredFields.length > 0 ? requiredFields : defaults;

    for (const field of fieldsToCheck) {
      if (!indicators[field] || indicators[field].length === 0) {
        return { valid: false, missing: field };
      }
    }
    return { valid: true };
  }

  /**
   * Clamp value between min and max
   */
  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

module.exports = StrategyBase;
