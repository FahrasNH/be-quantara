/**
 * Liquidation / Squeeze Trading (LIQUIDATION_SQUEEZE) — BREAKOUT_STORM race participant.
 *
 * Primary signals: OI change % + funding extremes, combined with price
 * displacement (liquidation-style wick through recent highs/lows) so the
 * strategy can generate trades even when pure OI/funding alone is thin.
 *
 * Fail-open: if OI/funding unavailable → still allow price-displacement
 * entries at reduced confidence (never hard-block the race participant).
 */

"use strict";

const {
  percentileRank,
  bbWidthSeries,
} = require("../af/volumeAnalysisUtils");
const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: Liquidation Squeeze Scalping session filter (Asia block). */
function applyLsSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const DEFAULTS = {
  oiLookback: 20,
  extremeFundingLong: 0.0005, // +0.05% / 8h
  extremeFundingShort: -0.0005,
  oiChangeConfirmPct: 1.0, // |OI change| ≥ 1%
  wickLookback: 20,
  wickVolMult: 1.2,
  minWickBodyRatio: 1.5, // wick ≥ 1.5× body
  baseConfidence: 0.55,
  fundingBoost: 0.2,
  oiBoost: 0.15,
  displacementOnlyConfidence: 0.5,
  maxConfidence: 0.92,
};

/**
 * @param {number[]} oiHistory — chronological OI values
 * @param {number} lookback
 * @returns {number|null} percent change
 */
function calculateOIChangePercent(oiHistory, lookback = DEFAULTS.oiLookback) {
  if (!Array.isArray(oiHistory) || oiHistory.length < lookback + 1) return null;
  const now = oiHistory[oiHistory.length - 1];
  const prev = oiHistory[oiHistory.length - 1 - lookback];
  if (!(prev > 0) || !Number.isFinite(now)) return null;
  return ((now - prev) / prev) * 100;
}

/**
 * Risk / sentiment overlay helper (also usable universally).
 * Fail-open when data missing.
 */
function evaluateOIFundingGate(direction, exchangeData = {}, config = {}) {
  const oiHist = exchangeData.oiHistory || exchangeData.oi || null;
  const funding = exchangeData.funding ?? exchangeData.fundingRate ?? null;
  const extremeLong = config.bsLsExtremeFundingLong ?? DEFAULTS.extremeFundingLong;
  const extremeShort = config.bsLsExtremeFundingShort ?? DEFAULTS.extremeFundingShort;
  const oiLookback = config.bsLsOiLookback ?? DEFAULTS.oiLookback;

  if (
    (oiHist == null || (Array.isArray(oiHist) && oiHist.length === 0)) &&
    (funding == null || !Number.isFinite(funding))
  ) {
    return {
      allow: true,
      confidence: 1.0,
      reason: "oi_funding_unavailable_fallback_neutral",
      oiChange: null,
      funding: null,
      dataAvailable: false,
    };
  }

  const oiChange = Array.isArray(oiHist) ? calculateOIChangePercent(oiHist, oiLookback) : null;
  let confidence = 1.0;
  let reason = "oi_funding_neutral";

  if (direction === "LONG" && funding != null && funding > extremeLong) {
    confidence = 0.5;
    reason = "crowd_overleveraged_long_reduce_confidence";
  } else if (direction === "SHORT" && funding != null && funding < extremeShort) {
    confidence = 0.5;
    reason = "crowd_overleveraged_short_reduce_confidence";
  } else if (oiChange != null) {
    const oiConfirms = oiChange > 0; // rising OI with move = new positioning
    confidence = oiConfirms ? 1.0 : 0.8;
    reason = oiConfirms ? "oi_confirms" : "oi_flat_caution";
  }

  return {
    allow: true,
    confidence,
    reason,
    oiChange,
    funding,
    dataAvailable: true,
  };
}

/**
 * Liquidation-style wick displacement through recent extremes.
 */
