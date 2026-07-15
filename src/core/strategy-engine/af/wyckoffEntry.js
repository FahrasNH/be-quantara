/**
 * Wyckoff Method component for Adaptive Fusion (AF-SUB-01).
 *
 * Detection formulas aligned with wyckoff_indicator.txt (Kingshuk Ghosh schematic).
 * Entry gating follows Syarat_Entry_Strategi_Wyckoff.txt:
 *   Long  : Downtrend → Accumulation → Spring → Reclaim → CHoCH → (SOS → LPS)
 *   Short : Uptrend → Distribution → UTAD → Rejection → CHoCH → (SOW → LPSY)
 *
 * entryModel:
 *   aggressive  — Spring/UTAD + reclaim/rejection + volume (legacy AF race)
 *   moderate    — + prior trend + rejection wick + local CHoCH/BOS (default)
 *   conservative— + SOS/SOW + LPS/LPSY retest (safest formula)
 *
 * Return: { vote: 'LONG'|'SHORT'|'NEUTRAL', confidence: 0-1, reason: string, meta? }
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
  // ── Indicator params (wyckoff_indicator.txt) ─────────────────────────────
  lookback: 100,
  volMultiplier: 1.5,
  climaxVolExtra: 0.5,
  zigzagLength: 4,
  springLookback: 20,
  climaxLookback: 30,
  psLookback: 50,
  avgRangePeriod: 20,
  // ── Range / AF invariants ────────────────────────────────────────────────
  bbPeriod: 20,
  bbStdDev: 2,
  bbWidthLookback: 100,
  bbWidthMeanMult: 1.05,
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005,
  maxRangeWidthPct: 0.05,
  minBarsInRange: 20,
  atrPeriod: 14,
  penetrationAtrMult: 0.8,
  recoveryWindow: 5,
  volumeConfirmMult: 1.0,
  volumeSmaPeriod: 20,
  cooldownBars: 5,
  // ── Entry gates (Syarat_Entry_Strategi_Wyckoff.txt) ───────────────────────
  // Aggressive = AF race / standalone Scalping-viable path. Moderate/conservative
  // Syarat checklist is opt-in via config.entryModel (not the strategy default).
  entryModel: "aggressive", // aggressive | moderate | conservative
  priorTrendBars: 40,
  priorTrendMinSlopePct: 0.01, // 1% net move before range
  rejectionWickRatio: 0.45, // lower/upper wick share of candle range
  chochLookback: 12,
  minRr: 2.0,
  maxEntryProximityPct: 0.35, // reject if entry is within 35% of opposite side of range
  eventScanBars: 80,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

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

function _highest(arr, endIdx, period) {
  if (!arr || endIdx < 0 || period <= 0) return null;
  const start = Math.max(0, endIdx - period + 1);
  let hi = -Infinity;
  for (let i = start; i <= endIdx; i++) {
    const v = arr[i];
    if (v != null && v > hi) hi = v;
  }
  return Number.isFinite(hi) ? hi : null;
}

function _lowest(arr, endIdx, period) {
  if (!arr || endIdx < 0 || period <= 0) return null;
  const start = Math.max(0, endIdx - period + 1);
  let lo = Infinity;
  for (let i = start; i <= endIdx; i++) {
    const v = arr[i];
    if (v != null && v < lo) lo = v;
  }
  return Number.isFinite(lo) ? lo : null;
}

function _sma(arr, endIdx, period) {
  return smaAt(arr, endIdx, period);
}

function _atrAt(candles, lastIdx, period) {
  const { highs, lows, closes, atr } = candles;
  if (atr && atr[lastIdx] != null && atr[lastIdx] > 0) return atr[lastIdx];
  if (!highs || !lows || !closes || lastIdx < period) return null;

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

function _volumeBaseline(volumes, penIdx, period) {
  if (!volumes || penIdx <= 0) return null;
  const end = penIdx - 1;
  if (end < period - 1) return smaAt(volumes, penIdx, period);
  return smaAt(volumes, end, period);
}

function _candleRange(high, low) {
  if (high == null || low == null) return 0;
  return Math.max(0, high - low);
}

function _isBullishRejection(o, h, l, c, wickRatio) {
  if (o == null || h == null || l == null || c == null) return false;
  const rng = _candleRange(h, l);
  if (rng <= 0) return false;
  const lowerWick = Math.min(o, c) - l;
  const bullish = c > o;
  return bullish && lowerWick / rng >= wickRatio;
}

function _isBearishRejection(o, h, l, c, wickRatio) {
  if (o == null || h == null || l == null || c == null) return false;
  const rng = _candleRange(h, l);
  if (rng <= 0) return false;
  const upperWick = h - Math.max(o, c);
  const bearish = c < o;
  return bearish && upperWick / rng >= wickRatio;
}

// ═══════════════════════════════════════════════════════════════════════════
// Trading range (AF invariant: bounds established BEFORE recovery window)
// ═══════════════════════════════════════════════════════════════════════════

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

  // Prefer indicator lookback for S/R when available; fall back to rangeLookback.
  const look = Math.max(cfg.rangeLookback, Math.min(cfg.lookback, rangeEndIdx + 1));
  if (rangeEndIdx < cfg.rangeLookback - 1) {
    return { isValid: false, reason: "insufficient_range_lookback" };
  }

  let rangeHigh = -Infinity;
  let rangeLow = Infinity;
  const rangeStart = rangeEndIdx - Math.min(look, cfg.rangeLookback) + 1;
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

  const rangeScan = Math.max(cfg.minBarsInRange, cfg.rangeLookback);
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
    midRange: mid,
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

// ═══════════════════════════════════════════════════════════════════════════
// Indicator-aligned event detection (wyckoff_indicator.txt)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Evaluate Wyckoff schematic events at a single bar index.
 * Mirrors Pine conditions where arrays allow causal equivalents.
 */
