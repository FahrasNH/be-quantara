/**
 * Shared volume / range / swing helpers for AF Wyckoff + VSA components.
 * All helpers are causal (use data up to `lastIdx` only — no look-ahead).
 */

"use strict";

/**
 * Relative volume vs SMA(volume, period).
 * @returns {number|null}
 */
function relativeVolume(volumes, lastIdx, period = 20) {
  if (!volumes || lastIdx < period - 1) return null;
  const vol = volumes[lastIdx];
  if (vol == null || vol === 0) return null;

  let sum = 0;
  let count = 0;
  for (let i = lastIdx - period + 1; i <= lastIdx; i++) {
    const v = volumes[i];
    if (v != null && Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  if (count < period || sum <= 0) return null;
  return vol / (sum / period);
}

/**
 * Close Location Value: (close - low) / (high - low).
 * Flat candle (high == low) → 0.5.
 */
function calculateCLV(high, low, close) {
  if (high == null || low == null || close == null) return 0.5;
  const range = high - low;
  if (range <= 0 || !Number.isFinite(range)) return 0.5;
  return (close - low) / range;
}

/**
 * Classify candle spread vs ATR.
 */
function classifySpread(high, low, atr, wideMult = 1.3, narrowMult = 0.7) {
  if (atr == null || atr <= 0 || high == null || low == null) {
    return { spread: null, isWideSpread: false, isNarrowSpread: false };
  }
  const spread = high - low;
  return {
    spread,
    isWideSpread: spread >= wideMult * atr,
    isNarrowSpread: spread <= narrowMult * atr,
  };
}

/**
 * Percentile rank of value within the lookback window ending at lastIdx (inclusive).
 * Returns 0–100.
 */
function percentileRank(series, lastIdx, lookback = 100) {
  if (!series || lastIdx < 0) return null;
  const value = series[lastIdx];
  if (value == null || !Number.isFinite(value)) return null;

  const start = Math.max(0, lastIdx - lookback + 1);
  let below = 0;
  let total = 0;
  for (let i = start; i <= lastIdx; i++) {
    const v = series[i];
    if (v == null || !Number.isFinite(v)) continue;
    total++;
    if (v <= value) below++;
  }
  if (total === 0) return null;
  return (below / total) * 100;
}

/**
 * Bollinger Band width series: (upper - lower) / middle for each bar up to lastIdx.
 */
function bbWidthSeries(closes, lastIdx, period = 20, stdDev = 2) {
  const widths = new Array(lastIdx + 1).fill(null);
  if (!closes || lastIdx < period - 1) return widths;

  for (let i = period - 1; i <= lastIdx; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    if (!mean || !Number.isFinite(mean)) continue;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += Math.pow(closes[j] - mean, 2);
    }
    variance /= period;
    const std = Math.sqrt(variance);
    const upper = mean + stdDev * std;
    const lower = mean - stdDev * std;
    widths[i] = (upper - lower) / mean;
  }
  return widths;
}

/**
 * Causal swing highs/lows (left-side only confirmation).
 * A swing high at i requires highs[i] > highs[j] for j in [i-leftLook, i).
 */
function findCausalSwingHighs(highs, lastIdx, leftLook = 5, scanBars = 50) {
  const out = [];
  if (!highs || lastIdx < leftLook) return out;
  const start = Math.max(leftLook, lastIdx - scanBars);
  for (let i = start; i <= lastIdx - 1; i++) {
    const h = highs[i];
    if (h == null) continue;
    let ok = true;
    for (let j = i - leftLook; j < i && ok; j++) {
      if (highs[j] >= h) ok = false;
    }
    if (ok) out.push({ idx: i, price: h, type: "high" });
  }
  return out;
}

function findCausalSwingLows(lows, lastIdx, leftLook = 5, scanBars = 50) {
  const out = [];
  if (!lows || lastIdx < leftLook) return out;
  const start = Math.max(leftLook, lastIdx - scanBars);
  for (let i = start; i <= lastIdx - 1; i++) {
    const l = lows[i];
    if (l == null) continue;
    let ok = true;
    for (let j = i - leftLook; j < i && ok; j++) {
      if (lows[j] <= l) ok = false;
    }
    if (ok) out.push({ idx: i, price: l, type: "low" });
  }
  return out;
}

/**
 * Check if lastIdx is within `radius` bars of the nearest causal swing.
 * @returns {{ isNear: boolean, type: 'high'|'low'|null, swing: object|null, distance: number|null }}
 */
function checkSwingProximity(highs, lows, lastIdx, radius = 5, leftLook = 5, scanBars = 50) {
  const highsSw = findCausalSwingHighs(highs, lastIdx, leftLook, scanBars);
  const lowsSw = findCausalSwingLows(lows, lastIdx, leftLook, scanBars);
  const all = [...highsSw, ...lowsSw];
  if (all.length === 0) {
    return { isNear: false, type: null, swing: null, distance: null };
  }

  let nearest = null;
  let bestDist = Infinity;
  for (const s of all) {
    const dist = Math.abs(lastIdx - s.idx);
    if (dist < bestDist) {
      bestDist = dist;
      nearest = s;
    }
  }

  return {
    isNear: bestDist <= radius,
    type: nearest?.type ?? null,
    swing: nearest,
    distance: Number.isFinite(bestDist) ? bestDist : null,
  };
}

/**
 * SMA of a numeric series ending at lastIdx (inclusive).
 */
function smaAt(values, lastIdx, period) {
  if (!values || lastIdx < period - 1) return null;
  let sum = 0;
  for (let i = lastIdx - period + 1; i <= lastIdx; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / period;
}

module.exports = {
  relativeVolume,
  calculateCLV,
  classifySpread,
  percentileRank,
  bbWidthSeries,
  findCausalSwingHighs,
  findCausalSwingLows,
  checkSwingProximity,
  smaAt,
};
