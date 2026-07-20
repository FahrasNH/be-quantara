/**
 * smcEntry.js — Sprint 13 Scalping + Swing gates + ML feature helpers for SMART_MONEY_CONCEPTS.
 *
 * Fail-open defaults: gates only fire when their config flags are explicitly on
 * (typeOverrides enable them by default in FE/BE presets).
 *
 * Field semantics (SSOT for CSV / docs):
 *   marketCond   — entry-TF vol/trend bucket from SMC (_getMarketCondition):
 *                  DEAD_MARKET | NORMAL | STRONG_TREND | VOLATILE
 *   dailyRegime  — daily ADX-proxy regime (dailyRegimeGate):
 *                  STRONG_TREND | CHOP | TRANSITION | UNKNOWN
 */

"use strict";

const { bbWidthSeries } = require("./volumeAnalysisUtils");
const {
  hourInMarketSession,
  hourUtcFromTimestamp,
} = require("../../risk-engine/entryRiskGates");
const { SWING_HOLD } = require("../../../config/strategyDefaults");

/** Default Scalping session block: [21:00, 23:00) UTC (hours 21 and 22). */
const DEFAULT_BLOCK_HOURS_UTC = [21, 22];

/** Swing max hold — SSOT via strategyDefaults SWING_HOLD (5 days). */
const DEFAULT_SWING_MAX_HOLD_HOURS = SWING_HOLD.maxHoldHours;

/** Telegram / live warn after this many hours open (Swing). */
const DEFAULT_SWING_HOLD_WARN_HOURS = 168;

/** Skip entry when |funding| exceeds this (0.02% = 0.0002). */
const DEFAULT_SWING_MAX_FUNDING_RATE = 0.0002;

/**
 * Session filter — block new entries during configured UTC hours or named sessions.
 * When `noTradeSessions` is set (e.g. ['Sydney','Tokyo']), blocks the full Asia
 * window for SMC Scalping. Legacy `blockHoursUtc` still supported when no sessions.
 * @param {number|Date|string|null} timestamp
 * @param {object} [opts]
 * @param {boolean} [opts.enabled]
 * @param {number[]} [opts.blockHoursUtc]
 * @param {string[]} [opts.noTradeSessions]
 * @returns {{ blocked: boolean, hourUtc: number|null, reason: string|null }}
 */
