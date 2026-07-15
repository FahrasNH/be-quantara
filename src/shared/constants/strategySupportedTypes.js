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
  AF_SMC: ALL_THREE_TYPES,
  AF_WYCKOFF: ALL_THREE_TYPES,
  AF_VSA: ALL_THREE_TYPES,
  TS_TF: ALL_THREE_TYPES,
  TS_MS: ALL_THREE_TYPES,
  TS_VP: ALL_THREE_TYPES,
  MD_MR: ALL_THREE_TYPES,
  MD_SD: ALL_THREE_TYPES,
  MD_SA: ALL_THREE_TYPES,
  BS_BR: ALL_THREE_TYPES,
  BS_ICT: ALL_THREE_TYPES,
  BS_LS: ALL_THREE_TYPES,
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
