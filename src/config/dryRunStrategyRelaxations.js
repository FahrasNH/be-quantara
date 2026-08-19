"use strict";

/**
 * dryRunStrategyRelaxations.js — dry-run-only gate relaxations for live observation.
 *
 * Production/live gates stay strict (Sprint 22 SMC Intraday conf≥80, smcBlockAllInChop).
 * Dry-run relaxes SMC so staging fleets generate trades for monitoring without
 * weakening live parity. Opt back to strict via DRY_RUN_STRICT_GATES=true.
 */

const { normalizeStrategyKey } = require("./strategyKeyNormalizer");

/** SMC Intraday/Scalping relaxations applied when config.dryRun === true. */
const SMC_DRY_RUN_TYPE_OVERRIDES = Object.freeze({
  Scalping: {
    smcRequireObRetest: false,
    smcBlockLongInChop: false,
  },
  Intraday: {
    smcMinConfidenceIntraday: 65,
    smcMinConfidenceB: 65,
    smcBlockAllInChop: false,
  },
});

function mergeTypeOverrides(base = {}, patch = {}) {
  const out = { ...base };
  for (const [leg, legPatch] of Object.entries(patch)) {
    out[leg] = { ...(out[leg] || {}), ...legPatch };
  }
  return out;
}

/**
 * Apply dry-run observation relaxations to an engine start config.
 * @param {object} config
 * @returns {object}
 */
function applyDryRunStrategyRelaxations(config = {}) {
  if (config.dryRun !== true) return config;
  if (process.env.DRY_RUN_STRICT_GATES === "true") return config;

  const key = normalizeStrategyKey(String(config.strategyKey || config.strategy || ""));
  if (key !== "SMART_MONEY_CONCEPTS") return config;

  const intraday = SMC_DRY_RUN_TYPE_OVERRIDES.Intraday;
  return {
    ...config,
    smcMinConfidenceIntraday: intraday.smcMinConfidenceIntraday,
    smcMinConfidenceB: intraday.smcMinConfidenceB,
    typeOverrides: mergeTypeOverrides(config.typeOverrides, SMC_DRY_RUN_TYPE_OVERRIDES),
  };
}

module.exports = {
  SMC_DRY_RUN_TYPE_OVERRIDES,
  applyDryRunStrategyRelaxations,
  mergeTypeOverrides,
};