function applySmcSessionFilter(timestamp, opts = {}) {
  const enabled = opts.enabled === true;
  const hourUtc = hourUtcFromTimestamp(timestamp);
  if (!enabled) {
    return { blocked: false, hourUtc, reason: null };
  }
  if (hourUtc == null) {
    return { blocked: false, hourUtc: null, reason: "no_timestamp_fail_open" };
  }

  const noTradeSessions = opts.noTradeSessions;
  if (Array.isArray(noTradeSessions) && noTradeSessions.length) {
    for (const sess of noTradeSessions) {
      if (hourInMarketSession(hourUtc, sess)) {
        return { blocked: true, hourUtc, reason: `session_block_${String(sess).toLowerCase()}` };
      }
    }
    return { blocked: false, hourUtc, reason: null };
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

/**
 * Perp funding guard — skip entry when funding premium is extreme vs side.
 * LONG pays positive funding → block when fundingRate > maxAbs.
 * SHORT pays negative funding → block when fundingRate < -maxAbs.
 * Fail-open when rate missing.
 *
 * @returns {{ allow: boolean, reason: string, fundingRate: number|null, fundingForecast24h: number|null }}
 */
function applySmcFundingGuard({ signal, fundingRate, enabled, maxAbsRate } = {}) {
  const rate = fundingRate == null || fundingRate === "" ? null : Number(fundingRate);
  const forecast24h = rate != null && Number.isFinite(rate) ? round4(rate * 3) : null; // 3×8h periods
  if (!enabled) {
    return { allow: true, reason: "funding_guard_off", fundingRate: rate, fundingForecast24h: forecast24h };
  }
  if (rate == null || !Number.isFinite(rate)) {
    return { allow: true, reason: "no_funding_fail_open", fundingRate: null, fundingForecast24h: null };
  }
  const cap = maxAbsRate ?? DEFAULT_SWING_MAX_FUNDING_RATE;
  if (signal === "LONG" && rate > cap) {
    return { allow: false, reason: "funding_long_premium", fundingRate: rate, fundingForecast24h: forecast24h };
  }
  if (signal === "SHORT" && rate < -cap) {
    return { allow: false, reason: "funding_short_premium", fundingRate: rate, fundingForecast24h: forecast24h };
  }
  return { allow: true, reason: "funding_pass", fundingRate: rate, fundingForecast24h: forecast24h };
}

function hourUtcOf(timestamp) {
  return hourUtcFromTimestamp(timestamp);
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
    noTradeSessions: config.noTradeSessions ?? ov.noTradeSessions ?? null,
    smcBlockLongInChop: config.smcBlockLongInChop ?? ov.smcBlockLongInChop ?? false,
    smcRequireObRetest: config.smcRequireObRetest ?? ov.smcRequireObRetest ?? false,
    maxHoldHours: config.maxHoldHours ?? ov.maxHoldHours ?? ov.scalpingMaxHoldHours ?? null,
  };
}

/**
 * Resolve Swing gate flags from flattened cfg + typeOverrides.Swing.
 */
function resolveSwingGateFlags(config = {}) {
  const ov = config.typeOverrides?.Swing || {};
  return {
    smcRequireObRetest:
      config.smcRequireObRetestSwing ?? ov.smcRequireObRetest ?? config.smcRequireObRetest ?? false,
    // Prefer Swing-specific keys — do not inherit Scalping's flattened maxHoldHours=6
    maxHoldHours:
      ov.maxHoldHours ?? ov.swingMaxHoldHours ?? config.swingMaxHoldHours ?? DEFAULT_SWING_MAX_HOLD_HOURS,
    smcMaxFundingRate:
      config.smcMaxFundingRate ?? ov.smcMaxFundingRate ?? DEFAULT_SWING_MAX_FUNDING_RATE,
    smcFundingGuard: config.smcFundingGuard ?? ov.smcFundingGuard ?? false,
    smcHoldWarnHours:
      config.smcHoldWarnHours ?? ov.smcHoldWarnHours ?? DEFAULT_SWING_HOLD_WARN_HOURS,
    // Marketing / product gate — FOUNDRY/FORGE blocked until 2023 window revalidated
    swingMarketingBlocked: config.swingMarketingBlocked ?? ov.swingMarketingBlocked ?? true,
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
  const chochIdx = sequenceMeta?.chochIdx;
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

  const comps = sequenceMeta?.confidenceComponents
    || opts.confidenceComponents
    || null;

  const sweepAgeBars = Number.isInteger(sweepIdx) && sweepIdx >= 0
    ? lastIdx - sweepIdx
    : null;
  const sweepToChochBars = Number.isInteger(sweepIdx) && Number.isInteger(chochIdx) && chochIdx >= sweepIdx
    ? chochIdx - sweepIdx
    : null;
  const chochToEntryBars = Number.isInteger(chochIdx) && chochIdx >= 0
    ? lastIdx - chochIdx
    : null;
  const fundingRaw = opts.fundingRate ?? indicators?.fundingRate?.[lastIdx] ?? null;
  const fundingRateAtEntry = fundingRaw != null && Number.isFinite(Number(fundingRaw))
    ? round4(Number(fundingRaw))
    : null;
  const fundingForecast24h = fundingRateAtEntry != null ? round4(fundingRateAtEntry * 3) : null;

  return {
    sweepStrength,
    fvgSizeAtr,
    obDistanceAtr,
    displacementPct,
    htfAdx: htfAdx != null && Number.isFinite(Number(htfAdx)) ? round4(Number(htfAdx)) : null,
    hourUtc,
    volumeRatio,
    bbWidth,
    fundingRateAtEntry,
    fundingForecast24h,
    // Confidence component passthrough (task 2)
    confSweepStrength: comps?.sweepStrength ?? null,
    confFvgSize: comps?.fvgSize ?? null,
    confDisplacementPct: comps?.displacementPct ?? null,
    confHtfAlignment: comps?.htfAlignment ?? null,
    confMitigationDepth: comps?.mitigationDepth ?? null,
    confObConfluence: comps?.obConfluence ?? null,
    sweepAgeBars,
    sweepToChochBars,
    chochToEntryBars,
  };
}

/**
 * Hold duration in hours from open/close timestamps (CSV ML column).
 */
function holdHoursBetween(openTs, closeTs) {
  const a = typeof openTs === "number" ? openTs : Date.parse(openTs || "");
  const b = typeof closeTs === "number" ? closeTs : Date.parse(closeTs || "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return round4((b - a) / 3_600_000);
}

/**
 * Cost-model snapshot for backtest meta — Fee=0 audit (Swing task).
 * Callers should attach this to results so every window documents fee assumptions.
 */
function buildCostModelMeta({ enableFees = true, feeRate = 0.0006, simulateFunding = true, fundingRate8h = 0.0001 } = {}) {
  const feesOn = enableFees !== false && feeRate > 0;
  return {
    enableFees: feesOn,
    feeRatePerSide: feesOn ? feeRate : 0,
    simulateFunding: feesOn && simulateFunding !== false,
    fundingRate8h: feesOn && simulateFunding !== false ? fundingRate8h : 0,
    note: feesOn
      ? "Fees + funding accrued on every closed trade"
      : "WARNING: cost model OFF — Fee/Funding will be 0 (do not use as baseline)",
  };
}

function round4(n) {
  return Number.isFinite(n) ? parseFloat(n.toFixed(4)) : null;
}

/**
 * Sweet-spot scorer for confidence components (Sprint 13 inverted-confidence fix).
 * Monotonic "bigger = better" rewarded chase entries; extremes now decay.
 * Peak at `peak`, full credit near peak, taper to `floor` beyond `outer`.
 */
function sweetSpotPts(value, { peak, inner, outer, maxPts, floor = 0 } = {}) {
  if (value == null || !Number.isFinite(value) || maxPts <= 0) return 0;
  const d = Math.abs(value - peak);
  if (d <= inner) return maxPts;
  if (d >= outer) return floor;
  const t = (d - inner) / Math.max(outer - inner, 1e-9);
  return maxPts * (1 - t) + floor * t;
}

/** CSV column keys added in Sprint 13 (BE + FE must stay in sync). */
const SMC_ML_CSV_COLUMNS = [
  ["gradedScore", "Graded Score"],
  ["gradedScoreBreakdown", "Graded Score Breakdown"],
  ["scoringStrategyKey", "Scoring Strategy Key"],
  ["sweepStrength", "Sweep Strength"],
  ["fvgSizeAtr", "FVG Size ATR"],
  ["obDistanceAtr", "OB Distance ATR"],
  ["displacementPct", "Displacement %"],
  ["htfAdx", "HTF ADX"],
  ["hourUtc", "Hour UTC"],
  ["volumeRatio", "Volume Ratio"],
  ["bbWidth", "BB Width"],
  ["fundingRateAtEntry", "Funding Rate At Entry"],
  ["fundingForecast24h", "Funding Forecast 24h"],
  ["holdHours", "Hold Hours"],
  ["confSweepStrength", "Conf Sweep"],
  ["confFvgSize", "Conf FVG"],
  ["confDisplacementPct", "Conf Disp %"],
  ["confHtfAlignment", "Conf HTF Align"],
  ["confMitigationDepth", "Conf Mitigation"],
  ["confObConfluence", "Conf OB Confluence"],
  ["sweepAgeBars", "Sweep Age Bars"],
  ["sweepToChochBars", "Sweep To CHoCH Bars"],
  ["chochToEntryBars", "CHoCH To Entry Bars"],
  ["mfe", "MFE"],
  ["mae", "MAE"],
  ["mfePercent", "MFE %"],
  ["maePercent", "MAE %"],
  ["exitEfficiency", "Exit Efficiency"],
];

module.exports = {
  DEFAULT_BLOCK_HOURS_UTC,
  DEFAULT_SWING_MAX_HOLD_HOURS,
  DEFAULT_SWING_HOLD_WARN_HOURS,
  DEFAULT_SWING_MAX_FUNDING_RATE,
  applySmcSessionFilter,
  applySmcSideRegimeGate,
  applySmcFundingGuard,
  resolveScalpingGateFlags,
  resolveSwingGateFlags,
  buildSmcEntryFeatures,
  buildCostModelMeta,
  holdHoursBetween,
  hourUtcOf,
  sweetSpotPts,
  SMC_ML_CSV_COLUMNS,
};
