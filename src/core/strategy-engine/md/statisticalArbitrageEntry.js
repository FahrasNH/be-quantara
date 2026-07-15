/**
 * Statistical Arbitrage v1 (MD_SA) — MEAN_DRIFT race participant.
 *
 * Pragmatic single-symbol design for the existing backtest pipeline:
 *   residual / z-score of close vs its own rolling mean (and optional VWAP).
 * When a benchmark series is present (indicators.benchmarkCloses, e.g. BTC),
 * also score the residual of symbol vs rolling beta×benchmark (cointegration-lite).
 *
 * Not a true multi-leg pairs engine — labeled Statistical Arbitrage v1.
 */

"use strict";

const DEFAULTS = {
  lookback: 40,
  entryZ: 1.6,
  exitZ: 0.4,
  minBars: 50,
  baseConfidence: 0.58,
  zBoostPerUnit: 0.12, // extra conf per |z| above entryZ
  maxConfidence: 0.95,
  useVwapBlend: true,
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
 * Ordinary least-squares beta of y on x over lookback ending at endIdx.
 * Returns residual z-score of last point.
 */
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
} = {}) {
  const lookback = config.mdSaLookback ?? DEFAULTS.lookback;
  const entryZ = config.mdSaEntryZ ?? DEFAULTS.entryZ;
  const baseConf = config.mdSaBaseConfidence ?? DEFAULTS.baseConfidence;
  const zBoost = config.mdSaZBoostPerUnit ?? DEFAULTS.zBoostPerUnit;
  const maxConf = config.mdSaMaxConfidence ?? DEFAULTS.maxConfidence;
  const useVwap = config.mdSaUseVwapBlend ?? DEFAULTS.useVwapBlend;

  if (!closes || lastIdx < Math.max(DEFAULTS.minBars, lookback)) {
    return { signal: null, confidence: 0, reason: "warmup", zScore: null, mode: null };
  }

  let z = null;
  let mode = "rolling_mean";

  // Prefer residual vs benchmark when available (true-ish pairs lite)
  if (Array.isArray(benchmarkCloses) && benchmarkCloses.length > lastIdx) {
    const resid = _residualZScore(closes, benchmarkCloses, lastIdx, lookback);
    if (resid && Number.isFinite(resid.z)) {
      z = resid.z;
      mode = "benchmark_residual";
    }
  }

  if (z == null) {
    const stats = _rollingMeanStd(closes, lastIdx, lookback);
    if (!stats || !(stats.std > 1e-12)) {
      return { signal: null, confidence: 0, reason: "std_too_small", zScore: null, mode: null };
    }
    z = (closes[lastIdx] - stats.mean) / stats.std;
    mode = "rolling_mean";

    // Soft VWAP blend: if far from VWAP in same direction, nudge |z|
    if (useVwap && Array.isArray(vwap) && vwap[lastIdx] != null && vwap[lastIdx] > 0) {
      const vDev = (closes[lastIdx] - vwap[lastIdx]) / stats.std;
      z = 0.7 * z + 0.3 * vDev;
      mode = "rolling_mean_vwap_blend";
    }

    let signal = null;
    if (z <= -entryZ) signal = "LONG";
    else if (z >= entryZ) signal = "SHORT";

    if (!signal) {
      return {
        signal: null, confidence: 0, reason: "z_inside_band", zScore: z, mode,
        mean: stats.mean, std: stats.std,
        upperBand: stats.mean + 2 * stats.std,
        lowerBand: stats.mean - 2 * stats.std,
      };
    }

    const excess = Math.abs(z) - entryZ;
    const confidence = Math.min(maxConf, baseConf + excess * zBoost);
    return {
      signal,
      confidence,
      reason: `sa_v1_${mode}_z${z.toFixed(2)}_${signal.toLowerCase()}`,
      zScore: z,
      mode,
      mean: stats.mean,
      std: stats.std,
      upperBand: stats.mean + 2 * stats.std,
      lowerBand: stats.mean - 2 * stats.std,
    };
  }

  // Benchmark residual path — still compute rolling bands for export
  const stats = _rollingMeanStd(closes, lastIdx, lookback);
  let signal = null;
  if (z <= -entryZ) signal = "LONG";
  else if (z >= entryZ) signal = "SHORT";

  if (!signal) {
    return {
      signal: null, confidence: 0, reason: "z_inside_band", zScore: z, mode,
      mean: stats?.mean ?? null, std: stats?.std ?? null,
      upperBand: stats ? stats.mean + 2 * stats.std : null,
      lowerBand: stats ? stats.mean - 2 * stats.std : null,
    };
  }

  const excess = Math.abs(z) - entryZ;
  const confidence = Math.min(maxConf, baseConf + excess * zBoost);

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
  };
}

module.exports = {
  DEFAULTS,
  evaluateStatisticalArbitrageEntry,
  _rollingMeanStd,
  _residualZScore,
};
