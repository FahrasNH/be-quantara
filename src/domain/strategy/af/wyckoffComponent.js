/**
 * Wyckoff Method component for Adaptive Fusion (AF-SUB-01).
 *
 * Detects accumulation/distribution trading ranges and spring/upthrust
 * false-breakout patterns with volume confirmation (effort vs result).
 *
 * Return format: { vote: 'LONG'|'SHORT'|'NEUTRAL', confidence: 0-1, reason: string, meta? }
 */

"use strict";

const {
  relativeVolume,
  percentileRank,
  bbWidthSeries,
  smaAt,
} = require("./volumeAnalysisUtils");

const DEFAULTS = {
  minBars: 100,
  bbPeriod: 20,
  bbStdDev: 2,
  // 40 (was 30): 30th-percentile BB compression was too rare on 15m/4h → near-zero
  // spring/upthrust detections in 12m backtests (Wyckoff 0-trade).
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005, // 0.5%
  maxRangeWidthPct: 0.05,  // 5.0%
  minBarsInRange: 20,
  atrPeriod: 14,
  penetrationAtrMult: 0.5,
  recoveryWindow: 5,       // was 3 — allow slightly slower recovery confirmation
  volumeConfirmMult: 1.0,  // was 1.2 — volume ≥ SMA is enough; 1.2× over-filtered
  volumeSmaPeriod: 20,
  cooldownBars: 5,
};

/**
 * Detect a valid Wyckoff trading range ending at lastIdx.
 */
function detectTradingRange(candles, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { highs, lows, closes } = candles;
  const lastIdx = candles.lastIdx;

  if (lastIdx == null || lastIdx < cfg.minBars - 1) {
    return { isValid: false, reason: "insufficient_data" };
  }

  const widths = bbWidthSeries(closes, lastIdx, cfg.bbPeriod, cfg.bbStdDev);
  const bbWidth = widths[lastIdx];
  if (bbWidth == null) return { isValid: false, reason: "no_bb_width" };

  const bbWidthPct = percentileRank(widths, lastIdx, 100);
  if (bbWidthPct == null || bbWidthPct >= cfg.bbWidthPercentileMax) {
    return { isValid: false, reason: "bb_width_not_compressed", bbWidthPercentile: bbWidthPct };
  }

  const look = cfg.rangeLookback;
  if (lastIdx < look - 1) return { isValid: false, reason: "insufficient_range_lookback" };

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  for (let i = lastIdx - look + 1; i <= lastIdx; i++) {
    if (highs[i] != null && highs[i] > rangeHigh) rangeHigh = highs[i];
    if (lows[i] != null && lows[i] < rangeLow) rangeLow = lows[i];
  }
  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh <= rangeLow) {
    return { isValid: false, reason: "invalid_range_bounds" };
  }

  const mid = (rangeHigh + rangeLow) / 2;
  const rangeWidthPct = (rangeHigh - rangeLow) / mid;
  if (rangeWidthPct < cfg.minRangeWidthPct) {
    return { isValid: false, reason: "range_too_narrow", rangeWidthPct };
  }
  if (rangeWidthPct > cfg.maxRangeWidthPct) {
    return { isValid: false, reason: "range_too_wide", rangeWidthPct };
  }

  // Count bars that stayed mostly inside the range over a longer window
  const rangeScan = Math.max(cfg.minBarsInRange, look);
  let barsInRange = 0;
  for (let i = lastIdx - rangeScan + 1; i <= lastIdx; i++) {
    if (i < 0) continue;
    const c = closes[i];
    if (c != null && c >= rangeLow && c <= rangeHigh) barsInRange++;
  }
  if (barsInRange < cfg.minBarsInRange) {
    return { isValid: false, reason: "range_not_mature", barsInRange };
  }

  return {
    isValid: true,
    rangeHigh,
    rangeLow,
    rangeWidthPct,
    bbWidth,
    bbWidthPercentile: bbWidthPct,
    barsInRange,
  };
}

function _atrAt(candles, lastIdx, period) {
  const { highs, lows, closes, atr } = candles;
  if (atr && atr[lastIdx] != null && atr[lastIdx] > 0) return atr[lastIdx];
  if (!highs || !lows || !closes || lastIdx < period) return null;

  // Simple TR average over `period` (causal)
  let sum = 0;
  for (let i = lastIdx - period + 1; i <= lastIdx; i++) {
    const prevClose = closes[i - 1] ?? closes[i];
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose),
    );
    sum += tr;
  }
  return sum / period;
}

/**
 * Spring: false breakdown below rangeLow with recovery + volume confirm.
 * Evaluates whether a spring completed at/near lastIdx (penetration within recovery window).
 */
