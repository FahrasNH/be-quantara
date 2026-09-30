/**
 * Trend Following (TREND_FOLLOWING) — standalone entry for TREND_SURGE.
 *
 * 3-layer: HTF trend → MTF Donchian breakout → 5m entry (volume).
 * Extracted from TrendFollowingStrategy (Sprint 15 structure refactor).
 */

"use strict";

const { calcDonchian } = require("../../analytics-engine/indicators");
const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: Trend Following Scalping session filter (Asia block). */
function applyTsSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const DEFAULTS = {
  htfRatio: 12,
  mtfRatio: 3,
  donchianPeriod: 20,
  adxMinStrength: 25,
  minVolRatio: 1.0,
  tfRequireFreshBreakout: true,
  tfMtfLayerEnabled: true,
  // Optional breakout quality filter. Zero keeps the historical behaviour;
  // positive values require a directional candle body measured in ATR.
  tfMinBreakoutBodyAtr: 0,
};

function freshTrendState() {
  return {
    htfTrendConfirmed: false,
    htfTrendDirection: null,
    htfAdxStrength: 0,
    donchianBroken: false,
    lastDonchianBreakoutKey: null,
    barsInTrend: 0,
  };
}

function detectHTFTrend(htfClosesLast, emaFastHTF, emaMidHTF, emaSlowHTF, adxHTF, adxMinOverride, cfg = DEFAULTS) {
  if (!htfClosesLast || !emaFastHTF || !emaMidHTF || !emaSlowHTF) return null;

  const close = htfClosesLast;
  const adxMin = adxMinOverride ?? cfg.adxMinStrength ?? 25;

  if (
    emaFastHTF > emaMidHTF && emaMidHTF > emaSlowHTF &&
    close > emaMidHTF &&
    (adxHTF == null || adxHTF >= adxMin)
  ) {
    return "LONG";
  }

  if (
    emaFastHTF < emaMidHTF && emaMidHTF < emaSlowHTF &&
    close < emaMidHTF &&
    (adxHTF == null || adxHTF >= adxMin)
  ) {
    return "SHORT";
  }

  return null;
}

/**
 * Confirm a Donchian breakout.
 *
 * `donchianUpper`/`donchianLower` must be the channel calculated from bars
 * before the current close.  When the preceding channel is supplied, require
 * a *fresh* crossing: the previous close must not already have been outside
 * that preceding channel.  This prevents the same trend leg from generating
 * a new signal on every bar that remains above/below the channel.
 *
 * The previous-channel arguments are optional for backwards compatibility
 * with callers that only need the legacy point-in-time check.
 */
function isDonchianBroken(
  closesEntry,
  donchianUpper,
  donchianLower,
  direction,
  previousDonchianUpper = null,
  previousDonchianLower = null,
) {
  const n = closesEntry?.length || 0;
  if (n < 2) return false;

  const closeCurr = closesEntry[n - 1];
  const closePrev = closesEntry[n - 2];

  if (direction === "LONG") {
    if (!(closeCurr > donchianUpper)) return false;
    return previousDonchianUpper == null || closePrev <= previousDonchianUpper;
  }
  if (!(closeCurr < donchianLower)) return false;
  return previousDonchianLower == null || closePrev >= previousDonchianLower;
}

/**
 * Reject weak/indecisive breakout candles when explicitly configured.
 *
 * The breakout candle is the completed MTF candle when the causal MTF layer is
 * present, otherwise the current entry candle.  The filter is deliberately
 * opt-in: it is a research control until it demonstrates out-of-sample value.
 */
function checkBreakoutQuality({
  open,
  close,
  atr,
  channel,
  direction,
  minBodyAtr = 0,
  maxExtensionAtr = Infinity,
} = {}) {
  const minBody = Number(minBodyAtr);
  const maxExtension = Number(maxExtensionAtr);
  const qualityEnabled = (Number.isFinite(minBody) && minBody > 0)
    || (Number.isFinite(maxExtension) && maxExtension >= 0);
  if (!qualityEnabled) return { valid: true, bodyAtr: null, extensionAtr: null };

  if (![open, close, atr, channel].every(Number.isFinite) || !(atr > 0)) {
    return { valid: false, bodyAtr: null, extensionAtr: null, reason: "Breakout quality inputs unavailable" };
  }

  const directional = direction === "LONG" ? close > open : close < open;
  const bodyAtr = Math.abs(close - open) / atr;
  const extensionAtr = direction === "LONG"
    ? (close - channel) / atr
    : (channel - close) / atr;
  const bodyValid = !(Number.isFinite(minBody) && minBody > 0)
    || (directional && bodyAtr >= minBody);
  const extensionValid = !(Number.isFinite(maxExtension) && maxExtension >= 0)
    || extensionAtr <= maxExtension;

  return {
    valid: bodyValid && extensionValid,
    bodyAtr,
    extensionAtr,
    reason: bodyValid
      ? (extensionValid ? "Breakout quality passed" : "Breakout too extended")
      : "Breakout body too weak or counter-directional",
  };
}