function detectEventsAt(candles, idx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { opens, highs, lows, closes, volumes } = candles;
  if (idx == null || idx < 1) return null;

  const o = opens?.[idx];
  const h = highs?.[idx];
  const l = lows?.[idx];
  const c = closes?.[idx];
  const v = volumes?.[idx];
  if (c == null || h == null || l == null || v == null) return null;

  const avgVol = _sma(volumes, idx, cfg.lookback);
  const avgRange = (() => {
    const start = Math.max(0, idx - cfg.avgRangePeriod + 1);
    let sum = 0;
    let n = 0;
    for (let i = start; i <= idx; i++) {
      if (highs[i] != null && lows[i] != null) {
        sum += highs[i] - lows[i];
        n++;
      }
    }
    return n > 0 ? sum / n : null;
  })();

  const highestHigh = _highest(highs, idx, cfg.lookback);
  const lowestLow = _lowest(lows, idx, cfg.lookback);
  const midRange =
    highestHigh != null && lowestLow != null ? (highestHigh + lowestLow) / 2 : null;
  const rangeSize =
    highestHigh != null && lowestLow != null ? highestHigh - lowestLow : null;

  const highVolume = avgVol != null && v > avgVol * cfg.volMultiplier;
  const climaxVolume =
    avgVol != null && v > avgVol * (cfg.volMultiplier + cfg.climaxVolExtra);
  const narrowRange =
    avgRange != null && avgRange > 0 && h - l < avgRange * 0.6;

  const prevClose = closes[idx - 1];
  const bullish = o != null && c > o;
  const bearish = o != null && c < o;

  // --- Accumulation ---
  const lowest50 = _lowest(lows, idx, cfg.psLookback);
  const ps = lowest50 != null && l === lowest50 && highVolume && bullish;

  const lowest30 = _lowest(lows, idx, cfg.climaxLookback);
  const sc =
    climaxVolume &&
    bearish &&
    lowest30 != null &&
    l <= lowest30 &&
    prevClose != null &&
    c < prevClose;

  // AR: rally after a low in prior bar that was ~30-bar low
  const prevLow = lows[idx - 1];
  const lowest30Prev = _lowest(lows, idx - 1, cfg.climaxLookback);
  const ar =
    bullish &&
    avgVol != null &&
    v > avgVol &&
    prevLow != null &&
    lowest30Prev != null &&
    prevLow === lowest30Prev &&
    prevClose != null &&
    c > prevClose * 1.01;

  // Spring (indicator same-bar): pierce prior 20-bar low, bullish close, vol > avg, close off lows
  const lowest20Prev = _lowest(lows, idx - 1, cfg.springLookback);
  const springInd =
    lowest20Prev != null &&
    l < lowest20Prev &&
    bullish &&
    avgVol != null &&
    v > avgVol &&
    c > l * 1.01;

  // SOS
  const sos =
    prevClose != null &&
    c > prevClose &&
    avgVol != null &&
    v > avgVol * 1.3 &&
    avgRange != null &&
    o != null &&
    c - o > avgRange &&
    midRange != null &&
    c > midRange;

  // --- Distribution ---
  const highest50 = _highest(highs, idx, cfg.psLookback);
  const psy = highest50 != null && h === highest50 && highVolume && bearish;

  const highest30 = _highest(highs, idx, cfg.climaxLookback);
  const bc =
    climaxVolume &&
    bullish &&
    highest30 != null &&
    h >= highest30;

  const prevHigh = highs[idx - 1];
  const highest30Prev = _highest(highs, idx - 1, cfg.climaxLookback);
  const arDist =
    bearish &&
    avgVol != null &&
    v > avgVol &&
    prevHigh != null &&
    highest30Prev != null &&
    prevHigh === highest30Prev &&
    prevClose != null &&
    c < prevClose * 0.99;

  const highest20Prev = _highest(highs, idx - 1, cfg.springLookback);
  const utadInd =
    highest20Prev != null &&
    h > highest20Prev &&
    bearish &&
    avgVol != null &&
    v > avgVol &&
    c < h * 0.99;

  // SOW (mirror of SOS — not explicit in Pine, derived for entry checklist)
  const sow =
    prevClose != null &&
    c < prevClose &&
    avgVol != null &&
    v > avgVol * 1.3 &&
    avgRange != null &&
    o != null &&
    o - c > avgRange &&
    midRange != null &&
    c < midRange;

  return {
    idx,
    avgVol,
    avgRange,
    midRange,
    rangeSize,
    highVolume,
    climaxVolume,
    narrowRange,
    ps: !!ps,
    sc: !!sc,
    ar: !!ar,
    springInd: !!springInd,
    sos: !!sos,
    psy: !!psy,
    bc: !!bc,
    arDist: !!arDist,
    utadInd: !!utadInd,
    sow: !!sow,
  };
}