function detectSpring(candles, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { highs, lows, closes, opens, volumes } = candles;
  const lastIdx = candles.lastIdx;
  const atr = _atrAt(candles, lastIdx, cfg.atrPeriod);
  if (!atr || atr <= 0) return { detected: false, reason: "no_atr" };

  const volSma = smaAt(volumes, lastIdx, cfg.volumeSmaPeriod);
  // Scan for penetration bar in [lastIdx - recoveryWindow, lastIdx]
  const windowStart = Math.max(0, lastIdx - cfg.recoveryWindow);
  for (let penIdx = windowStart; penIdx <= lastIdx; penIdx++) {
    const lo = lows[penIdx];
    const vol = volumes?.[penIdx];
    if (lo == null) continue;

    const penetrationDepth = range.rangeLow - lo;
    if (penetrationDepth <= 0) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue; // too deep

    if (vol == null || vol === 0) continue;
    if (!volSma || volSma <= 0) continue;
    if (vol < cfg.volumeConfirmMult * volSma) continue;

    // Recovery: a later bar (within window) closes back above rangeLow with bullish body
    for (let r = penIdx + 1; r <= Math.min(lastIdx, penIdx + cfg.recoveryWindow); r++) {
      const cl = closes[r];
      const op = opens?.[r] ?? closes[r - 1] ?? cl;
      if (cl == null) continue;
      if (cl > range.rangeLow && cl > op) {
        const volRatio = vol / volSma;
        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_spring",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          volRatio,
        };
      }
    }
  }
  return { detected: false, reason: "no_spring" };
}

/**
 * Upthrust: false breakout above rangeHigh with recovery + volume confirm (mirror of spring).
 */
function detectUpthrust(candles, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { closes, opens, highs, volumes } = candles;
  const lastIdx = candles.lastIdx;
  const atr = _atrAt(candles, lastIdx, cfg.atrPeriod);
  if (!atr || atr <= 0) return { detected: false, reason: "no_atr" };

  const volSma = smaAt(volumes, lastIdx, cfg.volumeSmaPeriod);
  const windowStart = Math.max(0, lastIdx - cfg.recoveryWindow);
  for (let penIdx = windowStart; penIdx <= lastIdx; penIdx++) {
    const hi = highs[penIdx];
    const vol = volumes?.[penIdx];
    if (hi == null) continue;

    const penetrationDepth = hi - range.rangeHigh;
    if (penetrationDepth <= 0) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue;

    if (vol == null || vol === 0) continue;
    if (!volSma || volSma <= 0) continue;
    if (vol < cfg.volumeConfirmMult * volSma) continue;

    for (let r = penIdx + 1; r <= Math.min(lastIdx, penIdx + cfg.recoveryWindow); r++) {
      const cl = closes[r];
      const op = opens?.[r] ?? closes[r - 1] ?? cl;
      if (cl == null) continue;
      if (cl < range.rangeHigh && cl < op) {
        const volRatio = vol / volSma;
        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_upthrust",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          volRatio,
        };
      }
    }
  }
  return { detected: false, reason: "no_upthrust" };
}

/**
 * Evaluate Wyckoff component at lastIdx.
 *
 * @param {object} candles - { opens, highs, lows, closes, volumes, atr?, lastIdx }
 * @param {object} config
 * @param {{ lastSignalIdx?: number }} state - optional idempotency state
 */
function evaluateWyckoffComponent(candles, config = {}, state = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const lastIdx = candles?.lastIdx;

  if (lastIdx == null || !candles?.closes || candles.closes.length < cfg.minBars) {
    return { vote: "NEUTRAL", confidence: 0, reason: "insufficient_data" };
  }

  const vol = candles.volumes?.[lastIdx];
  if (vol == null || vol === 0) {
    return { vote: "NEUTRAL", confidence: 0, reason: "missing_volume_data" };
  }

  // Cooldown / idempotency: suppress duplicate springs within cooldownBars
  if (
    state.lastSignalIdx != null &&
    lastIdx - state.lastSignalIdx < cfg.cooldownBars
  ) {
    return { vote: "NEUTRAL", confidence: 0, reason: "cooldown_active" };
  }

  const range = detectTradingRange(candles, cfg);
  if (!range.isValid) {
    return { vote: "NEUTRAL", confidence: 0, reason: range.reason || "no_valid_range", meta: { range } };
  }

  const spring = detectSpring(candles, range, cfg);
  if (spring.detected) {
    return {
      vote: "LONG",
      confidence: spring.confidence,
      reason: spring.reason,
      meta: { range, spring },
    };
  }

  const upthrust = detectUpthrust(candles, range, cfg);
  if (upthrust.detected) {
    return {
      vote: "SHORT",
      confidence: upthrust.confidence,
      reason: upthrust.reason,
      meta: { range, upthrust },
    };
  }

  return { vote: "NEUTRAL", confidence: 0, reason: "no_pattern", meta: { range } };
}

/**
 * Build candles object from indicator arrays (StrategyBase-compatible).
 */
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
  detectTradingRange,
  detectSpring,
  detectUpthrust,
  evaluateWyckoffComponent,
  candlesFromIndicators,
  relativeVolume, // re-export for shared tests
};
