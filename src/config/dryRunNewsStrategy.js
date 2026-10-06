"use strict";

/**
 * Dry-run execution policy.
 *
 * Dry-run is currently a controlled news-reaction experiment, not a mirror of
 * the live tier strategy pool. Keep this policy in one small module so every
 * ingress path (route, resume, coordinator, and engine) agrees on the same
 * strategy key.
 */

const DRY_RUN_NEWS_STRATEGY_KEY = "GROK_NEWS_TRADING";

function isDryRunMode(value) {
  return value !== false && value !== "false" && value !== 0;
}

function resolveRuntimeStrategyKey(strategyKey, dryRun) {
  return isDryRunMode(dryRun)
    ? DRY_RUN_NEWS_STRATEGY_KEY
    : String(strategyKey || "SMART_MONEY_CONCEPTS").toUpperCase();
}

function resolveDryRunStrategies(strategies, dryRun) {
  if (isDryRunMode(dryRun)) return [DRY_RUN_NEWS_STRATEGY_KEY];
  return (Array.isArray(strategies) ? strategies : [])
    .map((key) => String(key || "").toUpperCase())
    .filter(Boolean);
}

function isDryRunNewsStrategy(strategyKey) {
  return String(strategyKey || "").toUpperCase() === DRY_RUN_NEWS_STRATEGY_KEY;
}

module.exports = {
  DRY_RUN_NEWS_STRATEGY_KEY,
  isDryRunMode,
  resolveRuntimeStrategyKey,
  resolveDryRunStrategies,
  isDryRunNewsStrategy,
};
