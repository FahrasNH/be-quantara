/**
 * Auction Market Theory (VWAP + Value Area) for Trend Surge (TS-SUB-02).
 *
 * - Session VWAP resets daily at UTC midnight (aligned with Quantara daily loss counter).
 * - Volume Profile: 20-bin histogram → POC + Value Area (70% volume).
 *
 * Sprint 12 architecture decision: race participant (independent signal
 * generator via VWAP reclaim / VA edge bounce). Precision helpers remain for
 * `tsCombinationMode: "gate"` rollback / A-B comparison.
 */

"use strict";

const DEFAULTS = {
  bins: 20,
  valueAreaPct: 0.7,
  // Spec TS-SUB-02: abs(price - VWAP) <= vwapAtrMult × ATR(14).
  // 0.5×ATR (was wrongly implemented as 0.25% of price) — 0.3 was too tight on 5m crypto.
  vwapAtrMult: 0.5,
  vwapTolerancePct: 0.005, // fallback when ATR unavailable (~0.5%)
  minSessionBars: 20, // AC5: skip refinement until session has enough bars
};

/**
 * Find start index of the UTC day containing lastIdx.
 * Prefer candle timestamps when available; otherwise treat the whole window as one session.
 */
function sessionStartIdx(timestamps, lastIdx) {
  if (!Array.isArray(timestamps) || lastIdx < 0) return 0;
  const ts = timestamps[lastIdx];
  if (ts == null || !Number.isFinite(ts)) return 0;

  const dayStart = Math.floor(ts / 86_400_000) * 86_400_000;
  for (let i = lastIdx; i >= 0; i--) {
    const t = timestamps[i];
    if (t == null || !Number.isFinite(t) || t < dayStart) {
      return Math.min(lastIdx, i + 1);
    }
  }
  return 0;
}

/**
 * Session-anchored VWAP up to lastIdx (inclusive).
 * Typical price = (H+L+C)/3.
 * @returns {{ vwap: number|null, bars: number, startIdx: number }}
 */
function calculateSessionVwap(highs, lows, closes, volumes, timestamps, lastIdx) {
  const start = sessionStartIdx(timestamps, lastIdx);
  let pv = 0;
  let vol = 0;
  for (let i = start; i <= lastIdx; i++) {
    const h = highs?.[i];
    const l = lows?.[i];
    const c = closes?.[i];
    const v = volumes?.[i];
    if (h == null || l == null || c == null || v == null || !Number.isFinite(v) || v <= 0) continue;
    const typical = (h + l + c) / 3;
    if (!Number.isFinite(typical)) continue;
    pv += typical * v;
    vol += v;
  }
  if (vol <= 0) return { vwap: null, bars: 0, startIdx: start };
  return { vwap: pv / vol, bars: lastIdx - start + 1, startIdx: start };
}

/**
 * Build volume profile histogram for [startIdx, lastIdx].
 * @returns {{ poc: number|null, vah: number|null, val: number|null, bins: Array, totalVolume: number }}
 */