function detectLiquidationWick(highs, lows, opens, closes, volumes, volSMA, lastIdx, opts = {}) {
  const lookback = opts.wickLookback ?? DEFAULTS.wickLookback;
  const volMult = opts.wickVolMult ?? DEFAULTS.wickVolMult;
  const wickBodyRatio = opts.minWickBodyRatio ?? DEFAULTS.minWickBodyRatio;

  if (!closes || lastIdx < lookback + 1) {
    return { detected: false, direction: null, reason: "warmup" };
  }

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (let i = lastIdx - lookback; i < lastIdx; i++) {
    if (highs[i] > rangeHigh) rangeHigh = highs[i];
    if (lows[i] < rangeLow) rangeLow = lows[i];
  }

  const o = opens?.[lastIdx] ?? closes[lastIdx - 1] ?? closes[lastIdx];
  const h = highs[lastIdx];
  const l = lows[lastIdx];
  const c = closes[lastIdx];
  const body = Math.max(Math.abs(c - o), 1e-12);
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;
  const volNow = volumes?.[lastIdx] ?? 0;
  const vsma = Array.isArray(volSMA) ? volSMA[lastIdx] : volSMA;
  const volOk = !(vsma > 0) || volNow >= vsma * volMult;

  // Long liquidation cascade into lows → bounce LONG (short squeeze setup)
  if (l < rangeLow && lowerWick >= body * wickBodyRatio && c > l + (h - l) * 0.5 && volOk) {
    return {
      detected: true,
      direction: "LONG",
      reason: "liquidation_wick_low_bounce",
      level: rangeLow,
      volOk: true,
    };
  }
  // Short liquidation into highs → reject SHORT (long squeeze)
  if (h > rangeHigh && upperWick >= body * wickBodyRatio && c < h - (h - l) * 0.5 && volOk) {
    return {
      detected: true,
      direction: "SHORT",
      reason: "liquidation_wick_high_reject",
      level: rangeHigh,
      volOk: true,
    };
  }

  // Soft volume path
  if (l < rangeLow && lowerWick >= body * wickBodyRatio && c > l + (h - l) * 0.5) {
    return {
      detected: true,
      direction: "LONG",
      reason: "liquidation_wick_low_soft",
      level: rangeLow,
      volOk: false,
    };
  }
  if (h > rangeHigh && upperWick >= body * wickBodyRatio && c < h - (h - l) * 0.5) {
    return {
      detected: true,
      direction: "SHORT",
      reason: "liquidation_wick_high_soft",
      level: rangeHigh,
      volOk: false,
    };
  }

  return { detected: false, direction: null, reason: "no_liquidation_wick" };
}

/**
 * Standalone race entry combining displacement + optional OI/funding.
 */
