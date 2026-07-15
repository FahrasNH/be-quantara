/**
 * Strategy-key sets / predicates shared by BotEngine execution paths.
 */

const GROK_CONFIRM_STRATEGIES = new Set([
  "ADAPTIVE_FUSION",
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "MD_MR",
  "BREAKOUT_RETEST",
]);

const MR_STRATEGY_KEYS = new Set(["MEAN_REVERSION", "MD_MR", "MR"]);

function isMeanReversionKey(key) {
  return MR_STRATEGY_KEYS.has(String(key || "").toUpperCase());
}

module.exports = {
  GROK_CONFIRM_STRATEGIES,
  MR_STRATEGY_KEYS,
  isMeanReversionKey,
};