function buildVolumeProfile(highs, lows, closes, volumes, startIdx, lastIdx, bins = 20, valueAreaPct = 0.7) {
  let lo = Infinity;
  let hi = -Infinity;
  let totalVolume = 0;
  const rows = [];

  for (let i = startIdx; i <= lastIdx; i++) {
    const h = highs?.[i];
    const l = lows?.[i];
    const c = closes?.[i];
    const v = volumes?.[i];
    if (h == null || l == null || c == null || v == null || !Number.isFinite(v) || v <= 0) continue;
    lo = Math.min(lo, l);
    hi = Math.max(hi, h);
    totalVolume += v;
    rows.push({ h, l, c, v });
  }

  if (!rows.length || !Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || totalVolume <= 0) {
    return { poc: null, vah: null, val: null, bins: [], totalVolume: 0 };
  }

  const nBins = Math.max(5, bins | 0);
  const step = (hi - lo) / nBins;
  const hist = Array.from({ length: nBins }, (_, i) => ({
    idx: i,
    low: lo + i * step,
    high: lo + (i + 1) * step,
    mid: lo + (i + 0.5) * step,
    volume: 0,
  }));

  for (const row of rows) {
    // Attribute volume to the bin of the typical price (stable vs full-range smear).
    const typical = (row.h + row.l + row.c) / 3;
    let binIdx = Math.floor((typical - lo) / step);
    if (binIdx < 0) binIdx = 0;
    if (binIdx >= nBins) binIdx = nBins - 1;
    hist[binIdx].volume += row.v;
  }

  let pocIdx = 0;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i].volume > hist[pocIdx].volume) pocIdx = i;
  }

  // Expand Value Area around POC until valueAreaPct of volume is covered.
  let covered = hist[pocIdx].volume;
  let left = pocIdx;
  let right = pocIdx;
  const target = totalVolume * valueAreaPct;
  while (covered < target && (left > 0 || right < nBins - 1)) {
    const leftVol = left > 0 ? hist[left - 1].volume : -1;
    const rightVol = right < nBins - 1 ? hist[right + 1].volume : -1;
    if (rightVol >= leftVol && right < nBins - 1) {
      right++;
      covered += hist[right].volume;
    } else if (left > 0) {
      left--;
      covered += hist[left].volume;
    } else if (right < nBins - 1) {
      right++;
      covered += hist[right].volume;
    } else {
      break;
    }
  }

  return {
    poc: hist[pocIdx].mid,
    vah: hist[right].high,
    val: hist[left].low,
    bins: hist,
    totalVolume,
  };
}

function priceNear(level, price, tolPct) {
  if (level == null || price == null || !Number.isFinite(level) || !Number.isFinite(price)) return false;
  const tol = Math.abs(level) * tolPct;
  return Math.abs(price - level) <= tol;
}

function priceNearAbs(level, price, tolAbs) {
  if (level == null || price == null || !Number.isFinite(level) || !Number.isFinite(price)) return false;
  if (tolAbs == null || !Number.isFinite(tolAbs) || tolAbs <= 0) return false;
  return Math.abs(price - level) <= tolAbs;
}

function priceInBand(price, low, high) {
  if (price == null || low == null || high == null) return false;
  return price >= low && price <= high;
}

function resolveVwapTolerance(indicators, lastIdx, cfg) {
  const atr = indicators?.atr?.[lastIdx];
  const mult = cfg.vwapAtrMult ?? DEFAULTS.vwapAtrMult;
  if (atr != null && Number.isFinite(atr) && atr > 0 && mult > 0) {
    return { tolAbs: atr * mult, mode: "atr", atr, mult };
  }
  return { tolAbs: null, mode: "pct", atr: null, mult };
}

/**
 * Evaluate VWAP / Value Area entry precision for a proposed direction.
 *
 * @returns {{ allowed: boolean, vote: string, confidence: number, reason: string, meta: object }}
 */
