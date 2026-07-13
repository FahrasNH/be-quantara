/**
 * smcScalpGates.js — Sprint 13 Scalping gates + ML feature helpers for AF_SMC.
 *
 * Fail-open defaults: gates only fire when their config flags are explicitly on
 * (Scalping typeOverrides enable them by default in FE/BE presets).
 *
 * Field semantics (SSOT for CSV / docs):
 *   marketCond   — entry-TF vol/trend bucket from SMC (_getMarketCondition):
 *                  DEAD_MARKET | NORMAL | STRONG_TREND | VOLATILE
 *   dailyRegime  — daily ADX-proxy regime (dailyRegimeGate):
 *                  STRONG_TREND | CHOP | TRANSITION | UNKNOWN
 */

"use strict";

const { bbWidthSeries } = require("../af/volumeAnalysisUtils");

/** Default Scalping session block: [21:00, 23:00) UTC (hours 21 and 22). */
const DEFAULT_BLOCK_HOURS_UTC = [21, 22];

/**
 * Session filter — block new entries during configured UTC hours.
 * @param {number|Date|string|null} timestamp
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {number[]} [opts.blockHoursUtc]
 * @returns {{ blocked: boolean, hourUtc: number|null, reason: string|null }}
 */
function applySmcSessionFilter(timestamp, opts = {}) {
  const enabled = opts.enabled === true;
  if (!enabled) {
    return { blocked: false, hourUtc: hourUtcOf(timestamp), reason: null };
  }
  const hourUtc = hourUtcOf(timestamp);
  if (hourUtc == null) {
    return { blocked: false, hourUtc: null, reason: "no_timestamp_fail_open" };
  }
  const blockHours = Array.isArray(opts.blockHoursUtc) && opts.blockHoursUtc.length
    ? opts.blockHoursUtc
    : DEFAULT_BLOCK_HOURS_UTC;
  if (blockHours.includes(hourUtc)) {
    return { blocked: true, hourUtc, reason: `session_block_utc_${hourUtc}` };
  }
  return { blocked: false, hourUtc, reason: null };
}

/**
 * Side × Daily Regime gate — block counter-trend LONGs in CHOP.
 * SHORT remains allowed (mean-reversion / fade works better in chop).
 * @returns {{ allow: boolean, reason: string }}
 */
function applySmcSideRegimeGate({ signal, dailyRegime, enabled } = {}) {
  if (!enabled) return { allow: true, reason: "side_regime_gate_off" };
  if (!signal || !dailyRegime || dailyRegime === "UNKNOWN") {
    return { allow: true, reason: "no_signal_or_unknown_regime" };
  }
  if (dailyRegime === "CHOP" && signal === "LONG") {
    return { allow: false, reason: "chop_long_blocked" };
  }
  return { allow: true, reason: "side_regime_pass" };
}

function hourUtcOf(timestamp) {
  if (timestamp == null || timestamp === "") return null;
  const ms = typeof timestamp === "number"
    ? timestamp
    : Date.parse(timestamp instanceof Date ? timestamp.toISOString() : String(timestamp));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).getUTCHours();
}

/**
 * Resolve Scalping gate flags from flattened cfg + typeOverrides.Scalping.
 * Flattened keys win when already merged by the backtest engine.
 */
function resolveScalpingGateFlags(config = {}) {
  const ov = config.typeOverrides?.Scalping || {};
  return {
    smcSessionFilter: config.smcSessionFilter ?? ov.smcSessionFilter ?? false,
    smcSessionBlockHoursUtc:
      config.smcSessionBlockHoursUtc ?? ov.smcSessionBlockHoursUtc ?? DEFAULT_BLOCK_HOURS_UTC,
    smcBlockLongInChop: config.smcBlockLongInChop ?? ov.smcBlockLongInChop ?? false,
    smcRequireObRetest: config.smcRequireObRetest ?? ov.smcRequireObRetest ?? false,
    maxHoldHours: config.maxHoldHours ?? ov.maxHoldHours ?? ov.scalpingMaxHoldHours ?? null,
  };
}

/**
 * Build granular ML / forensic features at entry for CSV export.
 */
