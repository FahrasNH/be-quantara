/**
 * ICT-style trading (ICT_STYLE_TRADING) — BREAKOUT_STORM race participant.
 *
 * Kill Zone UTC windows + Liquidity Raid as standalone reversal entry:
 *   raid HIGH (sweep session high + close back) → SHORT
 *   raid LOW  (sweep session low  + close back) → LONG
 *
 * Kill zone is preferred timing; outside kill zone still allowed at reduced
 * confidence to avoid 0-trade over-filtering (tunable).
 */

"use strict";

const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: ICT Scalping session filter (Asia block). */
function applyIctSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const KILL_ZONES = [
  { name: "london_open", startMin: 7 * 60, endMin: 9 * 60 },
  { name: "ny_open", startMin: 12 * 60, endMin: 14 * 60 },
  { name: "london_close", startMin: 15 * 60, endMin: 16 * 60 },
];

const DEFAULTS = {
  sessionLookback: 20,
  volumeMult: 1.25,
  raidConfirmBars: 1, // close back within same bar (next-bar handled by caller if needed)
  baseConfidence: 0.7,
  outsideKzConfidence: 0.45,
  requireKillZone: false, // soft preference — set true for hard gate
  minWickBeyondPct: 0.0005, // min sweep beyond level as fraction of price
};

/**
 * @param {number|Date|string} timestampUTC — ms epoch or Date
 * @returns {{ active: boolean, zone: string|null, minuteOfDay: number }}
 */
function isKillZone(timestampUTC, zones = KILL_ZONES) {
  if (timestampUTC == null) {
    return { active: false, zone: null, minuteOfDay: -1, reason: "missing_timestamp" };
  }
  const d = timestampUTC instanceof Date ? timestampUTC : new Date(timestampUTC);
  if (Number.isNaN(d.getTime())) {
    return { active: false, zone: null, minuteOfDay: -1, reason: "invalid_timestamp" };
  }
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const z of zones) {
    if (minuteOfDay >= z.startMin && minuteOfDay < z.endMin) {
      return { active: true, zone: z.name, minuteOfDay };
    }
  }
  return { active: false, zone: null, minuteOfDay };
}

/**
 * Detect liquidity raid at lastIdx (sweep + rejection close).
 *
 * @returns {{ detected: boolean, direction: 'LONG'|'SHORT'|null, level: number|null, reason: string }}
 */
function detectLiquidityRaid(highs, lows, closes, volumes, volSMA, lastIdx, opts = {}) {
  const lookback = opts.sessionLookback ?? DEFAULTS.sessionLookback;
  const volMult = opts.volumeMult ?? DEFAULTS.volumeMult;
  const minBeyond = opts.minWickBeyondPct ?? DEFAULTS.minWickBeyondPct;
  const atr = opts.atr;

  if (!highs || !lows || !closes || lastIdx < lookback + 1) {
    return { detected: false, direction: null, level: null, reason: "warmup" };
  }

  // Session high/low EXCLUDING current bar
  const from = lastIdx - lookback;
  let sessionHigh = -Infinity;
  let sessionLow = Infinity;
  for (let i = from; i < lastIdx; i++) {
    if (highs[i] > sessionHigh) sessionHigh = highs[i];
    if (lows[i] < sessionLow) sessionLow = lows[i];
  }
  if (!Number.isFinite(sessionHigh) || !Number.isFinite(sessionLow)) {
    return { detected: false, direction: null, level: null, reason: "no_session_levels" };
  }

  const h = highs[lastIdx];
  const l = lows[lastIdx];
  const c = closes[lastIdx];
  const px = Math.max(Math.abs(c), 1e-12);
  const volNow = volumes?.[lastIdx] ?? 0;
  const vsma = Array.isArray(volSMA) ? (volSMA[lastIdx] ?? volSMA[lastIdx - 1]) : volSMA;
  const volOk = !(vsma > 0) || volNow >= vsma * volMult;
  const range = Math.max(h - l, 1e-12);

  const _raidMetrics = (direction, level, sweepExtreme) => {
    const sweepDepth = direction === "SHORT"
      ? Math.max(0, sweepExtreme - level)
      : Math.max(0, level - sweepExtreme);
    const raidDepthAtr = atr > 0 ? sweepDepth / atr : null;
    const mssPct = direction === "SHORT"
      ? Math.min(1, Math.max(0, (level - c) / range))
      : Math.min(1, Math.max(0, (c - level) / range));
    return { raidDepthAtr, mssPct };
  };

  // Raid HIGH → SHORT (liquidity grab above, reverse down)
  const sweptHigh = h > sessionHigh * (1 + minBeyond) || h > sessionHigh;
  const closedBackHigh = c < sessionHigh;
  if (sweptHigh && closedBackHigh && volOk) {
    const metrics = _raidMetrics("SHORT", sessionHigh, h);
    return {
      detected: true,
      direction: "SHORT",
      level: sessionHigh,
      reason: "raid_high_reversal",
      sessionHigh,
      sessionLow,
      volOk: true,
      volumeRatio: vsma > 0 ? volNow / vsma : null,
      ...metrics,
    };
  }

  // Raid LOW → LONG
  const sweptLow = l < sessionLow * (1 - minBeyond) || l < sessionLow;
  const closedBackLow = c > sessionLow;
  if (sweptLow && closedBackLow && volOk) {
    const metrics = _raidMetrics("LONG", sessionLow, l);
    return {
      detected: true,
      direction: "LONG",
      level: sessionLow,
      reason: "raid_low_reversal",
      sessionHigh,
      sessionLow,
      volOk: true,
      volumeRatio: vsma > 0 ? volNow / vsma : null,
      ...metrics,
    };
  }

  // Soft path: sweep + close-back without volume (reduced confidence upstream)
  if (sweptHigh && closedBackHigh) {
    const metrics = _raidMetrics("SHORT", sessionHigh, h);
    return {
      detected: true,
      direction: "SHORT",
      level: sessionHigh,
      reason: "raid_high_soft_vol",
      sessionHigh,
      sessionLow,
      volOk: false,
      volumeRatio: vsma > 0 ? volNow / vsma : null,
      ...metrics,
    };
  }
  if (sweptLow && closedBackLow) {
    const metrics = _raidMetrics("LONG", sessionLow, l);
    return {
      detected: true,
      direction: "LONG",
      level: sessionLow,
      reason: "raid_low_soft_vol",
      sessionHigh,
      sessionLow,
      volOk: false,
      volumeRatio: vsma > 0 ? volNow / vsma : null,
      ...metrics,
    };
  }

  return {
    detected: false,
    direction: null,
    level: null,
    reason: "no_raid",
    sessionHigh,
    sessionLow,
    volOk,
  };
}