/**
 * Scan recent bars for schematic events used by entry checklist.
 */
function scanRecentEvents(candles, lastIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const start = Math.max(1, lastIdx - cfg.eventScanBars);
  const events = {
    sc: [],
    ar: [],
    springInd: [],
    sos: [],
    bc: [],
    arDist: [],
    utadInd: [],
    sow: [],
    lps: [],
    lpsy: [],
  };

  let lastScLow = null;
  let lastSpringLow = null;
  let lastBcHigh = null;
  let lastUtadHigh = null;

  for (let i = start; i <= lastIdx; i++) {
    const e = detectEventsAt(candles, i, cfg);
    if (!e) continue;

    if (e.sc) {
      events.sc.push(i);
      lastScLow = candles.lows[i];
    }
    if (e.ar) events.ar.push(i);
    if (e.springInd) {
      events.springInd.push(i);
      lastSpringLow = candles.lows[i];
    }
    if (e.sos) events.sos.push(i);
    if (e.bc) {
      events.bc.push(i);
      lastBcHigh = candles.highs[i];
    }
    if (e.arDist) events.arDist.push(i);
    if (e.utadInd) {
      events.utadInd.push(i);
      lastUtadHigh = candles.highs[i];
    }
    if (e.sow) events.sow.push(i);

    // ST / LPS / LPSY — need prior climax / spring / utad reference
    const o = candles.opens?.[i];
    const c = candles.closes?.[i];
    const l = candles.lows?.[i];
    const h = candles.highs?.[i];
    const v = candles.volumes?.[i];
    const avgVol = e.avgVol;
    const mid = e.midRange;
    const bullish = o != null && c != null && c > o;
    const bearish = o != null && c != null && c < o;

    // ST (accumulation): test near SC low with lower volume, bullish close
    if (
      lastScLow != null &&
      l != null &&
      avgVol != null &&
      l < lastScLow * 1.005 &&
      l > lastScLow * 0.995 &&
      v < avgVol &&
      bullish
    ) {
      // tracked implicitly via sc/ar presence
    }

    // LPS: higher low vs spring/ST, bullish, below-avg volume, close > mid
    const refLow = lastSpringLow ?? lastScLow;
    if (
      refLow != null &&
      l != null &&
      l > refLow &&
      bullish &&
      avgVol != null &&
      v < avgVol &&
      mid != null &&
      c > mid
    ) {
      events.lps.push(i);
    }

    // LPSY: lower high vs UTAD/ST dist, bearish, below-avg volume, close < mid
    const refHigh = lastUtadHigh ?? lastBcHigh;
    if (
      refHigh != null &&
      h != null &&
      h < refHigh &&
      bearish &&
      avgVol != null &&
      v < avgVol &&
      mid != null &&
      c < mid
    ) {
      events.lpsy.push(i);
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
// Prior trend & structure (CHoCH / BOS)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect trend preceding the trading range.
 * Accumulation wants prior downtrend; distribution wants prior uptrend.
 */
function detectPriorTrend(candles, rangeStartIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { closes, highs, lows } = candles;
  const end = Math.max(0, rangeStartIdx - 1);
  const start = Math.max(0, end - cfg.priorTrendBars + 1);
  if (end - start < 10) {
    return { direction: "unknown", reason: "insufficient_prior_bars" };
  }

  const first = closes[start];
  const last = closes[end];
  if (first == null || last == null || first <= 0) {
    return { direction: "unknown", reason: "missing_closes" };
  }

  const slopePct = (last - first) / first;
  const mid = Math.floor((start + end) / 2);
  const earlyHigh = _highest(highs, mid, mid - start + 1);
  const lateHigh = _highest(highs, end, end - mid);
  const earlyLow = _lowest(lows, mid, mid - start + 1);
  const lateLow = _lowest(lows, end, end - mid);

  let structure = "mixed";
  if (
    earlyHigh != null &&
    lateHigh != null &&
    earlyLow != null &&
    lateLow != null
  ) {
    if (lateHigh < earlyHigh && lateLow < earlyLow) structure = "lower_highs_lows";
    else if (lateHigh > earlyHigh && lateLow > earlyLow) structure = "higher_highs_lows";
  }

  let direction = "sideways";
  if (slopePct <= -cfg.priorTrendMinSlopePct || structure === "lower_highs_lows") {
    direction = "down";
  } else if (slopePct >= cfg.priorTrendMinSlopePct || structure === "higher_highs_lows") {
    direction = "up";
  }

  return { direction, slopePct, structure, start, end };
}

/**
 * Local CHoCH / BOS after a manipulation bar.
 * Bullish: close breaks above recent swing high after spring.
 * Bearish: close breaks below recent swing low after UTAD.
 */
function detectLocalChoCH(candles, fromIdx, toIdx, side, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { highs, lows, closes } = candles;
  if (fromIdx == null || toIdx == null || toIdx <= fromIdx) {
    return { detected: false, reason: "window_too_short" };
  }

  const look = Math.min(cfg.chochLookback, fromIdx);
  if (side === "bullish") {
    const swingHigh = _highest(highs, fromIdx - 1, look);
    if (swingHigh == null) return { detected: false, reason: "no_swing_high" };
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      if (closes[i] != null && closes[i] > swingHigh) {
        return { detected: true, idx: i, level: swingHigh, type: "bullish_choch" };
      }
    }
    return { detected: false, reason: "no_bullish_choch" };
  }

  const swingLow = _lowest(lows, fromIdx - 1, look);
  if (swingLow == null) return { detected: false, reason: "no_swing_low" };
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    if (closes[i] != null && closes[i] < swingLow) {
      return { detected: true, idx: i, level: swingLow, type: "bearish_choch" };
    }
  }
  return { detected: false, reason: "no_bearish_choch" };
}

// ═══════════════════════════════════════════════════════════════════════════
// Spring / Upthrust (AF recovery model — kept for race + unit tests)
// ═══════════════════════════════════════════════════════════════════════════

function detectSpring(candles, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { highs, lows, closes, opens, volumes } = candles;
  const lastIdx = candles.lastIdx;
  const atr = _atrAt(candles, lastIdx, cfg.atrPeriod);
  if (!atr || atr <= 0) return { detected: false, reason: "no_atr" };

  const windowStart = Math.max(0, lastIdx - cfg.recoveryWindow);
  const minPenIdx =
    range.rangeEndIdx != null ? Math.max(windowStart, range.rangeEndIdx + 1) : windowStart;

  for (let penIdx = minPenIdx; penIdx <= lastIdx; penIdx++) {
    const lo = lows[penIdx];
    const vol = volumes?.[penIdx];
    if (lo == null) continue;

    const penetrationDepth = range.rangeLow - lo;
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
      if (cl > range.rangeLow && cl > op) {
        const volRatio = vol / volSma;
        const rejection = _isBullishRejection(
          opens?.[penIdx] ?? op,
          highs?.[penIdx],
          lows[penIdx],
          closes?.[penIdx] ?? cl,
          cfg.rejectionWickRatio,
        ) || _isBullishRejection(op, highs?.[r], lows?.[r], cl, cfg.rejectionWickRatio);

        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_spring",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          volRatio,
          rejection,
          springLow: lo,
        };
      }
    }
  }
  return { detected: false, reason: "no_spring" };
}

