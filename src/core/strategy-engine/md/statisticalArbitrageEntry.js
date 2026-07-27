/**
 * Statistical Arbitrage v1 (STATISTICAL_ARBITRAGE) — MEAN_DRIFT race participant.
 *
 * Pragmatic single-symbol design for the existing backtest pipeline:
 *   residual / z-score of close vs its own rolling mean (and optional VWAP).
 * When a benchmark series is present (indicators.benchmarkCloses, e.g. BTC),
 * also score the residual of symbol vs rolling beta×benchmark (cointegration-lite).
 *
 * Not a true multi-leg pairs engine — labeled Statistical Arbitrage v1.
 */

"use strict";

const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: Statistical Arbitrage Scalping session filter (Asia block). */
function applySaSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const DEFAULTS = {
  lookback: 40,
  entryZ: 2.0, // Gelombang 2: band 2.0–2.5σ — post-patch analysis sweet spot
  entryZMax: 2.5, // Gelombang 1: cap |z| — 2.5+σ = momentum/breakout, not revert
  exitZ: 0.4,
  minBars: 50,
  baseConfidence: 0.58,
  zBoostPerUnit: 0, // Gelombang 1: flat confidence — zBoost was anti-predictive on swing
  maxConfidence: 0.95,
  useVwapBlend: true,
  skipHtfSideways: true, // REGIME_GATE: HTF 1w SIDEWAYS whipsaw skip
  htfRegimeGate: true, // REGIME_GATE sideways skip (NOT directional align)
  /** @deprecated legacy name — use mdSaHtfRegimeGate; same as htfRegimeGate */
  htfAlignGate: true,
  useBenchmarkResidual: true,
  requireTransitionRegime: false, // production SSOT: strategyDefaults.mdSaRequireTransitionRegime=true
};

