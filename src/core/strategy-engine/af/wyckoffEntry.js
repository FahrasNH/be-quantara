/**
 * Wyckoff Method component for Adaptive Fusion (AF-SUB-01).
 *
 * Detection formulas aligned with wyckoff_indicator.txt (Kingshuk Ghosh schematic).
 * Entry gating follows syarat_entry_wyckoff.txt:
 *   Long  : Downtrend → Accumulation → Spring → Reclaim → CHoCH → (SOS → LPS)
 *   Short : Uptrend → Distribution → UTAD → Rejection → CHoCH → (SOW → LPSY)
 *
 * entryModel:
 *   aggressive  — Spring/UTAD + reclaim + volume (legacy AF race / opt-in)
 *   moderate    — Syarat checklist (§4–5): prior trend, rejection, CHoCH, discount/premium, RR≥1:2
 *   conservative— safest formula (§11): + SC/BC + SOS/SOW + LPS/LPSY retest
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
const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: Wyckoff-owned Scalping session filter (Asia block). */
function applyWyckoffSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

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
  bbWidthMeanMult: 0.98,
  bbWidthPercentileMax: 40,
  rangeLookback: 20,
  minRangeWidthPct: 0.005,
  maxRangeWidthPct: 0.045,
  minBarsInRange: 20,
  atrPeriod: 14,
  // Max pierce depth (deeper = breakdown, not spring). Min filters noise ticks.
  penetrationAtrMult: 0.85,
  minPenetrationAtrMult: 0.2,
  recoveryWindow: 5,
  // Require above-average volume on the liquidity grab (≥1.3× SMA).
  volumeConfirmMult: 1.3,
  volumeSmaPeriod: 20,
  cooldownBars: 5,
  // BTC frequency profile: target ~50–150 Intraday fills/year on BTCUSDT.
  // (Selective atr≥0.36 + no-sideways ≈15 trades & +EV; user chose volume.)
  entryModel: "balanced", // aggressive | balanced | moderate | conservative
  priorTrendBars: 40,
  priorTrendMinSlopePct: 0.01, // 1% net move before range
  rejectionWickRatio: 0.4, // lower/upper wick share of candle range
  chochLookback: 12,
  minRr: 2.0,
  maxEntryProximityPct: 0.4, // entry must stay in discount (long) / premium (short)
  eventScanBars: 80,
  minRangeTouches: 2, // S/R tested at least twice (Syarat §1)
  cancelConfirmBars: 2, // bars to confirm invalidation breakdown/breakout
  // Only enter on the reclaim/rejection close (no delayed chase).
  requireReclaimOnLastBar: true,
  requireHtfAlign: true,
  allowHtfSideways: true,
  // LONG on SIDEWAYS was the bleed in BTC 12m real (WR 12.5% vs SHORT 39%).
  sidewaysShortOnly: true,
  allowHtfSidewaysLong: false,
  longVolumeConfirmMult: 1.45,
  shortVolumeConfirmMult: 1.2,
  minSlAtrMult: 0.9,
  // Per-leg profile key (set by executor / typeOverrides spread): Scalping|Intraday|Swing
  tradeType: null,
  // Scalping: skip raw UT noise — "lpsy_only" | "ut_and_lpsy" (default) | "ut_only"
  scalpPatternMode: "ut_and_lpsy",
  // Optional UTC hour blocklist (lossy cluster filter), e.g. [16,17,18,19,20,21]
  blockedUtcHours: null,
};

/**
 * Trade-type profiles — Wyckoff behaviour is grouped by TF leg.
 * typeOverrides / job config still win on conflict; these are the baseline
 * differences so Scalping is not forced to share Intraday/Swing entry physics.
 */
const TRADE_TYPE_PROFILES = Object.freeze({
  Scalping: {
    // 5m bank mode: maker + SL floor; block toxic UTC, keep volume hours.
    entryModel: "balanced",
    scalpPatternMode: "ut_and_lpsy",
    wyckoffSessionFilter: false,
    blockedUtcHours: [0, 4, 15, 16, 17, 19, 20, 21],
    allowHtfSideways: false,
    allowLpsyFlexPrior: true,
    blockLong: true,
    volumeConfirmMult: 1.05,
    shortVolumeConfirmMult: 1.05,
    cooldownBars: 0,
    recoveryWindow: 4,
    minBarsInRange: 6,
    minRr: 2.0,
    requireReclaimOnLastBar: true,
    requireHtfAlign: true,
    sidewaysShortOnly: true,
    allowHtfSidewaysLong: false,
  },
  Intraday: {
    entryModel: "balanced",
    scalpPatternMode: "ut_and_lpsy",
    blockLong: true,
    allowLpsyFlexPrior: true,
    allowHtfSideways: true,
    sidewaysShortOnly: true,
    blockedUtcHours: [3, 8, 9, 12, 13, 16, 17, 19, 22],
  },
  Swing: {
    entryModel: "aggressive",
    scalpPatternMode: "ut_and_lpsy",
    requireHtfAlign: true,
    allowHtfSideways: false,
    allowHtfSidewaysLong: false,
    blockLong: true,
    blockShort: false,
    wyckoffSwingShelved: false,
    // Volume contribution; size via typeOverrides.riskMult 0.25
    blockedUtcHours: [8, 12],
    atrRelMin: 0.4,
    volumeConfirmMult: 0.6,
    shortVolumeConfirmMult: 0.6,
    minBarsInRange: 2,
    minRr: 1.6,
  },
});

