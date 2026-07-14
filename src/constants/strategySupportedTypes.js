/**
 * STRATEGY_SUPPORTED_TYPES — which trade types each strategy supports.
 * Used for FE dropdown filtering and BE validation.
 *
 * Trading Strategy Recap.pdf trade types are in strategyRecapCatalog.js (pdfTradeType).
 * Intentional runtime drifts (documented in ARCHITECTURE § Recap Alignment):
 *   AF_* — Scalping+Swing only (AF-SCALP-19 dropped Intraday; PDF lists Intraday for SMC/Wyckoff/VSA)
 *   TS_MS — no Position leg (PDF swing+position)
 *   TS_VP — Swing kept for 4h UTC-week session (PDF intraday-primary)
 *   MD_SD / MD_SA — Scalping+Intraday (PDF also lists Swing for SA/SD)
 *   BS_BR — all 3 supported in Advance backtest; live/tier package halted (Sprint 14)
 */

const STRATEGY_SUPPORTED_TYPES = {
  AF_SMC: ["Scalping", "Swing"],           // PDF: +Intraday — intentionally omitted (AF-SCALP-19)
  AF_WYCKOFF: ["Scalping", "Swing"],       // PDF: Intraday+Swing
  AF_VSA: ["Scalping", "Swing"],           // PDF: Intraday+Swing
  TS_TF: ["Intraday", "Swing"],            // Scalping removed to avoid 5m fetch failure
  TS_MS: ["Intraday", "Swing"],            // PDF Position not supported
  // AMT Swing uses UTC-week session (4h day-session cannot clear min bars) — see volumeProfileComponent
  TS_VP: ["Intraday", "Swing"],            // PDF: Intraday-primary
  MD_MR: ["Scalping", "Intraday"],         // Swing not applicable (mean reversion short-term only)
  MD_SD: ["Scalping", "Intraday"],         // PDF: Intraday+Swing
  MD_SA: ["Scalping", "Intraday"],         // PDF: Algo/Intraday/Swing — v1 single-symbol only
  BS_BR: ["Scalping", "Intraday", "Swing"], // PDF: Scalping→Swing; live halted — backtest-only
  BS_ICT: ["Scalping", "Intraday", "Swing"], // PDF: especially Intraday
  BS_LS: ["Scalping", "Intraday", "Swing"],  // PDF: Scalping+Intraday
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