/**
 * Full ICT-style standalone entry.
 */
function evaluateIctStyleEntry({
  highs,
  lows,
  closes,
  volumes,
  volSMA,
  timestamps,
  lastIdx,
  atr,
  ablation = null,
  config = {},
} = {}) {
  const _abl = (k) => { if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1; };
  const requireKz = config.bsIctRequireKillZone ?? DEFAULTS.requireKillZone;
  const baseConf = config.bsIctBaseConfidence ?? DEFAULTS.baseConfidence;
  const outsideConf = config.bsIctOutsideKzConfidence ?? DEFAULTS.outsideKzConfidence;

  _abl("evaluated");

  if (scalpingSessionBlocked(config, { timestamps }, lastIdx, "ictSessionFilter", applyIctSessionFilter, ablation)) {
    return { signal: null, confidence: 0, reason: "ict_session_block", meta: null };
  }

  const ts = Array.isArray(timestamps) ? timestamps[lastIdx] : timestamps;
  const kz = isKillZone(ts);

  const raid = detectLiquidityRaid(highs, lows, closes, volumes, volSMA, lastIdx, {
    sessionLookback: config.bsIctSessionLookback ?? DEFAULTS.sessionLookback,
    volumeMult: config.bsIctVolumeMult ?? DEFAULTS.volumeMult,
    minWickBeyondPct: config.bsIctMinWickBeyondPct ?? DEFAULTS.minWickBeyondPct,
    atr: atr ?? config.atr,
  });

  if (!raid.detected) {
    _abl("rejRaid");
    return {
      signal: null,
      confidence: 0,
      reason: raid.reason || "no_raid",
      killZone: kz,
      raid,
    };
  }

  if (requireKz && !kz.active) {
    _abl("rejHardKillZone");
    return {
      signal: null,
      confidence: 0,
      reason: "outside_kill_zone_hard",
      killZone: kz,
      raid,
    };
  }

  let confidence = kz.active ? baseConf : outsideConf;
  if (raid.volOk === false) confidence *= 0.85;
  if (kz.active) confidence = Math.min(1, confidence + 0.1);

  _abl("passed");
  return {
    signal: raid.direction,
    confidence: Math.min(1, confidence),
    reason: `ict_${raid.reason}_${kz.active ? kz.zone : "off_kz"}`,
    killZone: kz,
    raid,
    winningComponent: "ICT_STYLE_TRADING",
    strategyLabel: "ICT-style trading",
  };
}

module.exports = {
  KILL_ZONES,
  DEFAULTS,
  isKillZone,
  detectLiquidityRaid,
  evaluateIctStyleEntry,
};
