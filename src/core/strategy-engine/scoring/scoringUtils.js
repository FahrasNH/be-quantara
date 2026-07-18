"use strict";

const { sweetSpotPts } = require("../af/smcEntry");

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function roundPts(n) {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

/** Map value linearly from [min,max] → [0,maxPts]; clamps outside range. */
function linearPts(value, min, max, maxPts) {
  if (value == null || !Number.isFinite(value) || maxPts <= 0) return 0;
  if (max <= min) return value >= min ? maxPts : 0;
  const t = clamp((value - min) / (max - min), 0, 1);
  return roundPts(t * maxPts);
}

/** Higher raw value → lower score (e.g. bars since retest, BB width). */
function inverseLinearPts(value, min, max, maxPts) {
  if (value == null || !Number.isFinite(value) || maxPts <= 0) return 0;
  if (max <= min) return value <= min ? maxPts : 0;
  const t = clamp((max - value) / (max - min), 0, 1);
  return roundPts(t * maxPts);
}

function booleanPts(value, maxPts) {
  if (maxPts <= 0) return 0;
  return value ? maxPts : 0;
}

function enumPts(value, mapping, maxPts) {
  if (maxPts <= 0 || !value) return 0;
  const key = String(value).toUpperCase().replace(/[\s-]+/g, "_");
  const ratio = mapping[key];
  if (ratio == null) return 0;
  return roundPts(maxPts * clamp(ratio, 0, 1));
}

/** Distance to target — closer → higher score (proximity). */
function proximityPts(distance, maxDistance, maxPts) {
  if (distance == null || !Number.isFinite(distance) || maxPts <= 0) return 0;
  if (maxDistance <= 0) return distance === 0 ? maxPts : 0;
  const t = clamp(1 - Math.abs(distance) / maxDistance, 0, 1);
  return roundPts(t * maxPts);
}

function sumBreakdown(breakdown) {
  const total = Object.values(breakdown).reduce((s, v) => s + (Number(v) || 0), 0);
  return clamp(Math.round(total), 0, 100);
}

function finalizeBreakdown(breakdown) {
  const out = {};
  for (const [k, v] of Object.entries(breakdown)) {
    out[k] = roundPts(v);
  }
  return { total: sumBreakdown(out), breakdown: out };
}

module.exports = {
  clamp,
  roundPts,
  linearPts,
  inverseLinearPts,
  booleanPts,
  enumPts,
  proximityPts,
  sweetSpotPts,
  sumBreakdown,
  finalizeBreakdown,
};
