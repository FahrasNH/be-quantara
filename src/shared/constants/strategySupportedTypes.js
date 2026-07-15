/**
 * STRATEGY_SUPPORTED_TYPES — which trade types each strategy supports.
 * Used for FE dropdown filtering and BE validation.
 *
 * Sprint 14 factory reset: EVERY strategy now exposes all 3 trade types
 * (Scalping / Intraday / Swing) uniformly, regardless of per-leg profitability
 * ("apapun hasilnya" — product decision for consistent UX). Legs that have not
 * passed the 5-window walk-forward gate are Advance-backtest-only and are NOT
 * auto-enabled for live tier packages — the live routing gate (liveTradeTypeGate.js)
 * restricts which of these types may actually trade real money.
 *
 * Trade-type timeframes (runBacktestJob.TYPE_TF): Scalping 5m/1h, Intraday
 * 15m/4h, Swing 4h/1w. Concept + indicators per strategy: strategyRecapCatalog.js.
 */

const ALL_THREE_TYPES = ["Scalping", "Intraday", "Swing"];

const STRATEGY_SUPPORTED_TYPES = {
  SMART_MONEY_CONCEPTS: ALL_THREE_TYPES,
  WYCKOFF: ALL_THREE_TYPES,
  VOLUME_SPREAD_ANALYSIS: ALL_THREE_TYPES,
  TREND_FOLLOWING: ALL_THREE_TYPES,
  MARKET_STRUCTURE: ALL_THREE_TYPES,
  AUCTION_MARKET_THEORY: ALL_THREE_TYPES,
  MEAN_REVERSION: ALL_THREE_TYPES,
  SUPPLY_AND_DEMAND: ALL_THREE_TYPES,
  STATISTICAL_ARBITRAGE: ALL_THREE_TYPES,
  BREAKOUT_RETEST: ALL_THREE_TYPES,
  ICT_STYLE_TRADING: ALL_THREE_TYPES,
  LIQUIDATION_SQUEEZE: ALL_THREE_TYPES,
};

/**
 * Validate that typeOrder only contains supported types for the strategy.
 * @param {string} strategyKey - e.g. "SMART_MONEY_CONCEPTS"
 * @param {Array<string>} typeOrder - e.g. ["Scalping", "Swing"]
 * @returns {Object} { valid: boolean, error?: string }
 */
function validateTypeOrderForStrategy(strategyKey, typeOrder) {
  const supported = STRATEGY_SUPPORTED_TYPES[strategyKey];
  if (!supported) {
    return { valid: false, error: `Unknown strategy: ${strategyKey}` };
  }
  if (!Array.isArray(typeOrder) || typeOrder.length === 0) {
    return { valid: false, error: "typeOrder must be a non-empty array" };
  }
  const unsupported = typeOrder.filter(t => !supported.includes(t));
  if (unsupported.length > 0) {
    return {
      valid: false,
      error: `${strategyKey} does not support type(s): ${unsupported.join(", ")}. Supported: ${supported.join(", ")}`,
    };
  }
  return { valid: true };
}

/**
 * Map "All" to actual supported types for the strategy.
 * @param {string} strategyKey
 * @param {Array<string>} typeOrder - may contain "All"
 * @returns {Array<string>} expanded type order
 */
function expandAllTypes(strategyKey, typeOrder) {
  if (!typeOrder.includes("All")) {
    return typeOrder;
  }
  const supported = STRATEGY_SUPPORTED_TYPES[strategyKey] || [];
  return typeOrder.map(t => t === "All" ? supported : t).flat();
}

module.exports = {
  STRATEGY_SUPPORTED_TYPES,
  validateTypeOrderForStrategy,
  expandAllTypes,
};
