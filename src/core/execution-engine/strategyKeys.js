/**
 * Strategy-key sets / predicates shared by BotEngine execution paths.
 * Gen2 canonical keys only — Gen1 resolves at ACL ingress.
 */
const { normalizeStrategyKey } = require("../../config/strategyKeyNormalizer");

const GROK_CONFIRM_STRATEGIES = new Set([
  "AF_SMC",
  "ADAPTIVE_FUSION",
  "TS_TF",
  "MD_MR",
  "BS_BR",
]);

const MR_STRATEGY_KEYS = new Set(["MD_MR"]);

function isMeanReversionKey(key) {
  return MR_STRATEGY_KEYS.has(normalizeStrategyKey(String(key || "").toUpperCase()));
}

module.exports = {
  GROK_CONFIRM_STRATEGIES,
  MR_STRATEGY_KEYS,
  isMeanReversionKey,
};
