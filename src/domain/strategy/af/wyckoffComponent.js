/**
 * Wyckoff Method component for Adaptive Fusion (AF-SUB-01).
 *
 * Detects accumulation/distribution trading ranges and spring/upthrust
 * false-breakout patterns with volume confirmation (effort vs result).
 *
 * Return format: { vote: 'LONG'|'SHORT'|'NEUTRAL', confidence: 0-1, reason: string, meta? }
 *
 * Critical detection invariants (escalated 0-trade fix, Jul 2026):
 * 1. Range high/low MUST be established BEFORE the spring/upthrust scan window.
 *    Including penetration bars in range bounds makes penetrationDepth <= 0 forever.
 * 2. BB compression MUST be evaluated on the established range (pre-penetration),
 *    using mean-relative width — not percentile rank of current BB vs a mature
 *    flat lookback (equal/tight widths → percentile ≈ 100 → gate never opens).
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
  bbWidthLookback: 100,
  // Mean-relative squeeze at rangeEnd: bbWidth <= mean(bbWidth) * mult.
  // Replaces broken percentile gate (mature ranges → pct≈100 → permanent reject).
  bbWidthMeanMult: 1.05,
  // Kept for diagnostics / rollback experiments only (not the live gate).
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005, // 0.5%
  maxRangeWidthPct: 0.05,  // 5.0%
  minBarsInRange: 20,
  atrPeriod: 14,
  // Upper end of AF-SUB-01 sensitivity band (0.3–0.8); 0.5 rejected many real springs.
  penetrationAtrMult: 0.8,
  recoveryWindow: 5,       // was 3 — allow slightly slower recovery confirmation
  volumeConfirmMult: 1.0,  // was 1.2 — volume ≥ SMA is enough; 1.2× over-filtered
  volumeSmaPeriod: 20,
  cooldownBars: 5,
};

/**
 * Mean of finite values in series[start..end] (inclusive).
 * @returns {number|null}
 */
function _meanFinite(series, start, end) {
  if (!series || end < start) return null;
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    count++;
  }
  if (count === 0) return null;
  return sum / count;
}

/**
 * Detect a valid Wyckoff trading range established BEFORE the recovery window.
 *
 * rangeEndIdx = lastIdx - recoveryWindow — support/resistance from prior bars only,
 * so a spring/upthrust inside the scan window can actually pierce those levels.
 */
