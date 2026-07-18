"use strict";

/**
 * Research Dataset SSOT — field definitions (Sprint 16).
 * Canonical schema for trade-level research/training rows used by graded scoring calibration.
 */

const { normalizeStrategyKey } = require("../config/strategyKeyNormalizer");

/** SMC graded sub-score keys (0-100 scale, stored in featureScores JSON). */
const SMC_FEATURE_SCORE_KEYS = Object.freeze([
  "sweepScore",
  "chochScore",
  "fvgScore",
  "obScore",
  "htfAlignScore",
  "mitigationScore",
  "totalSmcScore",
]);

/** All strategy component score key prefixes for future expansion. */
const STRATEGY_FEATURE_SCORE_PREFIXES = Object.freeze({
  SMART_MONEY_CONCEPTS: SMC_FEATURE_SCORE_KEYS,
  ICT_STYLE_TRADING: ["icetScore"],
  SUPPLY_AND_DEMAND: ["sdScore"],
  TREND_FOLLOWING: ["tfScore"],
  MEAN_REVERSION: ["mrScore"],
  BREAKOUT_RETEST: ["brScore"],
  MARKET_STRUCTURE: ["msScore"],
  WYCKOFF: ["wyckoffScore"],
  VOLUME_SPREAD_ANALYSIS: ["vsaScore"],
  AUCTION_MARKET_THEORY: ["amtScore"],
  STATISTICAL_ARBITRAGE: ["statarbScore"],
  LIQUIDATION_SQUEEZE: ["liqsqzScore"],
});

/** ComponentScoringEngine breakdown key → SSOT featureScores key (SMC). */
const SMC_BREAKDOWN_TO_FEATURE = Object.freeze({
  sweepQuality: "sweepScore",
  chochDisplacement: "chochScore",
  fvgQuality: "fvgScore",
  obConfluence: "obScore",
  htfAlignment: "htfAlignScore",
  liquidityFreshness: "mitigationScore",
});

/** Data quality flag vocabulary. */
const DATA_QUALITY_FLAGS = Object.freeze({
  NULL_FEATURES: "null_features",
  PARTIAL_DATA: "partial_data",
  ESTIMATED_MFE_MAE: "estimated_mfe_mae",
  INFERRED_SCORES: "inferred_scores",
  DUPLICATE_RESOLVED: "duplicate_resolved",
});

/** Score tier boundaries for predictive validation (0-33, 33-66, 66-100). */
const SCORE_TIER_BOUNDS = Object.freeze([
  { tier: "low", min: 0, max: 33 },
  { tier: "mid", min: 33, max: 66 },
  { tier: "high", min: 66, max: 101 },
]);

/** Required core fields for ≥95% completeness gate. */
const CORE_REQUIRED_FIELDS = Object.freeze([
  "tradeId",
  "symbol",
  "side",
  "strategyKey",
  "entryPrice",
  "entryTime",
  "result",
  "gradedScore",
  "sessionName",
  "dailyRegime",
  "htfTrend",
  "atr",
  "exitReason",
]);

/** Required feature fields for full completeness (SMC). */
const SMC_FEATURE_FIELDS = Object.freeze([
  "totalSmcScore",
  "sweepScore",
  "chochScore",
  "fvgScore",
]);

function resolveStrategyKey(raw) {
  const normalized = normalizeStrategyKey(
    String(raw || "").trim().toUpperCase().replace(/\s+/g, "_")
  );
  if (normalized === "ADAPTIVE_FUSION") return "SMART_MONEY_CONCEPTS";
  return normalized || "SMART_MONEY_CONCEPTS";
}

function scoreTierFor(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  for (const b of SCORE_TIER_BOUNDS) {
    if (s >= b.min && s < b.max) return b.tier;
  }
  return "high";
}

function smcBreakdownToFeatureScores(breakdown = {}, totalScore = null) {
  const out = {};
  for (const [bk, fk] of Object.entries(SMC_BREAKDOWN_TO_FEATURE)) {
    const v = breakdown[bk];
    out[fk] = Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  out.totalSmcScore = totalScore != null
    ? Math.round(Number(totalScore) * 100) / 100
    : Object.values(out).filter(Number.isFinite).reduce((a, b) => a + b, 0) || null;
  return out;
}

module.exports = {
  SMC_FEATURE_SCORE_KEYS,
  STRATEGY_FEATURE_SCORE_PREFIXES,
  SMC_BREAKDOWN_TO_FEATURE,
  DATA_QUALITY_FLAGS,
  SCORE_TIER_BOUNDS,
  CORE_REQUIRED_FIELDS,
  SMC_FEATURE_FIELDS,
  resolveStrategyKey,
  scoreTierFor,
  smcBreakdownToFeatureScores,
};