function resolveWyckoffConfig(config = {}) {
  const tradeType = config.tradeType
    || config.type
    || (config.enabledComponents?.length === 1 ? config.enabledComponents[0] : null);
  const profile = (tradeType && TRADE_TYPE_PROFILES[tradeType]) || {};
  return { ...DEFAULTS, ...profile, ...config, tradeType: tradeType || config.tradeType || null };
}

function isBlockedUtcHour(candles, lastIdx, blockedHours) {
  if (!Array.isArray(blockedHours) || !blockedHours.length) return false;
  const ts = candles?.timestamps?.[lastIdx] ?? candles?.opensTime?.[lastIdx] ?? null;
  if (ts == null || !Number.isFinite(+ts)) return false;
  const hour = new Date(+ts).getUTCHours();
  return blockedHours.includes(hour);
}

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

function _isBullishRejection(o, h, l, c, wickRatio, prevO, prevC) {
  if (o == null || h == null || l == null || c == null) return false;
  const rng = _candleRange(h, l);
  if (rng <= 0) return false;
  const lowerWick = Math.min(o, c) - l;
  const bullish = c > o;
  // Syarat §2A: long lower wick, or seller fails to close near lows (CLV high)
  const longWick = bullish && lowerWick / rng >= wickRatio;
  const closeOffLows = bullish && (c - l) / rng >= 0.6;
  // Bullish engulfing of prior bearish bar
  const engulf =
    bullish &&
    prevO != null &&
    prevC != null &&
    prevC < prevO &&
    c >= prevO &&
    o <= prevC;
  return longWick || closeOffLows || engulf;
}

function _isBearishRejection(o, h, l, c, wickRatio, prevO, prevC) {
  if (o == null || h == null || l == null || c == null) return false;
  const rng = _candleRange(h, l);
  if (rng <= 0) return false;
  const upperWick = h - Math.max(o, c);
  const bearish = c < o;
  const longWick = bearish && upperWick / rng >= wickRatio;
  const closeOffHighs = bearish && (h - c) / rng >= 0.6;
  const engulf =
    bearish &&
    prevO != null &&
    prevC != null &&
    prevC > prevO &&
    c <= prevO &&
    o >= prevC;
  return longWick || closeOffHighs || engulf;
}

/** Count how many times S/R levels were touched inside the range window. */
function _countRangeTouches(highs, lows, start, end, rangeHigh, rangeLow, tolPct = 0.002) {
  let supportTouches = 0;
  let resistanceTouches = 0;
  const mid = (rangeHigh + rangeLow) / 2;
  const tol = mid * tolPct;
  for (let i = start; i <= end; i++) {
    if (lows[i] != null && Math.abs(lows[i] - rangeLow) <= tol) supportTouches++;
    if (highs[i] != null && Math.abs(highs[i] - rangeHigh) <= tol) resistanceTouches++;
  }
  return { supportTouches, resistanceTouches };
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
  // bbWidthPercentileMax is diagnostic only: after a long compressed box the
  // lookback is almost all tight widths, so rank ≈ mid/high even when valid.

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

  // Syarat §1: S/R identifiable and tested several times
  const touches = _countRangeTouches(
    highs,
    lows,
    rangeStart,
    rangeEndIdx,
    rangeHigh,
    rangeLow,
  );
  // Syarat §1: both sides identified and tested (at least one touch each, total ≥ min)
  const rangeTested =
    touches.supportTouches >= 1 &&
    touches.resistanceTouches >= 1 &&
    touches.supportTouches + touches.resistanceTouches >= cfg.minRangeTouches;

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
    bars: barsInRange,
    rangeEndIdx,
    rangeStartIdx: rangeStart,
    supportTouches: touches.supportTouches,
    resistanceTouches: touches.resistanceTouches,
    rangeTested,
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
    st: [],
    springInd: [],
    sos: [],
    bc: [],
    arDist: [],
    stDist: [],
    utadInd: [],
    sow: [],
    lps: [],
    lpsy: [],
  };

  let lastScLow = null;
  let lastSpringLow = null;
  let lastStLow = null;
  let lastBcHigh = null;
  let lastUtadHigh = null;
  let lastStDistHigh = null;

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

    // ST / LPS / LPSY — need prior climax / spring / utad reference (indicator formulas)
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
      events.st.push(i);
      lastStLow = l;
    }

    // ST dist: test near BC high with lower volume
    if (
      lastBcHigh != null &&
      h != null &&
      avgVol != null &&
      h > lastBcHigh * 0.995 &&
      h < lastBcHigh * 1.005 &&
      v < avgVol
    ) {
      events.stDist.push(i);
      lastStDistHigh = h;
    }

    // LPS: higher low vs spring/ST, bullish, below-avg volume, close > mid
    const refLow = lastSpringLow ?? lastStLow ?? lastScLow;
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
    const refHigh = lastUtadHigh ?? lastStDistHigh ?? lastBcHigh;
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
 * Detect trend preceding the trading range (Syarat §1 / §2A / §3A).
 * Looks BEFORE the mature accumulation/distribution box, not inside rangeLookback.
 */