function detectUpthrust(candles, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const { closes, opens, highs, lows, volumes } = candles;
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
        const rejection = _isBearishRejection(
          opens?.[penIdx] ?? op,
          highs[penIdx],
          lows?.[penIdx],
          closes?.[penIdx] ?? cl,
          cfg.rejectionWickRatio,
        ) || _isBearishRejection(op, highs?.[r], lows?.[r], cl, cfg.rejectionWickRatio);

        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_upthrust",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          volRatio,
          rejection,
          utadHigh: hi,
        };
      }
    }
  }
  return { detected: false, reason: "no_upthrust" };
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry checklist (Syarat_Entry_Strategi_Wyckoff.txt)
// ═══════════════════════════════════════════════════════════════════════════

function _entryProximityOk(side, entryPrice, range, maxPct) {
  const width = range.rangeHigh - range.rangeLow;
  if (width <= 0 || entryPrice == null) return false;
  if (side === "LONG") {
    // Prefer discount / lower half — reject if too close to resistance
    const distToRes = range.rangeHigh - entryPrice;
    return distToRes / width >= 1 - maxPct;
  }
  const distToSup = entryPrice - range.rangeLow;
  return distToSup / width >= 1 - maxPct;
}

function _estimateRr(side, entry, invalidation, range) {
  if (entry == null || invalidation == null || !range) return null;
  const risk = Math.abs(entry - invalidation);
  if (risk <= 0) return null;
  const target =
    side === "LONG"
      ? range.midRange ?? (range.rangeHigh + range.rangeLow) / 2
      : range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
  // Prefer opposite side of range as primary structural target
  const structuralTarget = side === "LONG" ? range.rangeHigh : range.rangeLow;
  const reward = Math.abs(structuralTarget - entry);
  return reward / risk;
}

