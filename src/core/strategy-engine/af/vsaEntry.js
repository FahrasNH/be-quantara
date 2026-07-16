/**
 * Volume Spread Analysis (VSA) component for Adaptive Fusion (AF-SUB-02).
 *
 * Patterns: No-Demand, No-Supply, Stopping Volume, Effort-Result Mismatch.
 * All patterns require causal swing proximity (no look-ahead).
 *
 * Return format: { vote: 'LONG'|'SHORT'|'NEUTRAL', confidence: 0-1, reason: string, meta? }
 */

"use strict";

const {
  relativeVolume,
  calculateCLV,
  classifySpread,
  checkSwingProximity,
} = require("./volumeAnalysisUtils");

const DEFAULTS = {
  minBars: 20,
  volumeSmaPeriod: 20,
  atrPeriod: 14,
  wideSpreadMult: 1.3,
  narrowSpreadMult: 0.7,
  lowRelVol: 0.7,
  highRelVol: 1.5,
  mismatchSpreadMult: 0.5,
  swingRadius: 5,
  swingLeftLook: 5,
  swingScanBars: 50,
  mismatchConfidencePenalty: 0.25,
};

/**
 * Detect VSA patterns at lastIdx.
 */
function detectVSAPattern({ candle, relVol, spreadType, clv, swingType, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  if (!candle || relVol == null) return null;

  const isUpBar = candle.close > candle.open;
  const isDownBar = candle.close < candle.open;

  // Stopping Volume near swing low → LONG (buyers absorb)
  if (
    spreadType.isWideSpread &&
    relVol >= cfg.highRelVol &&
    clv > 0.5 &&
    swingType === "low"
  ) {
    return {
      vote: "LONG",
      confidence: Math.min(1, relVol / 2),
      reason: "vsa_stopping_volume_low",
    };
  }

  // Stopping Volume near swing high → SHORT (sellers absorb)
  if (
    spreadType.isWideSpread &&
    relVol >= cfg.highRelVol &&
    clv < 0.5 &&
    swingType === "high"
  ) {
    return {
      vote: "SHORT",
      confidence: Math.min(1, relVol / 2),
      reason: "vsa_stopping_volume_high",
    };
  }

  // No-Demand near swing high → SHORT
  if (
    isUpBar &&
    spreadType.isNarrowSpread &&
    relVol < cfg.lowRelVol &&
    swingType === "high"
  ) {
    return {
      vote: "SHORT",
      confidence: Math.min(1, (cfg.lowRelVol - relVol) / cfg.lowRelVol + 0.4),
      reason: "vsa_no_demand",
    };
  }

  // No-Supply near swing low → LONG
  if (
    isDownBar &&
    spreadType.isNarrowSpread &&
    relVol < cfg.lowRelVol &&
    swingType === "low"
  ) {
    return {
      vote: "LONG",
      confidence: Math.min(1, (cfg.lowRelVol - relVol) / cfg.lowRelVol + 0.4),
      reason: "vsa_no_supply",
    };
  }

  return null;
}

/**
 * Effort-result mismatch: high volume but tiny spread → confidence penalty flag.
 */
function detectEffortResultMismatch(relVol, spread, atr, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (relVol == null || atr == null || atr <= 0 || spread == null) {
    return { isMismatch: false };
  }
  const isMismatch = relVol >= cfg.highRelVol && spread <= cfg.mismatchSpreadMult * atr;
  return {
    isMismatch,
    penalty: isMismatch ? cfg.mismatchConfidencePenalty : 0,
    reason: isMismatch ? "effort_result_mismatch" : null,
  };
}

/**
 * Evaluate VSA component at lastIdx.
 *
 * @param {object} candles - { opens, highs, lows, closes, volumes, atr?, lastIdx }
 * @param {object} [swingPoints] - optional precomputed; otherwise computed causally
 * @param {object} config
 */
function evaluateVSAComponent(candles, swingPoints = null, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const lastIdx = candles?.lastIdx;

  // Ablation funnel (diagnostic counting only — pure guarded side-effect).
  const ablation = config.ablation;
  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  _abl("evaluated");

  if (lastIdx == null || !candles?.closes || lastIdx < cfg.minBars - 1) {
    _abl("rejMinBars");
    return { vote: "NEUTRAL", confidence: 0, reason: "insufficient_data" };
  }

  const vol = candles.volumes?.[lastIdx];
  if (vol == null || vol === 0) {
    if (typeof console !== "undefined" && console.warn) {
      console.warn("[VSA] missing/zero volume at idx", lastIdx);
    }
    _abl("rejVolume");
    return { vote: "NEUTRAL", confidence: 0, reason: "missing_volume_data" };
  }

  const relVol = relativeVolume(candles.volumes, lastIdx, cfg.volumeSmaPeriod);
  if (relVol == null) {
    _abl("rejRelVol");
    return { vote: "NEUTRAL", confidence: 0, reason: "insufficient_volume_sma" };
  }

  const atr =
    candles.atr?.[lastIdx] ??
    null;
  if (atr == null || atr <= 0) {
    _abl("rejAtr");
    return { vote: "NEUTRAL", confidence: 0, reason: "no_atr" };
  }

  const high = candles.highs[lastIdx];
  const low = candles.lows[lastIdx];
  const close = candles.closes[lastIdx];
  const open = candles.opens?.[lastIdx] ?? candles.closes[lastIdx - 1] ?? close;

  const nearSwing =
    swingPoints?.isNear != null
      ? swingPoints
      : checkSwingProximity(
          candles.highs,
          candles.lows,
          lastIdx,
          cfg.swingRadius,
          cfg.swingLeftLook,
          cfg.swingScanBars,
        );

  if (!nearSwing.isNear) {
    _abl("rejSwingProximity");
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: "not_near_structure",
      meta: { nearSwing },
    };
  }

  const spreadType = classifySpread(high, low, atr, cfg.wideSpreadMult, cfg.narrowSpreadMult);
  const clv = calculateCLV(high, low, close);
  const mismatch = detectEffortResultMismatch(relVol, spreadType.spread, atr, cfg);

  const candle = { open, high, low, close, volume: vol };
  const signal = detectVSAPattern({
    candle,
    relVol,
    spreadType,
    clv,
    swingType: nearSwing.type,
    config: cfg,
  });

  if (!signal) {
    _abl("rejPattern");
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: "no_pattern",
      meta: { relVol, clv, spreadType, nearSwing, mismatch },
    };
  }

  let confidence = signal.confidence;
  if (mismatch.isMismatch) {
    confidence = Math.max(0, confidence - mismatch.penalty);
  }

  _abl("passed");
  return {
    vote: signal.vote,
    confidence,
    reason: signal.reason,
    meta: {
      relVol,
      clv,
      spreadType,
      nearSwing,
      mismatch,
      confidencePenalty: mismatch.isMismatch ? mismatch.penalty : 0,
    },
  };
}

function candlesFromIndicators(indicators, lastIdx) {
  return {
    opens: indicators.opens || indicators.closes,
    highs: indicators.highs,
    lows: indicators.lows,
    closes: indicators.closes,
    volumes: indicators.volumes,
    atr: indicators.atr,
    lastIdx,
  };
}

module.exports = {
  DEFAULTS,
  detectVSAPattern,
  detectEffortResultMismatch,
  evaluateVSAComponent,
  candlesFromIndicators,
  calculateCLV,
  relativeVolume,
  classifySpread,
};