function checkLongEntry(
  closesEntry,
  volumesEntry,
  volumeCurrentEntry,
  volumeSMAEntry,
  htfTrend,
  donchianBroken,
  donchianUpperMTF,
  adxHTF,
  adxMinOverride,
  minVolRatioOverride,
  cfg = DEFAULTS,
) {
  if (!closesEntry || closesEntry.length === 0) {
    return { valid: false, reason: "No entry closes" };
  }

  if (htfTrend !== "LONG") {
    return { valid: false, reason: "HTF not in uptrend" };
  }

  const adxMin = adxMinOverride ?? cfg.adxMinStrength ?? 25;
  if (adxHTF != null && adxHTF < adxMin) {
    return { valid: false, reason: `ADX ${adxHTF.toFixed(1)} below strength threshold ${adxMin}` };
  }

  if (!donchianBroken) {
    return { valid: false, reason: "No Donchian breakout confirmation" };
  }

  const minVolRatio = minVolRatioOverride ?? cfg.minVolRatio;
  if (volumeCurrentEntry < volumeSMAEntry * minVolRatio) {
    return { valid: false, reason: `Volume below ${minVolRatio}× SMA` };
  }

  return { valid: true, reason: "All LONG conditions met" };
}

function checkShortEntry(
  closesEntry,
  volumesEntry,
  volumeCurrentEntry,
  volumeSMAEntry,
  htfTrend,
  donchianBroken,
  donchianLowerMTF,
  adxHTF,
  adxMinOverride,
  minVolRatioOverride,
  cfg = DEFAULTS,
) {
  if (!closesEntry || closesEntry.length === 0) {
    return { valid: false, reason: "No entry closes" };
  }

  if (htfTrend !== "SHORT") {
    return { valid: false, reason: "HTF not in downtrend" };
  }

  const adxMin = adxMinOverride ?? cfg.adxMinStrength ?? 25;
  if (adxHTF != null && adxHTF < adxMin) {
    return { valid: false, reason: "ADX too low for short" };
  }

  if (!donchianBroken) {
    return { valid: false, reason: "No Donchian breakout confirmation" };
  }

  const minVolRatioS = minVolRatioOverride ?? cfg.minVolRatio;
  if (volumeCurrentEntry < volumeSMAEntry * minVolRatioS) {
    return { valid: false, reason: "Volume below threshold" };
  }

  return { valid: true, reason: "All SHORT conditions met" };
}

/**
 * Resolve Donchian channel with WeakMap cache keyed by highs array + period.
 */
function resolveDonchian(indicators, lastIdx, config, donchianCache) {
  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const donchianPeriod = config.donchianPeriod ?? DEFAULTS.donchianPeriod ?? 20;

  let dcByPeriod = donchianCache.get(highs);
  if (!dcByPeriod) {
    dcByPeriod = new Map();
    donchianCache.set(highs, dcByPeriod);
  }
  let dc = dcByPeriod.get(donchianPeriod);
  if (!dc) {
    dc = calcDonchian(highs, lows, donchianPeriod);
    dcByPeriod.set(donchianPeriod, dc);
  }

  return {
    upper: dc.upper?.[lastIdx - 1],
    lower: dc.lower?.[lastIdx - 1],
    previousUpper: dc.upper?.[lastIdx - 2],
    previousLower: dc.lower?.[lastIdx - 2],
  };
}

/**
 * The entry checks only need the current and previous close.  Keeping this
 * as a two-value view avoids copying the entire history on every evaluated
 * candle (the old slice made long 5m backtests O(n²)).
 */
function lastTwo(values, lastIdx) {
  if (!Array.isArray(values) || lastIdx < 0) return [];
  if (lastIdx === 0) return [values[0]];
  return [values[lastIdx - 1], values[lastIdx]];
}

/**
 * Main TREND_FOLLOWING entry evaluation at lastIdx.
 *
 * @returns {{ signal: 'LONG'|'SHORT'|null, trendState: object, entryChecklist: object|null }}
 */
