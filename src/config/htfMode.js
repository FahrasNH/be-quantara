/**
 * HTF_Mode — per-strategy higher-timeframe handling (engine + strategy SSOT).
 *
 * Engine step 6c (fail-closed UNKNOWN): all modes except OFF.
 * Engine step 7a (directional block): REQUIRED_ALIGN only.
 * SOFT_BIAS / CONTEXT_ONLY / REGIME_GATE: pass htfTrend to strategy; no engine 7a.
 *
 * Naming:
 *   htfDirectionalAlign — engine 7a hard block (REQUIRED_ALIGN)
 *   htfRegimeGate         — sideways/whipsaw/volatility skip (REGIME_GATE)
 */

"use strict";

const { normalizeStrategyKey } = require("./strategyKeyNormalizer");

const HTF_MODE = Object.freeze({
  OFF: "OFF",
  REQUIRED_ALIGN: "REQUIRED_ALIGN",
  SOFT_BIAS: "SOFT_BIAS",
  CONTEXT_ONLY: "CONTEXT_ONLY",
  REGIME_GATE: "REGIME_GATE",
});

/** Graded confidence penalty (−15 pts) for SOFT_BIAS strategies when counter-HTF. */
const SOFT_BIAS_PENALTY = 15;

/** VSA Intraday HTF overlay: flag/metadata only — no hard directional block. */
const VSA_HTF_OVERLAY_ONLY = true;

const STRATEGY_HTF_MODE = Object.freeze({
  TREND_FOLLOWING: HTF_MODE.REQUIRED_ALIGN,
  MARKET_STRUCTURE: HTF_MODE.REQUIRED_ALIGN,
  WYCKOFF: HTF_MODE.SOFT_BIAS,
  SUPPLY_AND_DEMAND: HTF_MODE.SOFT_BIAS,
  SMART_MONEY_CONCEPTS: HTF_MODE.CONTEXT_ONLY,
  ICT_STYLE_TRADING: HTF_MODE.CONTEXT_ONLY,
  BREAKOUT_RETEST: HTF_MODE.CONTEXT_ONLY,
  LIQUIDATION_SQUEEZE: HTF_MODE.CONTEXT_ONLY,
  AUCTION_MARKET_THEORY: HTF_MODE.CONTEXT_ONLY,
  VOLUME_SPREAD_ANALYSIS: HTF_MODE.CONTEXT_ONLY,
  MEAN_REVERSION: HTF_MODE.REGIME_GATE,
  STATISTICAL_ARBITRAGE: HTF_MODE.REGIME_GATE,

  // Umbrella aliases → primary engine mode
  ADAPTIVE_FUSION: HTF_MODE.CONTEXT_ONLY,
  TREND_SURGE: HTF_MODE.REQUIRED_ALIGN,
  MEAN_DRIFT: HTF_MODE.REGIME_GATE,
  BREAKOUT_STORM: HTF_MODE.CONTEXT_ONLY,

  // Deprecated abbrev aliases (ingress parity)
  AF_SMC: HTF_MODE.CONTEXT_ONLY,
  AF_WYCKOFF: HTF_MODE.SOFT_BIAS,
  AF_VSA: HTF_MODE.CONTEXT_ONLY,
  TS_TF: HTF_MODE.REQUIRED_ALIGN,
  TS_MS: HTF_MODE.REQUIRED_ALIGN,
  TS_VP: HTF_MODE.CONTEXT_ONLY,
  MD_MR: HTF_MODE.REGIME_GATE,
  MD_SD: HTF_MODE.SOFT_BIAS,
  MD_SA: HTF_MODE.REGIME_GATE,
  BS_BR: HTF_MODE.CONTEXT_ONLY,
  BS_ICT: HTF_MODE.CONTEXT_ONLY,
  BS_LS: HTF_MODE.CONTEXT_ONLY,
});

function getHtfMode(strategyKey) {
  const raw = String(strategyKey || "").toUpperCase();
  const canonical = normalizeStrategyKey(raw);
  return STRATEGY_HTF_MODE[canonical] ?? STRATEGY_HTF_MODE[raw] ?? HTF_MODE.OFF;
}

function requiresHtfDirectionalBlock(strategyKey) {
  return getHtfMode(strategyKey) === HTF_MODE.REQUIRED_ALIGN;
}

/** Fail-closed when HTF trend is UNKNOWN (step 6c). */
function requiresHtfFailClosed(strategyKey) {
  return getHtfMode(strategyKey) !== HTF_MODE.OFF;
}

function isCounterHtfTrend(signal, htfTrend) {
  if (!signal || !htfTrend || htfTrend === "SIDEWAYS" || htfTrend === "UNKNOWN") return false;
  if (signal === "LONG" && htfTrend === "BEARISH") return true;
  if (signal === "SHORT" && htfTrend === "BULLISH") return true;
  return false;
}

/** Soft-bias penalty on 0–1 confidence scale. */
function applySoftBiasConfidencePenalty(confidence, signal, htfTrend, penaltyPts = SOFT_BIAS_PENALTY) {
  if (!isCounterHtfTrend(signal, htfTrend)) {
    return { confidence: confidence ?? 0, counterHtf: false, penaltyApplied: 0 };
  }
  return {
    confidence: Math.max(0, (confidence ?? 0) - penaltyPts / 100),
    counterHtf: true,
    penaltyApplied: penaltyPts,
  };
}

/** Soft-bias penalty on 0–100 graded confidence scale. */
function applySoftBiasGradedPenalty(confidencePts, signal, htfTrend, penaltyPts = SOFT_BIAS_PENALTY) {
  if (!isCounterHtfTrend(signal, htfTrend)) {
    return { confidence: confidencePts ?? 0, counterHtf: false, penaltyApplied: 0 };
  }
  return {
    confidence: Math.max(0, (confidencePts ?? 0) - penaltyPts),
    counterHtf: true,
    penaltyApplied: penaltyPts,
  };
}

function shouldBlockHtfDirectional(strategyKey, signal, htfTrend) {
  if (!requiresHtfDirectionalBlock(strategyKey)) return false;
  return isCounterHtfTrend(signal, htfTrend);
}

module.exports = {
  HTF_MODE,
  SOFT_BIAS_PENALTY,
  VSA_HTF_OVERLAY_ONLY,
  STRATEGY_HTF_MODE,
  getHtfMode,
  requiresHtfDirectionalBlock,
  requiresHtfFailClosed,
  isCounterHtfTrend,
  applySoftBiasConfidencePenalty,
  applySoftBiasGradedPenalty,
  shouldBlockHtfDirectional,
};