function evaluateLiquidationSqueezeEntry({
  highs,
  lows,
  opens,
  closes,
  volumes,
  volSMA,
  lastIdx,
  exchangeData = {},
  ablation = null,
  config = {},
} = {}) {
  const _abl = (k) => { if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1; };
  const baseConf = config.bsLsBaseConfidence ?? DEFAULTS.baseConfidence;
  const fundingBoost = config.bsLsFundingBoost ?? DEFAULTS.fundingBoost;
  const oiBoost = config.bsLsOiBoost ?? DEFAULTS.oiBoost;
  const dispOnly = config.bsLsDisplacementOnlyConfidence ?? DEFAULTS.displacementOnlyConfidence;
  const maxConf = config.bsLsMaxConfidence ?? DEFAULTS.maxConfidence;
  const extremeLong = config.bsLsExtremeFundingLong ?? DEFAULTS.extremeFundingLong;
  const extremeShort = config.bsLsExtremeFundingShort ?? DEFAULTS.extremeFundingShort;
  const oiLookback = config.bsLsOiLookback ?? DEFAULTS.oiLookback;
  const oiConfirm = config.bsLsOiChangeConfirmPct ?? DEFAULTS.oiChangeConfirmPct;

  _abl("evaluated");

  if (scalpingSessionBlocked(config, { timestamps: config.timestamps }, lastIdx, "lsSessionFilter", applyLsSessionFilter, ablation)) {
    return { signal: null, confidence: 0, reason: "ls_session_block", meta: null };
  }

  const wick = detectLiquidationWick(highs, lows, opens, closes, volumes, volSMA, lastIdx, {
    wickLookback: config.bsLsWickLookback ?? DEFAULTS.wickLookback,
    wickVolMult: config.bsLsWickVolMult ?? DEFAULTS.wickVolMult,
    minWickBodyRatio: config.bsLsMinWickBodyRatio ?? DEFAULTS.minWickBodyRatio,
  });

  const funding = exchangeData.funding ?? exchangeData.fundingRate ?? null;
  const oiHist = exchangeData.oiHistory || null;
  const oiChange = Array.isArray(oiHist) ? calculateOIChangePercent(oiHist, oiLookback) : null;
  const dataAvailable = funding != null || oiChange != null;

  let oiValue = null;
  let oiPercentile = null;
  let bbWidth = null;
  let bbWidthPercentile = null;

  if (Array.isArray(oiHist) && oiHist.length > 0) {
    oiValue = oiHist[oiHist.length - 1];
    const oiIdx = oiHist.length - 1;
    oiPercentile = percentileRank(oiHist, oiIdx, Math.max(oiLookback * 2, 20));
  }

  if (closes && lastIdx >= 19) {
    const widths = bbWidthSeries(closes, lastIdx, 20, 2);
    bbWidth = widths[lastIdx];
    bbWidthPercentile = percentileRank(widths, lastIdx, 100);
  }

  // Squeeze from funding extremes alone (crowd trapped) — need a wick OR strong OI
  let signal = null;
  let reason = "no_ls_signal";
  let confidence = 0;

  if (wick.detected) {
    signal = wick.direction;
    reason = wick.reason;
    confidence = dataAvailable ? baseConf : dispOnly;
    if (wick.volOk === false) confidence *= 0.9;

    if (signal === "LONG" && funding != null && funding < extremeShort) {
      // Extreme short funding → short squeeze potential → boost LONG
      confidence += fundingBoost;
      reason += "+funding_short_squeeze";
    } else if (signal === "SHORT" && funding != null && funding > extremeLong) {
      confidence += fundingBoost;
      reason += "+funding_long_squeeze";
    }

    if (oiChange != null && Math.abs(oiChange) >= oiConfirm) {
      confidence += oiBoost;
      reason += `+oi_${oiChange > 0 ? "rising" : "falling"}`;
    }
  } else if (dataAvailable) {
    // Funding extreme without wick: only fire if OI also moves (avoid spam)
    if (funding != null && funding > extremeLong && oiChange != null && oiChange > oiConfirm) {
      signal = "SHORT"; // crowded long + rising OI → liquidation risk down
      confidence = baseConf * 0.85;
      reason = "funding_long_extreme_oi_rising";
    } else if (funding != null && funding < extremeShort && oiChange != null && oiChange > oiConfirm) {
      signal = "LONG";
      confidence = baseConf * 0.85;
      reason = "funding_short_extreme_oi_rising";
    }
  }

  if (!signal) {
    if (!wick.detected) _abl("rejWick");
    if (!dataAvailable) _abl("rejOiFunding");
    _abl("rejSignalPath");
    return {
      signal: null,
      confidence: 0,
      reason: dataAvailable ? reason : "oi_funding_unavailable_no_wick",
      wick,
      funding,
      oiChange,
      dataAvailable,
      oiValue,
      oiPercentile,
      bbWidth,
      bbWidthPercentile,
    };
  }

  _abl("passed");
  return {
    signal,
    confidence: Math.min(maxConf, confidence),
    reason: `ls_${reason}`,
    wick,
    funding,
    oiChange,
    dataAvailable,
    oiValue,
    oiPercentile,
    bbWidth,
    bbWidthPercentile,
    winningComponent: "LIQUIDATION_SQUEEZE",
    strategyLabel: "Liquidation/Squeeze Trading",
  };
}

module.exports = {
  DEFAULTS,
  calculateOIChangePercent,
  evaluateOIFundingGate,
  detectLiquidationWick,
  evaluateLiquidationSqueezeEntry,
};