function evaluateVolumeProfilePrecision(indicators, lastIdx, direction, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const closes = indicators.closes || [];
  const volumes = indicators.volumes || [];
  const timestamps = indicators.timestamps || indicators.times || indicators.openTimes || null;

  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx
  );

  if (bars < cfg.minSessionBars || vwap == null) {
    // Early session: do not block entries (insufficient VWAP/profile data).
    return {
      allowed: true,
      vote: "NEUTRAL",
      confidence: 0,
      reason: "session_warmup_passthrough",
      meta: { bars, vwap, startIdx },
    };
  }

  const profile = buildVolumeProfile(
    highs, lows, closes, volumes, startIdx, lastIdx, cfg.bins, cfg.valueAreaPct
  );

  const price = closes[lastIdx];
  const { tolAbs, mode, atr, mult } = resolveVwapTolerance(indicators, lastIdx, cfg);
  const nearVwap = tolAbs != null
    ? priceNearAbs(vwap, price, tolAbs)
    : priceNear(vwap, price, cfg.vwapTolerancePct);
  const inValueArea = priceInBand(price, profile.val, profile.vah);
  const nearPoc = tolAbs != null
    ? priceNearAbs(profile.poc, price, tolAbs)
    : priceNear(profile.poc, price, cfg.vwapTolerancePct);

  const overlap = nearVwap || inValueArea || nearPoc;
  const meta = {
    vwap,
    poc: profile.poc,
    vah: profile.vah,
    val: profile.val,
    price,
    nearVwap,
    inValueArea,
    nearPoc,
    bars,
    startIdx,
    tolMode: mode,
    tolAbs,
    atr,
    vwapAtrMult: mult,
  };

  if (!overlap) {
    return {
      allowed: false,
      vote: "NEUTRAL",
      confidence: 0,
      reason: "outside_vwap_value_area",
      meta,
    };
  }

  // Directional bias: prefer long above VWAP / short below when inside VA.
  let confidence = 0.55;
  if (nearPoc) confidence += 0.15;
  if (nearVwap) confidence += 0.1;
  if (inValueArea) confidence += 0.1;
  confidence = Math.min(1, confidence);

  const deepTol = tolAbs != null ? tolAbs * 2 : Math.abs(vwap) * cfg.vwapTolerancePct * 2;
  if (direction === "LONG" && price < vwap - deepTol && !nearPoc) {
    // Deep discount below VWAP without POC support — weaker long precision
    confidence = Math.max(0.4, confidence - 0.2);
  }
  if (direction === "SHORT" && price > vwap + deepTol && !nearPoc) {
    confidence = Math.max(0.4, confidence - 0.2);
  }

  return {
    allowed: true,
    vote: direction === "LONG" || direction === "SHORT" ? direction : "NEUTRAL",
    confidence,
    reason: nearVwap ? "vwap_retest" : nearPoc ? "poc_retest" : "value_area_overlap",
    meta,
  };
}

/**
 * Standalone component evaluation (no direction) — bias from price vs VWAP.
 */
function evaluateVolumeProfileComponent(indicators, lastIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const closes = indicators.closes || [];
  const volumes = indicators.volumes || [];
  const timestamps = indicators.timestamps || indicators.times || indicators.openTimes || null;
  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx
  );
  if (vwap == null || bars < cfg.minSessionBars) {
    return { vote: "NEUTRAL", confidence: 0, reason: "session_warmup", meta: { bars, vwap } };
  }
  const profile = buildVolumeProfile(
    highs, lows, closes, volumes, startIdx, lastIdx, cfg.bins, cfg.valueAreaPct
  );
  const price = closes[lastIdx];
  if (price == null) {
    return { vote: "NEUTRAL", confidence: 0, reason: "no_price", meta: { vwap } };
  }
  const inVA = priceInBand(price, profile.val, profile.vah);
  const { tolAbs } = resolveVwapTolerance(indicators, lastIdx, cfg);
  const nearVwap = tolAbs != null
    ? priceNearAbs(vwap, price, tolAbs)
    : priceNear(vwap, price, cfg.vwapTolerancePct);
  if (!inVA && !nearVwap) {
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: "outside_liquidity_zones",
      meta: { vwap, poc: profile.poc, vah: profile.vah, val: profile.val, price },
    };
  }
  if (price >= vwap) {
    return {
      vote: "LONG",
      confidence: 0.6,
      reason: "above_vwap",
      meta: { vwap, poc: profile.poc, vah: profile.vah, val: profile.val, price },
    };
  }
  return {
    vote: "SHORT",
    confidence: 0.6,
    reason: "below_vwap",
    meta: { vwap, poc: profile.poc, vah: profile.vah, val: profile.val, price },
  };
}