function _rollingMeanStd(arr, endIdx, lookback) {
  if (!arr || endIdx < lookback - 1) return null;
  let sum = 0;
  let sumSq = 0;
  const start = endIdx - lookback + 1;
  for (let i = start; i <= endIdx; i++) {
    const v = arr[i];
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / lookback;
  const variance = Math.max(0, sumSq / lookback - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Bars (inclusive) that |z| has stayed at/above entryZ on the same side as the signal bar.
 */
function _meanRevertBars(closes, vwap, benchmarkCloses, lastIdx, lookback, entryZ, useVwap) {
  if (!closes || lastIdx < lookback) return null;

  const zAt = (idx) => {
    if (Array.isArray(benchmarkCloses) && benchmarkCloses.length > idx) {
      const resid = _residualZScore(closes, benchmarkCloses, idx, lookback);
      if (resid && Number.isFinite(resid.z)) return resid.z;
    }
    const stats = _rollingMeanStd(closes, idx, lookback);
    if (!stats || !(stats.std > 1e-12)) return null;
    let z = (closes[idx] - stats.mean) / stats.std;
    if (useVwap && Array.isArray(vwap) && vwap[idx] != null && vwap[idx] > 0) {
      const vDev = (closes[idx] - vwap[idx]) / stats.std;
      z = 0.7 * z + 0.3 * vDev;
    }
    return z;
  };

  const zLast = zAt(lastIdx);
  if (zLast == null || Math.abs(zLast) < entryZ) return null;

  let bars = 0;
  for (let i = lastIdx; i >= lookback; i--) {
    const z = zAt(i);
    if (z == null) break;
    if (Math.sign(z) !== Math.sign(zLast) || Math.abs(z) < entryZ) break;
    bars += 1;
  }
  return bars > 0 ? bars : null;
}

function _computeZScore({
  closes,
  vwap,
  benchmarkCloses,
  lastIdx,
  lookback,
  useVwap,
  useBenchmark,
}) {
  let z = null;
  let mode = "rolling_mean";

  if (useBenchmark && Array.isArray(benchmarkCloses) && benchmarkCloses.length > lastIdx) {
    const resid = _residualZScore(closes, benchmarkCloses, lastIdx, lookback);
    if (resid && Number.isFinite(resid.z)) {
      z = resid.z;
      mode = "benchmark_residual";
    }
  }

  if (z == null) {
    const stats = _rollingMeanStd(closes, lastIdx, lookback);
    if (!stats || !(stats.std > 1e-12)) return { z: null, mode: null, stats: null };
    z = (closes[lastIdx] - stats.mean) / stats.std;
    mode = "rolling_mean";
    if (useVwap && Array.isArray(vwap) && vwap[lastIdx] != null && vwap[lastIdx] > 0) {
      const vDev = (closes[lastIdx] - vwap[lastIdx]) / stats.std;
      z = 0.7 * z + 0.3 * vDev;
      mode = "rolling_mean_vwap_blend";
    }
    return { z, mode, stats };
  }

  const stats = _rollingMeanStd(closes, lastIdx, lookback);
  return { z, mode, stats };
}

function _checkSaHtfRegimeGate(htfTrend, htfRegimeGate, ablation) {
  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  // REGIME_GATE only — sideways/whipsaw skip. Directional align is NOT applied here
  // (HTF_Mode REGIME_GATE; engine 7a does not block SA counter-trend).
  if (htfTrend && htfRegimeGate && htfTrend === "SIDEWAYS") {
    _abl("rejHtfSideways");
    return { ok: false, reason: "htf_sideways" };
  }
  return { ok: true, reason: "ok" };
}

/** Ordinary least-squares beta of y on x over lookback ending at endIdx. */
function _residualZScore(y, x, endIdx, lookback) {
  if (!y || !x || endIdx < lookback - 1) return null;
  const start = endIdx - lookback + 1;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = start; i <= endIdx; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXX += x[i] * x[i];
    sumXY += x[i] * y[i];
  }
  const n = lookback;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return null;
  const beta = (n * sumXY - sumX * sumY) / denom;
  const alpha = (sumY - beta * sumX) / n;

  const residuals = [];
  for (let i = start; i <= endIdx; i++) {
    residuals.push(y[i] - (alpha + beta * x[i]));
  }
  let rSum = 0;
  let rSumSq = 0;
  for (const r of residuals) {
    rSum += r;
    rSumSq += r * r;
  }
  const rMean = rSum / n;
  const rStd = Math.sqrt(Math.max(0, rSumSq / n - rMean * rMean));
  if (!(rStd > 1e-12)) return null;
  const lastResidual = residuals[residuals.length - 1];
  return {
    z: (lastResidual - rMean) / rStd,
    beta,
    alpha,
    residual: lastResidual,
  };
}

/**
 * @returns {{
 *   signal: 'LONG'|'SHORT'|null,
 *   confidence: number,
 *   reason: string,
 *   zScore: number|null,
 *   mode: string,
 * }}
 */
function evaluateStatisticalArbitrageEntry({
  closes,
  vwap,
  benchmarkCloses,
  lastIdx,
  config = {},
  ablation = null,
} = {}) {
  const _abl = (k) => {
    if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1;
  };
  _abl("evaluated");

  if (scalpingSessionBlocked(config, { timestamps: config.timestamps }, lastIdx, "saSessionFilter", applySaSessionFilter, ablation)) {
    return { signal: null, confidence: 0, reason: "sa_session_block", meta: null };
  }

  const lookback = config.mdSaLookback ?? DEFAULTS.lookback;
  const entryZ = config.mdSaEntryZ ?? DEFAULTS.entryZ;
  const entryZMax = config.mdSaEntryZMax ?? DEFAULTS.entryZMax;
  const baseConf = config.mdSaBaseConfidence ?? DEFAULTS.baseConfidence;
  const zBoost = config.mdSaZBoostPerUnit ?? DEFAULTS.zBoostPerUnit;
  const maxConf = config.mdSaMaxConfidence ?? DEFAULTS.maxConfidence;
  const useVwap = config.mdSaUseVwapBlend ?? DEFAULTS.useVwapBlend;
  const minBars = config.mdSaMinBars ?? DEFAULTS.minBars;
  const skipSideways = config.mdSaSkipHtfSideways ?? DEFAULTS.skipHtfSideways;
  // mdSaHtfRegimeGate (preferred) / mdSaHtfAlignGate (legacy) — REGIME_GATE only.
  const htfRegimeGate = config.mdSaHtfRegimeGate
    ?? config.mdSaHtfAlignGate
    ?? DEFAULTS.htfRegimeGate;
  const useBenchmark = config.mdSaUseBenchmarkResidual ?? DEFAULTS.useBenchmarkResidual;
  const htfTrend = config.htfTrend ?? null;
  const requireTransition = config.mdSaRequireTransitionRegime ?? DEFAULTS.requireTransitionRegime;
  const dailyRegime = config.dailyRegime ?? null;

  if (requireTransition && dailyRegime !== "TRANSITION") {
    _abl("rejDailyRegime");
    return {
      signal: null,
      confidence: 0,
      reason: "daily_regime_not_transition",
      zScore: null,
      mode: null,
      dailyRegime,
    };
  }

  if (!closes || lastIdx < Math.max(minBars, lookback)) {
    _abl("rejWarmup");
    return { signal: null, confidence: 0, reason: "warmup", zScore: null, mode: null };
  }

  if (htfTrend && (skipSideways || htfRegimeGate) && htfTrend === "SIDEWAYS") {
    _abl("rejHtfSideways");
    return { signal: null, confidence: 0, reason: "htf_sideways", zScore: null, mode: null };
  }

  const { z, mode, stats } = _computeZScore({
    closes,
    vwap,
    benchmarkCloses,
    lastIdx,
    lookback,
    useVwap,
    useBenchmark,
  });

  if (z == null) {
    _abl("rejRollingZ");
    return { signal: null, confidence: 0, reason: "std_too_small", zScore: null, mode: null };
  }

  let signal = null;
  if (z <= -entryZ) signal = "LONG";
  else if (z >= entryZ) signal = "SHORT";

  if (!signal) {
    _abl("rejEntryZ");
    return {
      signal: null, confidence: 0, reason: "z_inside_band", zScore: z, mode,
      mean: stats?.mean ?? null, std: stats?.std ?? null,
      upperBand: stats ? stats.mean + 2 * stats.std : null,
      lowerBand: stats ? stats.mean - 2 * stats.std : null,
    };
  }

  const htfCheck = _checkSaHtfRegimeGate(htfTrend, htfRegimeGate, ablation);
  if (!htfCheck.ok) {
    return {
      signal: null, confidence: 0, reason: htfCheck.reason, zScore: z, mode,
      mean: stats?.mean ?? null, std: stats?.std ?? null,
      upperBand: stats ? stats.mean + 2 * stats.std : null,
      lowerBand: stats ? stats.mean - 2 * stats.std : null,
    };
  }

  if (entryZMax != null && Math.abs(z) > entryZMax) {
    _abl("rejEntryZMax");
    return {
      signal: null, confidence: 0, reason: "z_too_extreme", zScore: z, mode,
      mean: stats?.mean ?? null, std: stats?.std ?? null,
      upperBand: stats ? stats.mean + 2 * stats.std : null,
      lowerBand: stats ? stats.mean - 2 * stats.std : null,
    };
  }

  const excess = Math.abs(z) - entryZ;
  const confidence = Math.min(maxConf, baseConf + excess * zBoost);
  const meanRevertBars = _meanRevertBars(
    closes, vwap, benchmarkCloses, lastIdx, lookback, entryZ, useVwap,
  );

  _abl("passed");
  return {
    signal,
    confidence,
    reason: `sa_v1_${mode}_z${z.toFixed(2)}_${signal.toLowerCase()}`,
    zScore: z,
    mode,
    mean: stats?.mean ?? null,
    std: stats?.std ?? null,
    upperBand: stats ? stats.mean + 2 * stats.std : null,
    lowerBand: stats ? stats.mean - 2 * stats.std : null,
    meanRevertBars,
    saMeanRevertBars: meanRevertBars,
  };
}

/**
 * Current |z| at bar (for mean-reversion exit monitoring).
 */
function computeStatisticalArbitrageZ({
  closes,
  vwap,
  benchmarkCloses,
  lastIdx,
  config = {},
} = {}) {
  const lookback = config.mdSaLookback ?? DEFAULTS.lookback;
  const useVwap = config.mdSaUseVwapBlend ?? DEFAULTS.useVwapBlend;
  const useBenchmark = config.mdSaUseBenchmarkResidual ?? DEFAULTS.useBenchmarkResidual;
  const minBars = config.mdSaMinBars ?? DEFAULTS.minBars;
  if (!closes || lastIdx < Math.max(minBars, lookback)) return null;
  const { z } = _computeZScore({
    closes,
    vwap,
    benchmarkCloses,
    lastIdx,
    lookback,
    useVwap,
    useBenchmark,
  });
  return z;
}

module.exports = {
  DEFAULTS,
  evaluateStatisticalArbitrageEntry,
  computeStatisticalArbitrageZ,
  _rollingMeanStd,
  _residualZScore,
};