function detectPriorTrend(candles, rangeStartIdx, config = {}, rangeEndIdx = null) {
  const cfg = { ...DEFAULTS, ...config };
  const { closes, highs, lows } = candles;
  // Anchor before the accumulation/distribution box (not just rangeLookback window).
  // Walk back a full indicator lookback so prior trend is pre-range (Syarat §1).
  const accumDepth = Math.max(cfg.minBarsInRange, cfg.lookback);
  const matureStart =
    rangeEndIdx != null
      ? Math.max(0, rangeEndIdx - accumDepth)
      : rangeStartIdx;
  const end = Math.max(0, Math.min(rangeStartIdx, matureStart) - 1);
  const start = Math.max(0, end - cfg.priorTrendBars + 1);
  if (end - start < 10) {
    return { direction: "unknown", reason: "insufficient_prior_bars", start, end };
  }

  const first = closes[start];
  const last = closes[end];
  if (first == null || last == null || first <= 0) {
    return { direction: "unknown", reason: "missing_closes", start, end };
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
 * Local CHoCH / BOS after a manipulation bar (Syarat §2A / §3A moderate).
 * Bullish: close breaks recent swing high OR high of the spring structure.
 * Bearish: close breaks recent swing low OR low of the UTAD structure.
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
    const structHigh = highs[fromIdx];
    const level = Math.min(
      swingHigh ?? Infinity,
      structHigh ?? Infinity,
    );
    if (!Number.isFinite(level)) return { detected: false, reason: "no_swing_high" };
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      if (closes[i] != null && closes[i] > level) {
        return {
          detected: true,
          idx: i,
          level,
          type: closes[i] > (swingHigh ?? level) ? "bullish_choch" : "bullish_bos",
        };
      }
    }
    return { detected: false, reason: "no_bullish_choch" };
  }

  const swingLow = _lowest(lows, fromIdx - 1, look);
  const structLow = lows[fromIdx];
  const level = Math.max(swingLow ?? -Infinity, structLow ?? -Infinity);
  if (!Number.isFinite(level)) return { detected: false, reason: "no_swing_low" };
  for (let i = fromIdx + 1; i <= toIdx; i++) {
    if (closes[i] != null && closes[i] < level) {
      return {
        detected: true,
        idx: i,
        level,
        type: closes[i] < (swingLow ?? level) ? "bearish_choch" : "bearish_bos",
      };
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
    if (penetrationDepth < cfg.minPenetrationAtrMult * atr) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue;

    if (vol == null || vol === 0) continue;
    const volSma = _volumeBaseline(volumes, penIdx, cfg.volumeSmaPeriod);
    if (!volSma || volSma <= 0) continue;
    if (vol < cfg.volumeConfirmMult * volSma) continue;

    for (let r = penIdx + 1; r <= Math.min(lastIdx, penIdx + cfg.recoveryWindow); r++) {
      if (cfg.requireReclaimOnLastBar && r !== lastIdx) continue;
      const cl = closes[r];
      const op = opens?.[r] ?? closes[r - 1] ?? cl;
      if (cl == null) continue;
      if (cl > range.rangeLow && cl > op) {
        const volRatio = vol / volSma;
        const penO = opens?.[penIdx];
        const penC = closes?.[penIdx];
        const prevPen = penIdx > 0 ? penIdx - 1 : null;
        const rejection =
          _isBullishRejection(
            penO ?? op,
            highs?.[penIdx],
            lows[penIdx],
            penC ?? cl,
            cfg.rejectionWickRatio,
            prevPen != null ? opens?.[prevPen] : null,
            prevPen != null ? closes?.[prevPen] : null,
          ) ||
          _isBullishRejection(
            op,
            highs?.[r],
            lows?.[r],
            cl,
            cfg.rejectionWickRatio,
            opens?.[r - 1],
            closes?.[r - 1],
          );

        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_spring",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          depthAtr: penetrationDepth / atr,
          penetrationAtr: penetrationDepth / atr,
          reclaimBars: r - penIdx,
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
    if (penetrationDepth < cfg.minPenetrationAtrMult * atr) continue;
    if (penetrationDepth > cfg.penetrationAtrMult * atr) continue;

    if (vol == null || vol === 0) continue;
    const volSma = _volumeBaseline(volumes, penIdx, cfg.volumeSmaPeriod);
    if (!volSma || volSma <= 0) continue;
    if (vol < cfg.volumeConfirmMult * volSma) continue;

    for (let r = penIdx + 1; r <= Math.min(lastIdx, penIdx + cfg.recoveryWindow); r++) {
      if (cfg.requireReclaimOnLastBar && r !== lastIdx) continue;
      const cl = closes[r];
      const op = opens?.[r] ?? closes[r - 1] ?? cl;
      if (cl == null) continue;
      if (cl < range.rangeHigh && cl < op) {
        const volRatio = vol / volSma;
        const penO = opens?.[penIdx];
        const penC = closes?.[penIdx];
        const prevPen = penIdx > 0 ? penIdx - 1 : null;
        const rejection =
          _isBearishRejection(
            penO ?? op,
            highs[penIdx],
            lows?.[penIdx],
            penC ?? cl,
            cfg.rejectionWickRatio,
            prevPen != null ? opens?.[prevPen] : null,
            prevPen != null ? closes?.[prevPen] : null,
          ) ||
          _isBearishRejection(
            op,
            highs?.[r],
            lows?.[r],
            cl,
            cfg.rejectionWickRatio,
            opens?.[r - 1],
            closes?.[r - 1],
          );

        return {
          detected: true,
          confidence: Math.min(1, volRatio / 1.5),
          reason: "wyckoff_upthrust",
          penIdx,
          recoveryIdx: r,
          penetrationDepth,
          depthAtr: penetrationDepth / atr,
          penetrationAtr: penetrationDepth / atr,
          reclaimBars: r - penIdx,
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
// Entry checklist (syarat_entry_wyckoff.txt §4–7, §10–11)
// ═══════════════════════════════════════════════════════════════════════════

function _entryProximityOk(side, entryPrice, range, maxPct) {
  const width = range.rangeHigh - range.rangeLow;
  if (width <= 0 || entryPrice == null) return false;
  if (side === "LONG") {
    // Discount zone: stay in lower portion of range (away from resistance)
    const distToRes = range.rangeHigh - entryPrice;
    return distToRes / width >= 1 - maxPct;
  }
  const distToSup = entryPrice - range.rangeLow;
  return distToSup / width >= 1 - maxPct;
}

function _inDiscountZone(entryPrice, range) {
  if (entryPrice == null || !range) return false;
  const mid = range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
  return entryPrice <= mid;
}

function _inPremiumZone(entryPrice, range) {
  if (entryPrice == null || !range) return false;
  const mid = range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
  return entryPrice >= mid;
}

function _estimateRr(side, entry, invalidation, range) {
  if (entry == null || invalidation == null || !range) return null;
  const risk = Math.abs(entry - invalidation);
  if (risk <= 0) return null;
  // Prefer opposite side of range as primary structural target (§9)
  const structuralTarget = side === "LONG" ? range.rangeHigh : range.rangeLow;
  const reward = Math.abs(structuralTarget - entry);
  return reward / risk;
}

/**
 * Syarat §6–7: cancel entry if manipulation level is invalidated with follow-through.
 */
function detectEntryCancellation(candles, pattern, side, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const lastIdx = candles.lastIdx;
  if (!pattern?.detected || pattern.penIdx == null) {
    return { cancelled: false };
  }

  const from = pattern.recoveryIdx ?? pattern.penIdx;
  const confirm = Math.max(1, cfg.cancelConfirmBars | 0);

  if (side === "LONG") {
    const springLow = pattern.springLow ?? candles.lows[pattern.penIdx];
    let closesBelow = 0;
    for (let i = from + 1; i <= lastIdx; i++) {
      const c = candles.closes[i];
      if (c != null && c < springLow) closesBelow++;
      else closesBelow = 0;
      if (closesBelow >= confirm) {
        return { cancelled: true, reason: "spring_invalidated_below" };
      }
      // Strong close back below support
      if (c != null && c < range.rangeLow && candles.opens?.[i] != null && c < candles.opens[i]) {
        if (i === lastIdx) return { cancelled: true, reason: "strong_close_below_support" };
      }
    }
    // Fresh lower low after reclaim
    if (
      lastIdx > from &&
      candles.lows[lastIdx] != null &&
      springLow != null &&
      candles.lows[lastIdx] < springLow
    ) {
      return { cancelled: true, reason: "lower_low_after_spring" };
    }
  } else {
    const utadHigh = pattern.utadHigh ?? candles.highs[pattern.penIdx];
    let closesAbove = 0;
    for (let i = from + 1; i <= lastIdx; i++) {
      const c = candles.closes[i];
      if (c != null && c > utadHigh) closesAbove++;
      else closesAbove = 0;
      if (closesAbove >= confirm) {
        return { cancelled: true, reason: "utad_invalidated_above" };
      }
      if (c != null && c > range.rangeHigh && candles.opens?.[i] != null && c > candles.opens[i]) {
        if (i === lastIdx) return { cancelled: true, reason: "strong_close_above_resistance" };
      }
    }
    if (
      lastIdx > from &&
      candles.highs[lastIdx] != null &&
      utadHigh != null &&
      candles.highs[lastIdx] > utadHigh
    ) {
      return { cancelled: true, reason: "higher_high_after_utad" };
    }
  }

  return { cancelled: false };
}

/**
 * Build LONG / SHORT entry decision from pattern + Syarat checklist layers.
 */
function evaluateEntryChecklist(candles, range, pattern, side, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const lastIdx = candles.lastIdx;
  const model = cfg.entryModel || "moderate";
  const events = scanRecentEvents(candles, lastIdx, cfg);
  const prior = detectPriorTrend(
    candles,
    range.rangeStartIdx ?? range.rangeEndIdx,
    cfg,
    range.rangeEndIdx,
  );
  const cancel = detectEntryCancellation(candles, pattern, side, range, cfg);

  const checklist = {
    priorTrend: false,
    htfAlign: true,
    tradingRange: range.isValid === true,
    rangeTested: range.rangeTested === true || model === "aggressive" || model === "balanced",
    climaxOrWeakening: false,
    discountOrPremium: false,
    manipulation: false, // Spring / UTAD
    reclaimOrReject: false,
    rejection: false,
    volumeConfirm: false,
    choch: false,
    sosOrSow: false,
    lpsOrLpsy: false,
    proximityOk: false,
    rrOk: false,
    notCancelled: !cancel.cancelled,
  };

  const entryPrice = candles.closes[lastIdx];
  // Location / RR evaluated at reclaim bar (setup quality), not chased CHoCH close
  const locationIdx = pattern?.recoveryIdx ?? lastIdx;
  const locationPrice = candles.closes[locationIdx] ?? entryPrice;
  let invalidation = null;
  let choch = { detected: false };
  let lpsLevel = null;

  const htf = cfg.htfTrend || cfg.HTFTrend || null;
  const htfKnown = htf === "BULLISH" || htf === "BEARISH" || htf === "SIDEWAYS";
  const htfAligned =
    (side === "LONG" && htf === "BULLISH")
    || (side === "SHORT" && htf === "BEARISH");
  const htfAgainst =
    (side === "LONG" && htf === "BEARISH")
    || (side === "SHORT" && htf === "BULLISH");
  if (cfg.requireHtfAlign && htfKnown) {
    if (htfAgainst) {
      checklist.htfAlign = false;
    } else if (htf === "SIDEWAYS") {
      // Report evidence: LONG on SIDEWAYS bled (WR ~12%); SHORT carried PnL.
      // Default: sideways may SHORT, not LONG (override via allowHtfSidewaysLong).
      const sideOk = cfg.allowHtfSideways !== false;
      if (!sideOk) checklist.htfAlign = false;
      else if (side === "LONG" && cfg.allowHtfSidewaysLong === false) checklist.htfAlign = false;
      else if (side === "LONG" && cfg.sidewaysShortOnly === true) checklist.htfAlign = false;
      else checklist.htfAlign = true;
    } else {
      checklist.htfAlign = !!htfAligned;
    }
  }

  // Extra LONG quality: require stronger volume than shorts (springs fail more on BTC).
  const volNeed = side === "LONG"
    ? (cfg.longVolumeConfirmMult ?? cfg.volumeConfirmMult)
    : (cfg.shortVolumeConfirmMult ?? cfg.volumeConfirmMult);

  if (cfg.blockLong === true && side === "LONG") {
    checklist.htfAlign = false;
    checklist.volumeConfirm = false;
  }
  if (cfg.blockShort === true && side === "SHORT") {
    checklist.htfAlign = false;
    checklist.volumeConfirm = false;
  }

  if (side === "LONG") {
    // Pullback-spring in HTF uptrend counts as prior context (crypto intraday)
    checklist.priorTrend =
      prior.direction === "down"
      || htfAligned
      || model === "aggressive"
      || model === "balanced";
    checklist.climaxOrWeakening =
      events.sc.length > 0 ||
      events.ar.length > 0 ||
      events.st.length > 0 ||
      model === "aggressive" ||
      model === "balanced";
    checklist.manipulation = !!pattern?.detected;
    checklist.reclaimOrReject =
      pattern?.recoveryIdx != null &&
      candles.closes[pattern.recoveryIdx] > range.rangeLow;
    checklist.rejection = !!pattern?.rejection;
    checklist.volumeConfirm =
      pattern?.volRatio != null && pattern.volRatio >= volNeed;
    choch = detectLocalChoCH(candles, pattern.penIdx, lastIdx, "bullish", cfg);
    checklist.choch = choch.detected || model === "aggressive" || model === "balanced";
    // Discount at reclaim, or moderate entry after confirmed CHoCH (§2A moderate)
    checklist.discountOrPremium =
      _inDiscountZone(locationPrice, range) ||
      (model === "moderate" && choch.detected) ||
      model === "aggressive";
    checklist.sosOrSow =
      events.sos.some((i) => i >= (pattern.penIdx ?? 0)) || model !== "conservative";
    const lpsAfter = events.lps.filter(
      (i) => i >= (pattern.recoveryIdx ?? pattern.penIdx ?? 0),
    );
    checklist.lpsOrLpsy = lpsAfter.length > 0 || model !== "conservative";
    if (lpsAfter.length > 0) lpsLevel = candles.lows[lpsAfter[lpsAfter.length - 1]];
    invalidation =
      pattern.springLow ??
      (pattern.penIdx != null ? candles.lows[pattern.penIdx] : range.rangeLow);
    checklist.proximityOk =
      _entryProximityOk("LONG", locationPrice, range, cfg.maxEntryProximityPct) ||
      (model === "moderate" && choch.detected) ||
      model === "balanced";
  } else {
    checklist.priorTrend =
      prior.direction === "up" || htfAligned || model === "aggressive" || model === "balanced";
    checklist.climaxOrWeakening =
      events.bc.length > 0 ||
      events.arDist.length > 0 ||
      events.stDist.length > 0 ||
      model === "aggressive" ||
      model === "balanced";
    checklist.manipulation = !!pattern?.detected;
    checklist.reclaimOrReject =
      pattern?.recoveryIdx != null &&
      candles.closes[pattern.recoveryIdx] < range.rangeHigh;
    checklist.rejection = !!pattern?.rejection;
    checklist.volumeConfirm =
      pattern?.volRatio != null && pattern.volRatio >= volNeed;
    choch = detectLocalChoCH(candles, pattern.penIdx, lastIdx, "bearish", cfg);
    checklist.choch = choch.detected || model === "aggressive" || model === "balanced";
    checklist.discountOrPremium =
      _inPremiumZone(locationPrice, range) ||
      (model === "moderate" && choch.detected) ||
      model === "aggressive";
    checklist.sosOrSow =
      events.sow.some((i) => i >= (pattern.penIdx ?? 0)) || model !== "conservative";
    const lpsyAfter = events.lpsy.filter(
      (i) => i >= (pattern.recoveryIdx ?? pattern.penIdx ?? 0),
    );
    checklist.lpsOrLpsy = lpsyAfter.length > 0 || model !== "conservative";
    if (lpsyAfter.length > 0) lpsLevel = candles.highs[lpsyAfter[lpsyAfter.length - 1]];
    invalidation =
      pattern.utadHigh ??
      (pattern.penIdx != null ? candles.highs[pattern.penIdx] : range.rangeHigh);
    checklist.proximityOk =
      _entryProximityOk("SHORT", locationPrice, range, cfg.maxEntryProximityPct) ||
      (model === "moderate" && choch.detected) ||
      model === "balanced";
  }

  // RR from reclaim (setup) — also accept mid-range target (§9) if opposite side too tight
  const rrStructural = _estimateRr(side, locationPrice, invalidation, range);
  const mid = range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
  const risk = invalidation != null && locationPrice != null
    ? Math.abs(locationPrice - invalidation)
    : 0;
  const rrMid =
    risk > 0 && mid != null ? Math.abs(mid - locationPrice) / risk : null;
  const rr = Math.max(rrStructural ?? 0, rrMid ?? 0) || null;
  checklist.rrOk = rr != null && rr >= cfg.minRr;

  // Required layers by model (maps to Syarat §4–5 / §11)
  // Aggressive keeps race participation but still needs wick rejection + ≥1:2 RR
  // (report: 25% WR / PF 0.60 when these were bypassed + ATR exits).
  const required = [
    "tradingRange",
    "manipulation",
    "reclaimOrReject",
    "volumeConfirm",
    "notCancelled",
    "rejection",
    "rrOk",
  ];
  if (cfg.requireHtfAlign) {
    required.push("htfAlign");
  }
  // balanced: location + tested range, skip full CHoCH/prior stack (frequency path)
  if (model === "balanced") {
    required.push("discountOrPremium", "rangeTested");
  }
  if (model === "moderate" || model === "conservative") {
    required.push(
      "priorTrend",
      "rangeTested",
      "discountOrPremium",
      "choch",
      "proximityOk",
    );
  }
  if (model === "conservative") {
    required.push("climaxOrWeakening", "sosOrSow", "lpsOrLpsy");
  }

  const failed = required.filter((k) => !checklist[k]);
  const passed = failed.length === 0;

  const keys = Object.keys(checklist);
  const hit = keys.filter((k) => checklist[k]).length;
  const fill = hit / keys.length;
  const confidence = Math.min(1, (pattern.confidence || 0.5) * (0.5 + 0.5 * fill));

  let reason;
  if (cancel.cancelled) {
    reason = `entry_cancelled:${cancel.reason}`;
  } else if (passed) {
    reason = side === "LONG" ? "wyckoff_spring" : "wyckoff_upthrust";
  } else {
    reason = `entry_checklist_failed:${failed.join(",")}`;
  }

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
    lpsLevel,
    reclaimBars: pattern?.reclaimBars ?? null,
    volRatio: pattern?.volRatio ?? null,
    rr,
    confidence,
    cancel,
    reason,
  };
}

/**
 * Alternate Syarat paths: SOS→LPS (long) / SOW→LPSY (short) for moderate+.
 */
function evaluateSchematicContinuation(candles, range, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (cfg.entryModel === "aggressive") return null;

  const lastIdx = candles.lastIdx;
  const events = scanRecentEvents(candles, lastIdx, cfg);
  const prior = detectPriorTrend(
    candles,
    range.rangeStartIdx ?? range.rangeEndIdx,
    cfg,
    range.rangeEndIdx,
  );
  const entryPrice = candles.closes[lastIdx];
  const windowStart = lastIdx - cfg.recoveryWindow;

  const lastLps = events.lps[events.lps.length - 1];
  const lastSos = events.sos[events.sos.length - 1];
  if (
    lastLps != null &&
    lastLps >= windowStart &&
    lastSos != null &&
    lastSos < lastLps &&
    (events.springInd.length > 0 || events.sc.length > 0) &&
    prior.direction === "down" &&
    entryPrice != null &&
    entryPrice > (range.midRange ?? (range.rangeHigh + range.rangeLow) / 2)
  ) {
    // LPS after SOS: price holds above mid / old resistance as support (§2C)
    const invalidation = range.rangeLow;
    const rr = _estimateRr("LONG", entryPrice, invalidation, range);
    if (rr != null && rr >= cfg.minRr && entryPrice > range.rangeLow) {
      return {
        vote: "LONG",
        confidence: 0.72,
        reason: "wyckoff_lps",
        meta: {
          range,
          events,
          prior,
          stopLoss: invalidation,
          takeProfit: range.rangeHigh,
          rr,
          lpsLevel: candles.lows[lastLps],
          entry: {
            passed: true,
            model: cfg.entryModel,
            reason: "wyckoff_lps",
            checklist: { sosOrSow: true, lpsOrLpsy: true, priorTrend: true },
            lpsLevel: candles.lows[lastLps],
          },
        },
      };
    }
  }

  const lastLpsy = events.lpsy[events.lpsy.length - 1];
  const lastSow = events.sow[events.sow.length - 1];
  // Short-biased legs may take LPSY without a strict prior uptrend (range
  // distribution after sideways HTF still valid when blockLong / flex flag set).
  const lpsyPriorOk =
    prior.direction === "up"
    || (cfg.allowLpsyFlexPrior === true && prior.direction !== "down")
    || (cfg.blockLong === true && prior.direction !== "down");
  if (
    lastLpsy != null &&
    lastLpsy >= windowStart &&
    lastSow != null &&
    lastSow < lastLpsy &&
    (events.utadInd.length > 0 || events.bc.length > 0) &&
    lpsyPriorOk
  ) {
    const invalidation = range.rangeHigh;
    const rr = _estimateRr("SHORT", entryPrice, invalidation, range);
    if (rr != null && rr >= cfg.minRr && entryPrice < range.rangeHigh) {
      return {
        vote: "SHORT",
        confidence: 0.72,
        reason: "wyckoff_lpsy",
        meta: {
          range,
          events,
          prior,
          stopLoss: invalidation,
          takeProfit: range.rangeLow,
          rr,
          lpsLevel: candles.highs[lastLpsy],
          entry: {
            passed: true,
            model: cfg.entryModel,
            reason: "wyckoff_lpsy",
            checklist: { sosOrSow: true, lpsOrLpsy: true, priorTrend: true },
            lpsLevel: candles.highs[lastLpsy],
          },
        },
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public evaluate
// ═══════════════════════════════════════════════════════════════════════════

function evaluateWyckoffComponent(candles, config = {}, state = {}) {
  const cfg = resolveWyckoffConfig(config);
  const lastIdx = candles?.lastIdx;

  // Ablation funnel (diagnostic counting only — pure guarded side-effect).
  const ablation = state.ablation;
  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  _abl("evaluated");

  if (scalpingSessionBlocked(cfg, candles, lastIdx, "wyckoffSessionFilter", applyWyckoffSessionFilter, ablation)) {
    return { vote: "NEUTRAL", confidence: 0, reason: "wyckoff_session_block" };
  }

  if (isBlockedUtcHour(candles, lastIdx, cfg.blockedUtcHours)) {
    _abl("rejCooldown");
    return { vote: "NEUTRAL", confidence: 0, reason: "wyckoff_hour_block" };
  }

  if (lastIdx == null || !candles?.closes || candles.closes.length < cfg.minBars) {
    _abl("rejMinBars");
    return { vote: "NEUTRAL", confidence: 0, reason: "insufficient_data" };
  }

  const vol = candles.volumes?.[lastIdx];
  if (vol == null || vol === 0) {
    _abl("rejVolume");
    return { vote: "NEUTRAL", confidence: 0, reason: "missing_volume_data" };
  }

  if (
    state.lastSignalIdx != null &&
    lastIdx - state.lastSignalIdx < cfg.cooldownBars
  ) {
    _abl("rejCooldown");
    return { vote: "NEUTRAL", confidence: 0, reason: "cooldown_active" };
  }

  const range = detectTradingRange(candles, cfg);
  if (!range.isValid) {
    _abl("rejRange");
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: range.reason || "no_valid_range",
      meta: { range },
    };
  }

  const patternMode = String(cfg.scalpPatternMode || "ut_and_lpsy").toLowerCase();
  const allowSpringUt = patternMode !== "lpsy_only";
  const allowContinuation = patternMode !== "ut_only";

  if (allowSpringUt) {
    const spring = detectSpring(candles, range, cfg);
    if (spring.detected) {
      const entry = evaluateEntryChecklist(candles, range, spring, "LONG", cfg);
      if (entry.passed) {
        _abl("passed");
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
            tradeType: cfg.tradeType,
          },
        };
      }
      // Fall through to check short only if long checklist failed without spring? No — spring found but gated.
      _abl("rejChecklist");
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
        _abl("passed");
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
            tradeType: cfg.tradeType,
          },
        };
      }
      _abl("rejChecklist");
      return {
        vote: "NEUTRAL",
        confidence: 0,
        reason: entry.reason,
        meta: { range, upthrust, entry },
      };
    }
  }

  // Syarat §2B–C / §3B–C: SOS→LPS / SOW→LPSY continuation (moderate + conservative)
  if (allowContinuation) {
    const continuation = evaluateSchematicContinuation(candles, range, cfg);
    if (continuation) {
      _abl("passed");
      if (continuation.meta) continuation.meta.tradeType = cfg.tradeType;
      return continuation;
    }
  }

  _abl("rejPattern");
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
    timestamps: indicators.timestamps || indicators.times || indicators.openTime || null,
    lastIdx,
  };
}

module.exports = {
  DEFAULTS,
  TRADE_TYPE_PROFILES,
  resolveWyckoffConfig,
  detectTradingRange,
  detectSpring,
  detectUpthrust,
  detectEventsAt,
  scanRecentEvents,
  detectPriorTrend,
  detectLocalChoCH,
  detectEntryCancellation,
  evaluateEntryChecklist,
  evaluateSchematicContinuation,
  evaluateWyckoffComponent,
  candlesFromIndicators,
  relativeVolume,
  applyWyckoffSessionFilter,
  isBlockedUtcHour,
};
