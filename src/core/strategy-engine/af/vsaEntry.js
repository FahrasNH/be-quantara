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
  averageSpreadAt,
  classifySpread,
  checkSwingProximity,
  smaAt,
} = require("./volumeAnalysisUtils");
const {
  applyNoTradeSessionFilter,
} = require("../../risk-engine/entryRiskGates");
const {
  enrichMetaWithGradedScore,
} = require("../scoring/ComponentScoringEngine");
const { VSA_HTF_OVERLAY_ONLY } = require("../../../config/htfMode");
const {
  detectIntradayVsaSignal,
  resolveIntradayDetectorMode,
} = require("./vsaIntradayDetector");

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

/** Sprint 23: VSA-owned session filter (Scalping + Swing Asia block). */
function applyVsaSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

function resolveVsaScalpingGateFlags(config = {}) {
  const ov = config.typeOverrides?.Scalping || {};
  return {
    vsaSessionFilter: config.vsaSessionFilter ?? ov.vsaSessionFilter ?? false,
    noTradeSessions: config.noTradeSessions ?? ov.noTradeSessions ?? null,
    vsaScalpingShelved: config.vsaScalpingShelved ?? ov.vsaScalpingShelved ?? false,
  };
}

function resolveVsaSwingGateFlags(config = {}) {
  const ov = config.typeOverrides?.Swing || {};
  return {
    vsaSessionFilter: config.vsaSessionFilter ?? ov.vsaSessionFilter ?? false,
    noTradeSessions: config.noTradeSessions ?? ov.noTradeSessions ?? null,
    vsaSwingLongOnly: config.vsaSwingLongOnly ?? ov.vsaSwingLongOnly ?? false,
    vsaMinConfidenceSwing: config.vsaMinConfidenceSwing ?? ov.vsaMinConfidenceSwing ?? null,
  };
}

function resolveVsaIntradayGateFlags(config = {}) {
  const ov = config.typeOverrides?.Intraday || {};
  return {
    vsaHtfAlignGate: config.vsaHtfAlignGate ?? ov.vsaHtfAlignGate ?? false,
    /** Confidence multiplier removed on LONG×BEARISH (0.5 = halve confidence). */
    vsaHtfCounterPenalty: config.vsaHtfCounterPenalty ?? ov.vsaHtfCounterPenalty ?? 0.5,
    /** Sprint 23 Fix #2: Intraday London block (NOT Asia — session profile inverted). */
    vsaSessionFilter: config.vsaSessionFilter ?? ov.vsaSessionFilter ?? false,
    noTradeSessions: config.noTradeSessions ?? ov.noTradeSessions ?? null,
  };
}

function isVsaCounterTrend(vote, htfTrend) {
  if (!htfTrend || htfTrend === "SIDEWAYS" || htfTrend === "UNKNOWN") return false;
  if (vote === "SHORT" && htfTrend === "BULLISH") return true;
  if (vote === "LONG" && htfTrend === "BEARISH") return true;
  return false;
}

function resolveVsaSessionGateFlags(config = {}, tradeTier) {
  if (tradeTier === "Scalping") return resolveVsaScalpingGateFlags(config);
  if (tradeTier === "Swing") return resolveVsaSwingGateFlags(config);
  if (tradeTier === "Intraday") {
    const intraday = resolveVsaIntradayGateFlags(config);
    return {
      vsaSessionFilter: intraday.vsaSessionFilter,
      noTradeSessions: intraday.noTradeSessions,
    };
  }
  return { vsaSessionFilter: false, noTradeSessions: null };
}

/** Backtest/live leg hint when tradeType is omitted from a per-type pass config. */
function resolveVsaTradeTier(config = {}) {
  if (config.tradeType) return config.tradeType;
  const active = config.activeComponents;
  if (Array.isArray(active) && active.length === 1) return active[0];
  return null;
}

function timestampFromConfig(config, candles) {
  const lastIdx = candles?.lastIdx;
  return config.candleTimestamp
    ?? candles?.timestamps?.[lastIdx]
    ?? config.timestamps?.[lastIdx]
    ?? null;
}

