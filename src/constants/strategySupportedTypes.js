/**
 * STRATEGY_SUPPORTED_TYPES — which trade types each strategy supports.
 * Used for FE dropdown filtering and BE validation.
 *
 * (1h redesign, 15m restructure, entry-swap, custom gate). Hidden from UI.
 *
 * TS_TF (Trend Following): runs Intraday+Swing only (avoids 5m fetch fragility).
 * MD_MR (Mean Reversion): runs Scalping+Intraday (no Swing).
 * BS_BR (Breakout Retest): all 3 supported.
 */

const STRATEGY_SUPPORTED_TYPES = {
  AF_SMC: ["Scalping", "Swing"],
  TS_TF: ["Intraday", "Swing"],            // Scalping removed to avoid 5m fetch failure
  MD_MR: ["Scalping", "Intraday"],         // Swing not applicable (mean reversion short-term only)
  BS_BR: ["Scalping", "Intraday", "Swing"], // Breakout works on all timeframes
};

/**
 * Validate that typeOrder only contains supported types for the strategy.
 * @param {string} strategyKey - e.g. "AF_SMC"
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
