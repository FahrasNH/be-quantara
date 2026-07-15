/**
 * Strategy-key sets / predicates shared by BotEngine execution paths.
 * Gen2 canonical keys only — Gen1 resolves at ACL ingress.
 */
const { normalizeStrategyKey } = require("../../config/strategyKeyNormalizer");

const GROK_CONFIRM_STRATEGIES = new Set([
  "SMART_MONEY_CONCEPTS",
  "ADAPTIVE_FUSION",
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "BREAKOUT_RETEST",
]);

const MR_STRATEGY_KEYS = new Set(["MEAN_REVERSION"]);

function isMeanReversionKey(key) {
  return MR_STRATEGY_KEYS.has(normalizeStrategyKey(String(key || "").toUpperCase()));
}

module.exports = {
  GROK_CONFIRM_STRATEGIES,
  MR_STRATEGY_KEYS,
  isMeanReversionKey,
};
