"use strict";

const { applyDryRunStrategyRelaxations } = require("../../../config/dryRunStrategyRelaxations");
const { resolveRuntimeStrategyKey } = require("../../../config/dryRunNewsStrategy");

/**
 * Merge Bot.configOverrides (ParameterDeployService) into engine start config.
 *
 * Stored shape: { [STRATEGY_KEY]: { knob: value, ... } }
 *
 * Merge order (lowest → highest priority):
 * 1. strategyDefaults inside BotEngine constructor
 * 2. per-strategy DB overrides (this module)
 * 3. explicit bot fields on start: capital, dryRun, tpMode, credentials
 */

const BOT_IDENTITY_KEYS = new Set([
  "capital",
  "dryRun",
  "tpMode",
  "strategyKey",
  "strategy",
  "symbol",
  "userId",
  "botId",
  "apiKey",
  "apiSecret",
  "passphrase",
  "exchangeType",
]);

/**
 * @param {object|null|undefined} dbConfigOverrides
 * @param {string} strategyKey
 * @returns {object}
 */
function extractStrategyConfigOverrides(dbConfigOverrides, strategyKey) {
  if (!dbConfigOverrides || typeof dbConfigOverrides !== "object" || Array.isArray(dbConfigOverrides)) {
    return {};
  }
  const key = String(strategyKey || "").toUpperCase();
  const nested = dbConfigOverrides[key];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return Object.fromEntries(
      Object.entries(nested).filter(([k]) => !BOT_IDENTITY_KEYS.has(k)),
    );
  }
  return {};
}

/**
 * @param {{
 *   dbConfigOverrides?: object|null,
 *   strategyKey: string,
 *   explicit?: object,
 * }} opts
 * @returns {object}
 */
function mergeBotStartOverrides({ dbConfigOverrides, strategyKey, explicit = {} }) {
  const strategyParams = extractStrategyConfigOverrides(dbConfigOverrides, strategyKey);
  const {
    capital,
    dryRun,
    tpMode,
    strategyKey: explicitStrategyKey,
    ...restExplicit
  } = explicit;

  const merged = {
    ...strategyParams,
    ...restExplicit,
  };

  if (explicitStrategyKey != null) merged.strategyKey = explicitStrategyKey;
  if (capital != null) merged.capital = capital;
  if (dryRun != null) merged.dryRun = dryRun;
  if (tpMode != null) merged.tpMode = tpMode;

  // Do this at the final config boundary as well as in BotEngine. This keeps
  // resume/start callers from persisting or passing a legacy paper strategy.
  // An omitted dryRun is intentionally left unspecified here: the multi-engine
  // factory supplies the mode on cfg2, and treating omission as paper mode
  // would silently turn every live engine into GROK_NEWS_TRADING.
  const requestedStrategyKey = merged.strategyKey ?? merged.strategy ?? strategyKey;
  merged.strategyKey = merged.dryRun !== undefined
    ? resolveRuntimeStrategyKey(requestedStrategyKey, merged.dryRun)
    : String(requestedStrategyKey || "SMART_MONEY_CONCEPTS").toUpperCase();

  return applyDryRunStrategyRelaxations(merged);
}

module.exports = {
  BOT_IDENTITY_KEYS,
  extractStrategyConfigOverrides,
  mergeBotStartOverrides,
};