/**
 * Full race-participant entry for Auction Market Theory (Sprint 12).
 * Edge-triggered only:
 *   LONG  — VWAP reclaim (prev < VWAP ≤ close) OR bounce off VAL
 *   SHORT — VWAP lose (prev > VWAP ≥ close) OR rejection off VAH
 *
 * @returns {{ vote, confidence, reason, meta, signal }}
 */
function evaluateVolumeProfileEntry(indicators, lastIdx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const closes = indicators.closes || [];
  const opens = indicators.opens || [];
  const volumes = indicators.volumes || [];
  const timestamps = indicators.timestamps || indicators.times || indicators.openTimes || null;

  if (!Number.isInteger(lastIdx) || lastIdx < 1) {
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "session_warmup",
      meta: {},
    };
  }

  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx
  );
  if (bars < cfg.minSessionBars || vwap == null) {
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "session_warmup",
      meta: { bars, vwap, startIdx },
    };
  }

  const profile = buildVolumeProfile(
    highs, lows, closes, volumes, startIdx, lastIdx, cfg.bins, cfg.valueAreaPct
  );
  const price = closes[lastIdx];
  const prev = closes[lastIdx - 1];
  const open = opens[lastIdx];
  const barLow = lows[lastIdx];
  const barHigh = highs[lastIdx];
  if (price == null || prev == null || !Number.isFinite(price) || !Number.isFinite(prev)) {
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "no_price",
      meta: { vwap },
    };
  }

  const { tolAbs, mode, atr, mult } = resolveVwapTolerance(indicators, lastIdx, cfg);
  const metaBase = {
    vwap,
    poc: profile.poc,
    vah: profile.vah,
    val: profile.val,
    price,
    prev,
    bars,
    startIdx,
    tolMode: mode,
    tolAbs,
    atr,
    vwapAtrMult: mult,
  };

  // VWAP reclaim / lose (primary AMT entry)
  if (prev < vwap && price >= vwap) {
    return {
      vote: "LONG",
      signal: "LONG",
      confidence: 0.72,
      reason: "vwap_reclaim",
      meta: metaBase,
    };
  }
  if (prev > vwap && price <= vwap) {
    return {
      vote: "SHORT",
      signal: "SHORT",
      confidence: 0.72,
      reason: "vwap_lose",
      meta: metaBase,
    };
  }

  // Value Area edge bounce / rejection
  const val = profile.val;
  const vah = profile.vah;
  const edgeTol = tolAbs != null && tolAbs > 0
    ? tolAbs
    : Math.abs(vwap) * cfg.vwapTolerancePct;

  if (val != null && Number.isFinite(val) && barLow != null) {
    const touchedVal = barLow <= val + edgeTol;
    const closedAbove = price > val && (open == null || price >= open || price > prev);
    if (touchedVal && closedAbove && price >= vwap - edgeTol) {
      return {
        vote: "LONG",
        signal: "LONG",
        confidence: 0.68,
        reason: "val_bounce",
        meta: { ...metaBase, edgeTol },
      };
    }
  }

  if (vah != null && Number.isFinite(vah) && barHigh != null) {
    const touchedVah = barHigh >= vah - edgeTol;
    const closedBelow = price < vah && (open == null || price <= open || price < prev);
    if (touchedVah && closedBelow && price <= vwap + edgeTol) {
      return {
        vote: "SHORT",
        signal: "SHORT",
        confidence: 0.68,
        reason: "vah_reject",
        meta: { ...metaBase, edgeTol },
      };
    }
  }

  return {
    vote: "NEUTRAL",
    signal: null,
    confidence: 0,
    reason: "awaiting_amt_trigger",
    meta: metaBase,
  };
}

module.exports = {
  DEFAULTS,
  sessionStartIdx,
  calculateSessionVwap,
  buildVolumeProfile,
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileComponent,
  evaluateVolumeProfileEntry,
  resolveVwapTolerance,
};