/**
 * Build LONG / SHORT entry decision from pattern + checklist layers.
 */
function evaluateEntryChecklist(candles, range, pattern, side, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const lastIdx = candles.lastIdx;
  const model = cfg.entryModel || "moderate";
  const events = scanRecentEvents(candles, lastIdx, cfg);
  const prior = detectPriorTrend(candles, range.rangeStartIdx ?? range.rangeEndIdx, cfg);

  const checklist = {
    priorTrend: false,
    tradingRange: range.isValid === true,
    climaxOrWeakening: false,
    manipulation: false, // Spring / UTAD
    reclaimOrReject: false,
    rejection: false,
    volumeConfirm: false,
    choch: false,
    sosOrSow: false,
    lpsOrLpsy: false,
    proximityOk: false,
    rrOk: false,
  };

  const entryPrice = candles.closes[lastIdx];
  let invalidation = null;
  let choch = { detected: false };

  if (side === "LONG") {
    checklist.priorTrend = prior.direction === "down" || model === "aggressive";
    checklist.climaxOrWeakening =
      events.sc.length > 0 || events.ar.length > 0 || model === "aggressive";
    checklist.manipulation = !!pattern?.detected;
    checklist.reclaimOrReject =
      pattern?.recoveryIdx != null &&
      candles.closes[pattern.recoveryIdx] > range.rangeLow;
    checklist.rejection = !!pattern?.rejection || model === "aggressive";
    checklist.volumeConfirm =
      pattern?.volRatio != null && pattern.volRatio >= cfg.volumeConfirmMult;
    choch = detectLocalChoCH(
      candles,
      pattern.penIdx,
      lastIdx,
      "bullish",
      cfg,
    );
    checklist.choch = choch.detected || model === "aggressive";
    checklist.sosOrSow =
      events.sos.some((i) => i >= (pattern.penIdx ?? 0)) || model !== "conservative";
    checklist.lpsOrLpsy =
      events.lps.some((i) => i >= (pattern.recoveryIdx ?? pattern.penIdx ?? 0)) ||
      model !== "conservative";
    invalidation =
      pattern.springLow ??
      (pattern.penIdx != null ? candles.lows[pattern.penIdx] : range.rangeLow);
    checklist.proximityOk = _entryProximityOk("LONG", entryPrice, range, cfg.maxEntryProximityPct);
  } else {
    checklist.priorTrend = prior.direction === "up" || model === "aggressive";
    checklist.climaxOrWeakening =
      events.bc.length > 0 || events.arDist.length > 0 || model === "aggressive";
    checklist.manipulation = !!pattern?.detected;
    checklist.reclaimOrReject =
      pattern?.recoveryIdx != null &&
      candles.closes[pattern.recoveryIdx] < range.rangeHigh;
    checklist.rejection = !!pattern?.rejection || model === "aggressive";
    checklist.volumeConfirm =
      pattern?.volRatio != null && pattern.volRatio >= cfg.volumeConfirmMult;
    choch = detectLocalChoCH(
      candles,
      pattern.penIdx,
      lastIdx,
      "bearish",
      cfg,
    );
    checklist.choch = choch.detected || model === "aggressive";
    checklist.sosOrSow =
      events.sow.some((i) => i >= (pattern.penIdx ?? 0)) || model !== "conservative";
    checklist.lpsOrLpsy =
      events.lpsy.some((i) => i >= (pattern.recoveryIdx ?? pattern.penIdx ?? 0)) ||
      model !== "conservative";
    invalidation =
      pattern.utadHigh ??
      (pattern.penIdx != null ? candles.highs[pattern.penIdx] : range.rangeHigh);
    checklist.proximityOk = _entryProximityOk("SHORT", entryPrice, range, cfg.maxEntryProximityPct);
  }

  const rr = _estimateRr(side, entryPrice, invalidation, range);
  checklist.rrOk = rr != null && rr >= cfg.minRr;

  // Required layers by model
  const required = ["tradingRange", "manipulation", "reclaimOrReject", "volumeConfirm"];
  if (model === "moderate" || model === "conservative") {
    required.push("priorTrend", "rejection", "choch", "proximityOk", "rrOk");
  }
  if (model === "conservative") {
    required.push("climaxOrWeakening", "sosOrSow", "lpsOrLpsy");
  }

  const failed = required.filter((k) => !checklist[k]);
  const passed = failed.length === 0;

  // Confidence: base pattern confidence × checklist fill rate
  const keys = Object.keys(checklist);
  const hit = keys.filter((k) => checklist[k]).length;
  const fill = hit / keys.length;
  const confidence = Math.min(1, (pattern.confidence || 0.5) * (0.5 + 0.5 * fill));

  return {
    passed,
    failed,
    checklist,
    model,
    prior,
    events,
    choch,
    entryPrice,
    invalidation,
    rr,
    confidence,
    reason: passed
      ? side === "LONG"
        ? "wyckoff_spring"
        : "wyckoff_upthrust"
      : `entry_checklist_failed:${failed.join(",")}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public evaluate
// ═══════════════════════════════════════════════════════════════════════════

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

  if (
    state.lastSignalIdx != null &&
    lastIdx - state.lastSignalIdx < cfg.cooldownBars
  ) {
    return { vote: "NEUTRAL", confidence: 0, reason: "cooldown_active" };
  }

  const range = detectTradingRange(candles, cfg);
  if (!range.isValid) {
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: range.reason || "no_valid_range",
      meta: { range },
    };
  }

  const spring = detectSpring(candles, range, cfg);
  if (spring.detected) {
    const entry = evaluateEntryChecklist(candles, range, spring, "LONG", cfg);
    if (entry.passed) {
      return {
        vote: "LONG",
        confidence: entry.confidence,
        reason: entry.reason,
        meta: {
          range,
          spring,
          entry,
          stopLoss: entry.invalidation,
          takeProfit: range.rangeHigh,
          rr: entry.rr,
        },
      };
    }
    // Fall through to check short only if long checklist failed without spring? No — spring found but gated.
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: entry.reason,
      meta: { range, spring, entry },
    };
  }

  const upthrust = detectUpthrust(candles, range, cfg);
  if (upthrust.detected) {
    const entry = evaluateEntryChecklist(candles, range, upthrust, "SHORT", cfg);
    if (entry.passed) {
      return {
        vote: "SHORT",
        confidence: entry.confidence,
        reason: entry.reason,
        meta: {
          range,
          upthrust,
          entry,
          stopLoss: entry.invalidation,
          takeProfit: range.rangeLow,
          rr: entry.rr,
        },
      };
    }
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: entry.reason,
      meta: { range, upthrust, entry },
    };
  }

  // Conservative path: LPS / LPSY without fresh spring/UTAD in window
  if (cfg.entryModel === "conservative") {
    const events = scanRecentEvents(candles, lastIdx, cfg);
    const lastLps = events.lps[events.lps.length - 1];
    const lastLpsy = events.lpsy[events.lpsy.length - 1];
    const prior = detectPriorTrend(candles, range.rangeStartIdx ?? range.rangeEndIdx, cfg);

    if (
      lastLps != null &&
      lastLps >= lastIdx - cfg.recoveryWindow &&
      events.sos.length > 0 &&
      (events.springInd.length > 0 || events.sc.length > 0) &&
      prior.direction === "down"
    ) {
      return {
        vote: "LONG",
        confidence: 0.7,
        reason: "wyckoff_lps",
        meta: { range, events, prior, stopLoss: range.rangeLow, takeProfit: range.rangeHigh },
      };
    }
    if (
      lastLpsy != null &&
      lastLpsy >= lastIdx - cfg.recoveryWindow &&
      events.sow.length > 0 &&
      (events.utadInd.length > 0 || events.bc.length > 0) &&
      prior.direction === "up"
    ) {
      return {
        vote: "SHORT",
        confidence: 0.7,
        reason: "wyckoff_lpsy",
        meta: { range, events, prior, stopLoss: range.rangeHigh, takeProfit: range.rangeLow },
      };
    }
  }

  return { vote: "NEUTRAL", confidence: 0, reason: "no_pattern", meta: { range } };
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
  detectTradingRange,
  detectSpring,
  detectUpthrust,
  detectEventsAt,
  scanRecentEvents,
  detectPriorTrend,
  detectLocalChoCH,
  evaluateEntryChecklist,
  evaluateWyckoffComponent,
  candlesFromIndicators,
  relativeVolume,
};