function isStoppingVolumeReason(reason) {
  return String(reason || "").includes("stopping_volume");
}

/**
 * Sprint 23 post-pattern gates: shelve Scalping, session, Swing LONG-only, Intraday HTF-align.
 */
function applyVsaEntryGates(result, { config = {}, candles = {}, ablation = null } = {}) {
  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  const tradeTier = resolveVsaTradeTier(config);
  if (!result || (result.vote !== "LONG" && result.vote !== "SHORT")) return result;

  let gated = result;

  const sessionFlags = resolveVsaSessionGateFlags(config, tradeTier);
  if (
    (tradeTier === "Scalping" || tradeTier === "Swing" || tradeTier === "Intraday")
    && sessionFlags.vsaSessionFilter === true
  ) {
    const ts = timestampFromConfig(config, candles);
    const sess = applyVsaSessionFilter(ts, {
      enabled: true,
      noTradeSessions: sessionFlags.noTradeSessions,
    });
    if (sess.blocked) {
      _abl("rejBySession");
      return { vote: "NEUTRAL", confidence: 0, reason: sess.reason || "vsa_session_block" };
    }
  }

  if (tradeTier === "Intraday") {
    const intradayFlags = resolveVsaIntradayGateFlags(config);
    const htfTrend = config.htfTrend ?? null;
    // CONTEXT_ONLY: vsaHtfAlignGate = overlay flag only — no hard counter-trend block.
    if (intradayFlags.vsaHtfAlignGate === true && htfTrend) {
      const counter = isVsaCounterTrend(gated.vote, htfTrend);
      if (counter) {
        if (gated.vote === "SHORT" && htfTrend === "BULLISH") _abl("rejHtfShortBullish");
        if (isStoppingVolumeReason(gated.reason) && counter) _abl("rejHtfStoppingCounter");
        if (gated.vote === "LONG" && htfTrend === "BEARISH") _abl("rejHtfLongBearishPenalty");
        gated = {
          ...gated,
          meta: {
            ...(gated.meta || {}),
            htfTrend,
            htfCounterTrend: true,
            htfOverlayOnly: VSA_HTF_OVERLAY_ONLY,
            vsaHtfConfidenceFlag: true,
          },
        };
      }
    }
  }

  if (tradeTier === "Swing") {
    const swingFlags = resolveVsaSwingGateFlags(config);
    if (swingFlags.vsaSwingLongOnly === true && gated.vote === "SHORT") {
      _abl("rejSwingShort");
      return { vote: "NEUTRAL", confidence: 0, reason: "vsa_swing_long_only" };
    }

    const metaBase = {
      ...(gated.meta || {}),
      vsaPatternType: isStoppingVolumeReason(gated.reason) ? "STOPPING_VOLUME"
        : String(gated.reason || "").includes("no_demand") ? "NO_DEMAND"
          : String(gated.reason || "").includes("no_supply") ? "NO_SUPPLY"
            : null,
      vsaReversal: isStoppingVolumeReason(gated.reason),
      vote: gated.vote,
      signal: gated.vote,
      tradeType: tradeTier,
    };
    const enriched = enrichMetaWithGradedScore(metaBase, "VOLUME_SPREAD_ANALYSIS");
    const graded = enriched?.gradedScore ?? Math.round((gated.confidence || 0) * 100);
    const minConf = swingFlags.vsaMinConfidenceSwing;
    const stoppingBypass = isStoppingVolumeReason(gated.reason);
    if (minConf != null && graded < minConf && !stoppingBypass) {
      _abl("rejMinConfidence");
      return { vote: "NEUTRAL", confidence: 0, reason: "vsa_swing_conf_below_floor" };
    }
    return {
      ...gated,
      confidence: graded / 100,
      meta: {
        ...(gated.meta || {}),
        gradedScore: enriched?.gradedScore ?? graded,
        gradedScoreBreakdown: enriched?.gradedScoreBreakdown ?? null,
        componentConfidence: enriched?.componentConfidence ?? graded,
      },
    };
  }

  const metaBase = {
    ...(gated.meta || {}),
    vsaPatternType: isStoppingVolumeReason(gated.reason) ? "STOPPING_VOLUME"
      : String(gated.reason || "").includes("no_demand") ? "NO_DEMAND"
        : String(gated.reason || "").includes("no_supply") ? "NO_SUPPLY"
          : null,
    vsaReversal: isStoppingVolumeReason(gated.reason),
    vote: gated.vote,
    signal: gated.vote,
    tradeType: tradeTier,
  };
  const enriched = enrichMetaWithGradedScore(metaBase, "VOLUME_SPREAD_ANALYSIS");
  const graded = enriched?.gradedScore ?? Math.round((gated.confidence || 0) * 100);
  return {
    ...gated,
    confidence: graded / 100,
    meta: {
      ...(gated.meta || {}),
      gradedScore: enriched?.gradedScore ?? graded,
      gradedScoreBreakdown: enriched?.gradedScoreBreakdown ?? null,
      componentConfidence: enriched?.componentConfidence ?? graded,
    },
  };
}

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

  const tradeTier = resolveVsaTradeTier(config);
  if (tradeTier === "Scalping") {
    const scalpFlags = resolveVsaScalpingGateFlags(cfg);
    if (scalpFlags.vsaScalpingShelved === true) {
      _abl("rejScalpingShelved");
      return { vote: "NEUTRAL", confidence: 0, reason: "vsa_scalping_shelved" };
    }
  }

  if (lastIdx == null || !candles?.closes || lastIdx < cfg.minBars - 1) {
    _abl("rejMinBars");
    return { vote: "NEUTRAL", confidence: 0, reason: "insufficient_data" };
  }

  // Sprint 23 Fix #3: Intraday detector v2 (confirmation bar default).
  if (tradeTier === "Intraday") {
    const detectorMode = resolveIntradayDetectorMode(cfg);
    if (detectorMode !== "legacy") {
      const v2Signal = detectIntradayVsaSignal(candles, lastIdx, cfg, {
        ...cfg,
        indicators: config.indicators,
      });
      if (!v2Signal) {
        _abl("rejPattern");
        return { vote: "NEUTRAL", confidence: 0, reason: "no_pattern_v2" };
      }
      const raw = {
        vote: v2Signal.vote,
        confidence: v2Signal.confidence,
        reason: v2Signal.reason,
        meta: v2Signal.meta || {},
      };
      const gated = applyVsaEntryGates(raw, { config: cfg, candles, ablation });
      if (gated.vote === "LONG" || gated.vote === "SHORT") _abl("passed");
      return gated;
    }
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

  const volSMA = relVol > 0
    ? vol / relVol
    : smaAt(candles.volumes, lastIdx, cfg.volumeSmaPeriod);

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
  const avgSpread = averageSpreadAt(
    candles.highs,
    candles.lows,
    lastIdx,
    cfg.atrPeriod ?? 14,
  );
  const volumeMeta = {
    volume: vol,
    volSMA,
    avgVolume: volSMA,
  };

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
      meta: { nearSwing, ...volumeMeta },
    };
  }

  const spreadType = classifySpread(
    high,
    low,
    atr,
    cfg.wideSpreadMult,
    cfg.narrowSpreadMult,
    avgSpread,
  );
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
      meta: { relVol, clv, spreadType, nearSwing, mismatch, ...volumeMeta },
    };
  }

  let confidence = signal.confidence;
  if (mismatch.isMismatch) {
    confidence = Math.max(0, confidence - mismatch.penalty);
  }

  const raw = {
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
      ...volumeMeta,
    },
  };
  const gated = applyVsaEntryGates(raw, { config: cfg, candles, ablation });
  if (gated.vote === "LONG" || gated.vote === "SHORT") _abl("passed");
  return gated;
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
  applyVsaSessionFilter,
  resolveVsaScalpingGateFlags,
  resolveVsaSwingGateFlags,
  resolveVsaIntradayGateFlags,
  resolveVsaSessionGateFlags,
  resolveVsaTradeTier,
  isVsaCounterTrend,
  applyVsaEntryGates,
};
