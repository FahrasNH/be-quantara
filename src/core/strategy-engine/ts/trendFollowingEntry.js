/**
 * Trend Following (TREND_FOLLOWING) — standalone entry for TREND_SURGE.
 *
 * 3-layer: HTF trend → MTF Donchian breakout → 5m entry pullback.
 * Extracted from TrendFollowingStrategy (Sprint 15 structure refactor).
 */

"use strict";

const { calcDonchian } = require("../../analytics-engine/indicators");

const DEFAULTS = {
  htfRatio: 12,
  mtfRatio: 3,
  donchianPeriod: 20,
  adxMinStrength: 25,
  minVolRatio: 1.0,
};

function freshTrendState() {
  return {
    htfTrendConfirmed: false,
    htfTrendDirection: null,
    htfAdxStrength: 0,
    donchianBroken: false,
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

function isDonchianBroken(closesEntry, donchianUpper, donchianLower, direction) {
  const n = closesEntry?.length || 0;
  if (n < 2) return false;

  const closeCurr = closesEntry[n - 1];

  if (direction === "LONG") {
    return closeCurr > donchianUpper;
  }
  return closeCurr < donchianLower;
}

function checkLongEntry(
  closesEntry,
  volumesEntry,
  emaFastEntry,
  emaMidEntry,
  rsiEntry,
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

  const closeCurr = closesEntry[closesEntry.length - 1];

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

  if (closeCurr <= emaFastEntry) {
    return { valid: false, reason: "Close not above EMA9 (pullback too deep)" };
  }

  if (emaFastEntry <= emaMidEntry) {
    return { valid: false, reason: "EMA9 not above EMA21 (structure broken)" };
  }

  if (rsiEntry == null || rsiEntry < 30 || rsiEntry > 70) {
    return { valid: false, reason: `RSI ${rsiEntry?.toFixed(1) || "null"} outside 30-70` };
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
  emaFastEntry,
  emaMidEntry,
  rsiEntry,
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

  const closeCurr = closesEntry[closesEntry.length - 1];

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

  if (closeCurr >= emaFastEntry) {
    return { valid: false, reason: "Close not below EMA9" };
  }

  if (emaFastEntry >= emaMidEntry) {
    return { valid: false, reason: "EMA9 not below EMA21" };
  }

  if (rsiEntry == null || rsiEntry < 30 || rsiEntry > 70) {
    return { valid: false, reason: "RSI outside 30-70" };
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
  };
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

  if (lastIdx < 50) {
    _abl("rejWarmup");
    return { signal: null, trendState: state, entryChecklist: null };
  }

  const closesEntry = (indicators.closes || []).slice(0, lastIdx + 1);
  const volumesEntry = (indicators.volumes || []).slice(0, lastIdx + 1);
  const atr = indicators.atr?.[lastIdx];
  const rsiEntry = indicators.rsi?.[lastIdx];
  const emaFastEntry = indicators.emaFast?.[lastIdx];
  const emaMidEntry = indicators.emaSlow?.[lastIdx];
  const volumeCurrentEntry = volumesEntry[volumesEntry.length - 1];
  const volumeSMAEntry = indicators.volSMA?.[lastIdx] || 0;

  if (!atr || !rsiEntry || !emaFastEntry || !emaMidEntry) {
    _abl("rejIndicators");
    return { signal: null, trendState: state, entryChecklist: null };
  }

  const hasHTF = Array.isArray(indicators.closesHTF);
  const hasMTF = Array.isArray(indicators.macd15m);
  const idxHTF = Number.isInteger(config.htfIdx)
    ? config.htfIdx
    : (hasHTF ? Math.floor(lastIdx / (cfg.htfRatio || 12)) : lastIdx);
  const idxMTF = hasMTF ? Math.floor(lastIdx / (cfg.mtfRatio || 3)) : lastIdx;

  const htfClose = indicators.closesHTF?.[idxHTF] ?? closesEntry[closesEntry.length - 1];
  const htfEmaFast = indicators.emaFastHTF?.[idxHTF] ?? emaFastEntry;
  const htfEmaMid = indicators.emaMidHTF?.[idxHTF] ?? emaMidEntry;
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

  if (hasMTF && indicators.donchian15m) {
    const dc = indicators.donchian15m;
    donchianUpperMTF = dc.upper?.[idxMTF];
    donchianLowerMTF = dc.lower?.[idxMTF];
    const mtfCloses = (indicators.closes15m || []).slice(0, idxMTF + 1);
    if (mtfCloses.length > 0) {
      donchianBroken = isDonchianBroken(mtfCloses, donchianUpperMTF, donchianLowerMTF, htfTrend);
    }
  } else {
    const dc = resolveDonchian(indicators, lastIdx, cfg, cache);
    donchianUpperMTF = dc.upper;
    donchianLowerMTF = dc.lower;
    donchianBroken = isDonchianBroken(closesEntry, donchianUpperMTF, donchianLowerMTF, htfTrend);
  }

  state.htfTrendConfirmed = true;
  state.htfTrendDirection = htfTrend;
  state.htfAdxStrength = htfAdx || 0;
  state.donchianBroken = donchianBroken;
  state.barsInTrend += 1;

  const adxMinStrength = config.adxMinStrength ?? cfg.adxMinStrength ?? 25;
  const donchianPeriod = config.donchianPeriod ?? cfg.donchianPeriod ?? 20;

  const longCheck = checkLongEntry(
    closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
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
        ema9Retest: true,
        volumeConfirmed: true,
        volRatio,
        adxMinStrength,
        donchianPeriod,
      },
    };
  }

  const shortCheck = checkShortEntry(
    closesEntry, volumesEntry, emaFastEntry, emaMidEntry, rsiEntry,
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
        ema9Retest: true,
        volumeConfirmed: true,
        volRatio,
        adxMinStrength,
        donchianPeriod,
      },
    };
  }

  _abl(donchianBroken ? "rejChecklist" : "rejBreakout");
  return { signal: null, trendState: state, entryChecklist: null };
}

module.exports = {
  DEFAULTS,
  freshTrendState,
  detectHTFTrend,
  isDonchianBroken,
  checkLongEntry,
  checkShortEntry,
  evaluateTrendFollowingEntry,
};