function detectTradingRange(candles, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { highs, lows, closes } = candles;
  const lastIdx = candles.lastIdx;

  if (lastIdx == null || lastIdx < cfg.minBars - 1) {
    return { isValid: false, reason: "insufficient_data" };
  }

  const recoveryWindow = Math.max(1, cfg.recoveryWindow | 0);
  const rangeEndIdx = lastIdx - recoveryWindow;
  if (rangeEndIdx < cfg.minBars - 1) {
    return { isValid: false, reason: "insufficient_data_pre_window" };
  }

  const widths = bbWidthSeries(closes, rangeEndIdx, cfg.bbPeriod, cfg.bbStdDev);
  const bbWidth = widths[rangeEndIdx];
  if (bbWidth == null) return { isValid: false, reason: "no_bb_width" };

  const lookback = cfg.bbWidthLookback;
  const meanStart = Math.max(0, rangeEndIdx - lookback + 1);
  const bbWidthMean = _meanFinite(widths, meanStart, rangeEndIdx);
  if (bbWidthMean == null || bbWidthMean <= 0) {
    return { isValid: false, reason: "no_bb_width_mean" };
  }
  const bbWidthRatio = bbWidth / bbWidthMean;
  // Diagnostic only — shows why the old percentile gate stayed closed on mature ranges.
  const bbWidthPct = percentileRank(widths, rangeEndIdx, lookback);
  if (bbWidthRatio > cfg.bbWidthMeanMult) {
    return {
      isValid: false,
      reason: "bb_width_not_compressed",
      bbWidth,
      bbWidthMean,
      bbWidthRatio,
      bbWidthPercentile: bbWidthPct,
      rangeEndIdx,
    };
  }

  const look = cfg.rangeLookback;
  if (rangeEndIdx < look - 1) return { isValid: false, reason: "insufficient_range_lookback" };

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  const rangeStart = rangeEndIdx - look + 1;
  for (let i = rangeStart; i <= rangeEndIdx; i++) {
    if (highs[i] != null && highs[i] > rangeHigh) rangeHigh = highs[i];
    if (lows[i] != null && lows[i] < rangeLow) rangeLow = lows[i];
  }
  if (!Number.isFinite(rangeHigh) || !Number.isFinite(rangeLow) || rangeHigh <= rangeLow) {
    return { isValid: false, reason: "invalid_range_bounds" };
  }

  const mid = (rangeHigh + rangeLow) / 2;
  const rangeWidthPct = (rangeHigh - rangeLow) / mid;
  if (rangeWidthPct < cfg.minRangeWidthPct) {
    return { isValid: false, reason: "range_too_narrow", rangeWidthPct, rangeEndIdx };
  }
  if (rangeWidthPct > cfg.maxRangeWidthPct) {
    return { isValid: false, reason: "range_too_wide", rangeWidthPct, rangeEndIdx };
  }

  // Count bars that stayed mostly inside the established range (pre-penetration).
  const rangeScan = Math.max(cfg.minBarsInRange, look);
  let barsInRange = 0;
  for (let i = rangeEndIdx - rangeScan + 1; i <= rangeEndIdx; i++) {
    if (i < 0) continue;
    const c = closes[i];
    if (c != null && c >= rangeLow && c <= rangeHigh) barsInRange++;
  }
  if (barsInRange < cfg.minBarsInRange) {
    return { isValid: false, reason: "range_not_mature", barsInRange, rangeEndIdx };
  }

  return {
    isValid: true,
    rangeHigh,
    rangeLow,
    rangeWidthPct,
    bbWidth,
    bbWidthMean,
    bbWidthRatio,
    bbWidthPercentile: bbWidthPct,
    barsInRange,
    rangeEndIdx,
    rangeStartIdx: rangeStart,
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
 * Volume SMA ending just before the penetration bar (avoids self-inflating the baseline).
 */
function _volumeBaseline(volumes, penIdx, period) {
  if (!volumes || penIdx <= 0) return null;
  const end = penIdx - 1;
  if (end < period - 1) return smaAt(volumes, penIdx, period);
  return smaAt(volumes, end, period);
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

  // Scan for penetration bar in [lastIdx - recoveryWindow, lastIdx]
  const windowStart = Math.max(0, lastIdx - cfg.recoveryWindow);
  // Do not scan bars that defined the range itself
  const minPenIdx =
    range.rangeEndIdx != null ? Math.max(windowStart, range.rangeEndIdx + 1) : windowStart;

  for (let penIdx = minPenIdx; penIdx <= lastIdx; penIdx++) {
    const lo = lows[penIdx];
    const vol = volumes?.[penIdx];
    if (lo == null) continue;

    const penetrationDepth = range.rangeLow - lo;
    if (penetrationDepth <= 0) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue; // too deep

    if (vol == null || vol === 0) continue;
    const volSma = _volumeBaseline(volumes, penIdx, cfg.volumeSmaPeriod);
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

  const windowStart = Math.max(0, lastIdx - cfg.recoveryWindow);
  const minPenIdx =
    range.rangeEndIdx != null ? Math.max(windowStart, range.rangeEndIdx + 1) : windowStart;

  for (let penIdx = minPenIdx; penIdx <= lastIdx; penIdx++) {
    const hi = highs[penIdx];
    const vol = volumes?.[penIdx];
    if (hi == null) continue;

    const penetrationDepth = hi - range.rangeHigh;
    if (penetrationDepth <= 0) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue;

    if (vol == null || vol === 0) continue;
    const volSma = _volumeBaseline(volumes, penIdx, cfg.volumeSmaPeriod);
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