function evaluateTrendFollowingEntry({
  indicators,
  lastIdx,
  config = {},
  trendState = null,
  donchianCache = null,
  defaults = {},
  ablation = null,
} = {}) {
  const cfg = { ...DEFAULTS, ...defaults, ...config };
  const state = trendState || freshTrendState();
  const cache = donchianCache || new WeakMap();

  const _abl = (k) => { if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1; };
  _abl("evaluated");

  if (scalpingSessionBlocked(cfg, indicators, lastIdx, "tsSessionFilter", applyTsSessionFilter, ablation)) {
    return { signal: null, trendState: state, entryChecklist: null };
  }

  if (lastIdx < 50) {
    _abl("rejWarmup");
    return { signal: null, trendState: state, entryChecklist: null };
  }

  const closesEntry = lastTwo(indicators.closes || [], lastIdx);
  const volumesEntry = lastTwo(indicators.volumes || [], lastIdx);
  const atr = indicators.atr?.[lastIdx];
  const volumeCurrentEntry = volumesEntry[volumesEntry.length - 1];
  const volumeSMAEntry = indicators.volSMA?.[lastIdx] || 0;

  if (!atr) {
    _abl("rejIndicators");
    return { signal: null, trendState: state, entryChecklist: null };
  }

  const hasHTF = Array.isArray(indicators.closesHTF);
  // The MTF breakout layer is defined by its close series + Donchian channel.
  // Requiring `macd15m` here silently forced every caller onto the entry-TF
  // fallback because the project does not use MACD as a TF entry condition.
  const hasMTF = Array.isArray(indicators.closes15m)
    && indicators.donchian15m
    && typeof indicators.donchian15m === "object";
  const idxHTF = Number.isInteger(config.htfIdx)
    ? config.htfIdx
    : (hasHTF ? Math.floor(lastIdx / (cfg.htfRatio || 12)) : lastIdx);
  const idxMTF = hasMTF
    ? (Number.isInteger(config.mtfIdx)
      ? config.mtfIdx
      : Math.floor(lastIdx / (cfg.mtfRatio || 3)))
    : lastIdx;

  const htfClose = indicators.closesHTF?.[idxHTF] ?? closesEntry[closesEntry.length - 1];
  const htfEmaFast = indicators.emaFastHTF?.[idxHTF] ?? indicators.emaFast?.[lastIdx] ?? null;
  const htfEmaMid = indicators.emaMidHTF?.[idxHTF] ?? indicators.emaSlow?.[lastIdx] ?? null;
  const htfEmaSlow = indicators.emaSlowHTF?.[idxHTF] ?? indicators.emaTrend?.[lastIdx] ?? null;
  const htfAdx = indicators.adxHTF?.[idxHTF] ?? null;

  const htfTrend = detectHTFTrend(
    htfClose, htfEmaFast, htfEmaMid, htfEmaSlow, htfAdx, config.adxMinStrength, cfg,
  );

  if (state.htfTrendDirection && htfTrend && htfTrend !== state.htfTrendDirection) {
    Object.assign(state, freshTrendState());
  }

  if (!htfTrend) {
    state.htfTrendConfirmed = false;
    _abl("rejHtfTrend");
    return { signal: null, trendState: state, entryChecklist: null };
  }

  let donchianBroken = false;
  let donchianUpperMTF = null;
  let donchianLowerMTF = null;
  let breakoutQuality = { valid: true, bodyAtr: null, extensionAtr: null };
  let breakoutQualityRejected = false;
  const requireFreshBreakout = config.tfRequireFreshBreakout !== false
    && cfg.tfRequireFreshBreakout !== false;

  if (hasMTF) {
    const dc = indicators.donchian15m;
    // calcDonchian() includes the bar at its output index.  Use the prior
    // completed MTF bar's channel for the current close, and the channel one
    // bar earlier to test whether this is a new breakout.
    const channelIdx = idxMTF - 1;
    donchianUpperMTF = dc.upper?.[channelIdx];
    donchianLowerMTF = dc.lower?.[channelIdx];
    const previousUpperMTF = dc.upper?.[channelIdx - 1];
    const previousLowerMTF = dc.lower?.[channelIdx - 1];
    const mtfCloses = lastTwo(indicators.closes15m || [], idxMTF);
    if (mtfCloses.length > 0) {
      donchianBroken = isDonchianBroken(
        mtfCloses,
        donchianUpperMTF,
        donchianLowerMTF,
        htfTrend,
        requireFreshBreakout ? previousUpperMTF : null,
        requireFreshBreakout ? previousLowerMTF : null,
      );
    }
  } else {
    const dc = resolveDonchian(indicators, lastIdx, cfg, cache);
    donchianUpperMTF = dc.upper;
    donchianLowerMTF = dc.lower;
    donchianBroken = isDonchianBroken(
      closesEntry,
      donchianUpperMTF,
      donchianLowerMTF,
      htfTrend,
      requireFreshBreakout ? dc.previousUpper : null,
      requireFreshBreakout ? dc.previousLower : null,
    );
  }

  if (donchianBroken) {
    const breakoutIdx = hasMTF ? idxMTF : lastIdx;
    const breakoutOpen = hasMTF
      ? indicators.opens15m?.[breakoutIdx]
      : indicators.opens?.[breakoutIdx];
    const breakoutClose = hasMTF
      ? indicators.closes15m?.[breakoutIdx]
      : indicators.closes?.[breakoutIdx];
    const breakoutAtr = hasMTF
      ? (indicators.atr15m?.[breakoutIdx] ?? atr)
      : atr;
    const breakoutChannel = htfTrend === "LONG" ? donchianUpperMTF : donchianLowerMTF;
    breakoutQuality = checkBreakoutQuality({
      open: breakoutOpen,
      close: breakoutClose,
      atr: breakoutAtr,
      channel: breakoutChannel,
      direction: htfTrend,
      minBodyAtr: config.tfMinBreakoutBodyAtr ?? cfg.tfMinBreakoutBodyAtr,
      maxExtensionAtr: config.tfMaxBreakoutExtensionAtr ?? cfg.tfMaxBreakoutExtensionAtr,
    });
    if (!breakoutQuality.valid) {
      donchianBroken = false;
      breakoutQualityRejected = true;
    }
  }

  // A completed MTF breakout remains visible for every lower-TF candle until
  // the next MTF close.  Emit it only once, so a single breakout cannot churn
  // a new position after each SL/TP on the lower timeframe.
  if (donchianBroken && hasMTF) {
    const breakoutKey = `${htfTrend}:${idxMTF}`;
    if (state.lastDonchianBreakoutKey === breakoutKey) {
      donchianBroken = false;
    } else {
      state.lastDonchianBreakoutKey = breakoutKey;
    }
  }

  state.htfTrendConfirmed = true;
  state.htfTrendDirection = htfTrend;
  state.htfAdxStrength = htfAdx || 0;
  state.donchianBroken = donchianBroken;
  state.barsInTrend += 1;

  const adxMinStrength = config.adxMinStrength ?? cfg.adxMinStrength ?? 25;
  const donchianPeriod = config.donchianPeriod ?? cfg.donchianPeriod ?? 20;

  const longCheck = checkLongEntry(
    closesEntry, volumesEntry,
    volumeCurrentEntry, volumeSMAEntry,
    htfTrend, donchianBroken, donchianUpperMTF, htfAdx,
    adxMinStrength, config.minVolRatio, cfg,
  );

  if (longCheck.valid) {
    const volRatio = volumeSMAEntry > 0 ? volumeCurrentEntry / volumeSMAEntry : null;
    _abl("passed");
    return {
      signal: "LONG",
      trendState: state,
      entryChecklist: {
        htfTrendAligned: true,
        adxPassed: true,
        donchianBroken: true,
        volumeConfirmed: true,
        volRatio,
        adxMinStrength,
        donchianPeriod,
        breakoutBodyAtr: breakoutQuality.bodyAtr,
        breakoutExtensionAtr: breakoutQuality.extensionAtr,
      },
    };
  }

  const shortCheck = checkShortEntry(
    closesEntry, volumesEntry,
    volumeCurrentEntry, volumeSMAEntry,
    htfTrend, donchianBroken, donchianLowerMTF, htfAdx,
    adxMinStrength, config.minVolRatio, cfg,
  );

  if (shortCheck.valid) {
    const volRatio = volumeSMAEntry > 0 ? volumeCurrentEntry / volumeSMAEntry : null;
    _abl("passed");
    return {
      signal: "SHORT",
      trendState: state,
      entryChecklist: {
        htfTrendAligned: true,
        adxPassed: true,
        donchianBroken: true,
        volumeConfirmed: true,
        volRatio,
        adxMinStrength,
        donchianPeriod,
        breakoutBodyAtr: breakoutQuality.bodyAtr,
        breakoutExtensionAtr: breakoutQuality.extensionAtr,
      },
    };
  }

  _abl(donchianBroken ? "rejChecklist" : (breakoutQualityRejected ? "rejBreakoutQuality" : "rejBreakout"));
  return { signal: null, trendState: state, entryChecklist: null };
}

module.exports = {
  DEFAULTS,
  freshTrendState,
  detectHTFTrend,
  isDonchianBroken,
  checkLongEntry,
  checkShortEntry,
  checkBreakoutQuality,
  evaluateTrendFollowingEntry,
};