function buildSmcEntryFeatures(indicators, lastIdx, sequenceMeta, opts = {}) {
  const closes = indicators?.closes || [];
  const highs = indicators?.highs || [];
  const lows = indicators?.lows || [];
  const volumes = indicators?.volumes || [];
  const volSMA = indicators?.volSMA || [];
  const atr = opts.atr ?? indicators?.atr?.[lastIdx] ?? null;
  const price = closes[lastIdx] ?? opts.price ?? null;

  const sweepIdx = sequenceMeta?.sweepIdx;
  const dispIdx = sequenceMeta?.dispIdx;
  const fvg = sequenceMeta?.fvg;

  let sweepStrength = null;
  if (Number.isInteger(sweepIdx) && sweepIdx >= 0) {
    const sVol = volumes[sweepIdx] ?? 0;
    const sVSMA = volSMA[sweepIdx] ?? 0;
    sweepStrength = sVSMA > 0 ? round4(sVol / sVSMA) : null;
  }

  let fvgSizeAtr = null;
  if (fvg?.size != null && atr > 0 && price > 0) {
    // fvg.size is typically a fraction of price; convert to ATR multiples
    const fvgAbs = fvg.size * price;
    fvgSizeAtr = round4(fvgAbs / atr);
  } else if (fvg?.top != null && fvg?.bottom != null && atr > 0) {
    fvgSizeAtr = round4(Math.abs(fvg.top - fvg.bottom) / atr);
  }

  let obDistanceAtr = null;
  if (sequenceMeta?.obDistanceAtr != null) {
    obDistanceAtr = round4(sequenceMeta.obDistanceAtr);
  } else if (sequenceMeta?.obZone && price != null && atr > 0) {
    const mid = (sequenceMeta.obZone.low + sequenceMeta.obZone.high) / 2;
    obDistanceAtr = round4(Math.abs(price - mid) / atr);
  } else if (sequenceMeta?.obConfluence === true) {
    obDistanceAtr = 0;
  }

  let displacementPct = null;
  if (Number.isInteger(dispIdx) && dispIdx >= 0 && closes[dispIdx]) {
    const dRange = ((highs[dispIdx] ?? 0) - (lows[dispIdx] ?? 0)) / closes[dispIdx];
    displacementPct = round4(dRange * 100);
  }

  const htfAdx = opts.htfAdx ?? indicators?.adx?.[lastIdx] ?? sequenceMeta?.htfAdx ?? null;

  const ts = opts.timestamp ?? indicators?.timestamps?.[lastIdx] ?? null;
  const hourUtc = hourUtcOf(ts);

  const vol = volumes[lastIdx] ?? 0;
  const vsma = volSMA[lastIdx] ?? 0;
  const volumeRatio = vsma > 0 ? round4(vol / vsma) : null;

  let bbWidth = opts.bbWidth ?? null;
  if (bbWidth == null && closes.length > 20) {
    const widths = bbWidthSeries(closes, lastIdx, 20, 2);
    bbWidth = widths[lastIdx] != null ? round4(widths[lastIdx]) : null;
  }

  const comps = sequenceMeta?.confidenceComponents || null;

  return {
    sweepStrength,
    fvgSizeAtr,
    obDistanceAtr,
    displacementPct,
    htfAdx: htfAdx != null && Number.isFinite(Number(htfAdx)) ? round4(Number(htfAdx)) : null,
    hourUtc,
    volumeRatio,
    bbWidth,
    // Confidence component passthrough (task 2)
    confSweepStrength: comps?.sweepStrength ?? null,
    confFvgSize: comps?.fvgSize ?? null,
    confDisplacementPct: comps?.displacementPct ?? null,
    confHtfAlignment: comps?.htfAlignment ?? null,
    confMitigationDepth: comps?.mitigationDepth ?? null,
    confObConfluence: comps?.obConfluence ?? null,
  };
}

function round4(n) {
  return Number.isFinite(n) ? parseFloat(n.toFixed(4)) : null;
}

/** CSV column keys added in Sprint 13 (BE + FE must stay in sync). */
const SMC_ML_CSV_COLUMNS = [
  ["sweepStrength", "Sweep Strength"],
  ["fvgSizeAtr", "FVG Size ATR"],
  ["obDistanceAtr", "OB Distance ATR"],
  ["displacementPct", "Displacement %"],
  ["htfAdx", "HTF ADX"],
  ["hourUtc", "Hour UTC"],
  ["volumeRatio", "Volume Ratio"],
  ["bbWidth", "BB Width"],
  ["confSweepStrength", "Conf Sweep"],
  ["confFvgSize", "Conf FVG"],
  ["confDisplacementPct", "Conf Disp %"],
  ["confHtfAlignment", "Conf HTF Align"],
];

module.exports = {
  DEFAULT_BLOCK_HOURS_UTC,
  applySmcSessionFilter,
  applySmcSideRegimeGate,
  resolveScalpingGateFlags,
  buildSmcEntryFeatures,
  hourUtcOf,
  SMC_ML_CSV_COLUMNS,
};
