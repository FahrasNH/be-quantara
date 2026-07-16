/**
 * Apply PairClassifier paramOverrides onto backtest parameters.
 *
 * Mirrors FE `applyPairTierOverrides` / live BotEngine pair wiring, with one
 * critical difference vs older FE: do NOT also multiply `atrMult` by
 * slMultiplier. The engine already scales SL/TP via `pairSlMultiplier`
 * (RealStrategyBacktestService + BotEngine). Multiplying atrMult on top
 * double-applies the tier for TREND_FOLLOWING (atrMult → slAtrMult).
 *
 * @param {object} parametersIn
 * @param {object|null} classification - PairClassifier.classify() result
 *   (or API `{ tier, paramOverrides }` shape)
 * @param {string} [strategyKey]
 * @returns {{ parameters: object, applied: object|null }}
 */
"use strict";

function applyPairTierToBacktestParams(parametersIn = {}, classification = null, strategyKey = "") {
  const parameters = { ...(parametersIn || {}) };
  const ov = classification?.paramOverrides;
  if (!ov) return { parameters, applied: null };

  const applied = {};

  if (ov.slMultiplier != null && ov.slMultiplier !== 1.0) {
    // Single application path — engine reads pairSlMultiplier only.
    parameters.pairSlMultiplier = ov.slMultiplier;
    applied.slMultiplier = ov.slMultiplier;
  }

  if (ov.positionSizeAdjustment != null && ov.positionSizeAdjustment !== 1.0) {
    parameters.riskPerTrade = (parameters.riskPerTrade ?? 0.01) * ov.positionSizeAdjustment;
    applied.positionSizeAdjustment = ov.positionSizeAdjustment;
  }

  if (ov.votingThresholdOverride != null) {
    const key = String(strategyKey || "").toUpperCase();
    if (key === "SMART_MONEY_CONCEPTS" || key === "ADAPTIVE_FUSION"
        || key === "WYCKOFF" || key === "VOLUME_SPREAD_ANALYSIS") {
      parameters.votingThreshold = ov.votingThresholdOverride;
      applied.votingThreshold = ov.votingThresholdOverride;
    }
  }

  if (ov.maxTradesPerDay != null) {
    parameters.maxTradesPerDay = ov.maxTradesPerDay;
    applied.maxTradesPerDay = ov.maxTradesPerDay;
  }

  if (ov.dailyLossLimit != null) {
    parameters.maxDailyLossPct = ov.dailyLossLimit;
    applied.dailyLossLimit = ov.dailyLossLimit;
  }

  if (ov.regimeFilterRequired != null) {
    parameters.tierOverrides = {
      ...(parameters.tierOverrides || {}),
      regimeFilterRequired: ov.regimeFilterRequired,
    };
    applied.regimeFilterRequired = ov.regimeFilterRequired;
  }

  if (classification?.tier) {
    parameters.pairTier = classification.tier;
  }

  return {
    parameters,
    applied: Object.keys(applied).length ? applied : null,
  };
}

/**
 * True when the client already stamped pair-tier knobs (FE Advance) or opted out.
 */
function hasExplicitPairTier(parameters = {}) {
  if (parameters.skipPairTier === true) return true;
  if (parameters.pairSlMultiplier != null) return true;
  if (parameters.pairTier != null) return true;
  return false;
}

module.exports = {
  applyPairTierToBacktestParams,
  hasExplicitPairTier,
};
