/**
 * Auction Market Theory (VWAP + Value Area) for Trend Surge (TS-SUB-02).
 *
 * - Session VWAP: UTC-day for Intraday/≤1h bars; UTC-week for Swing/≥4h bars
 *   (4h has ≤6 bars per UTC-day — a day session + minSessionBars=20 is unreachable).
 * - Volume Profile: 20-bin histogram → POC + Value Area (70% volume).
 *
 * Sprint 12 architecture decision: race participant (independent signal
 * generator via VWAP reclaim / VA edge bounce). Race entries now require
 * closed-candle acceptance, prior-volume participation and optional HTF
 * alignment; VA levels are frozen at the previous completed candle. Precision
 * helpers remain for `tsCombinationMode: "gate"` rollback / A-B comparison.
 */

"use strict";

const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;
const MS_4H = 4 * 3_600_000;
const {
  applyNoTradeSessionFilter,
  scalpingSessionBlocked,
} = require("../../risk-engine/entryRiskGates");

/** Sprint 23: AMT / Volume Profile Scalping session filter (Asia block). */
function applyAmtSessionFilter(timestamp, opts = {}) {
  return applyNoTradeSessionFilter(timestamp, opts);
}

const DEFAULTS = {
  bins: 20,
  valueAreaPct: 0.7,
  // Spec TS-SUB-02: abs(price - VWAP) <= vwapAtrMult × ATR(14).
  // 0.5×ATR (was wrongly implemented as 0.25% of price) — 0.3 was too tight on 5m crypto.
  vwapAtrMult: 0.5,
  vwapTolerancePct: 0.005, // fallback when ATR unavailable (~0.5%)
  minSessionBars: 20, // Intraday UTC-day floor
  minSessionBarsSwing: 6, // Swing UTC-week floor (~1 day of 4h bars)

  // AMT race-entry quality gates. A VWAP touch by itself is not acceptance;
  // the closed candle must show directional follow-through and participation.
  // These remain configurable because the valid volume/body scale differs by
  // trade type, while the safe defaults apply to direct strategy callers too.
  amtEntryQualityGate: true,
  amtHtfAlignGate: true,
  amtMinBodyAtr: 0.15,
  amtMinVolumeRatio: 0.8,
  amtMinVwapDistanceAtr: 0.1,
  amtEdgeAtrMult: 0.25,
  // A VA edge is only a rejection after price actually trades through the
  // level. The previous `level ± tolerance` test treated a near miss as a
  // touch, which inflated weak VAL/VAH signals in compressed ranges.
  amtEdgePenetrationAtr: 0,
  // VAH fades are disabled by the AMT production preset until a failed-auction
  // detector is present. Keep the evaluator opt-in for A/B and research runs.
  amtVahRejectEnabled: true,
};

const AMT_PRESET_KEYS = [
  "bins",
  "valueAreaPct",
  "vwapAtrMult",
  "vwapTolerancePct",
  "minSessionBars",
  "minSessionBarsSwing",
  "amtEntryQualityGate",
  "amtHtfAlignGate",
  "amtMinBodyAtr",
  "amtMinVolumeRatio",
  "amtMinVwapDistanceAtr",
  "amtEdgeAtrMult",
  "amtEdgePenetrationAtr",
  "amtVahRejectEnabled",
];

const AMT_TIER_KEYS = [
  "minSessionBars",
  "minSessionBarsSwing",
  "amtSessionFilter",
  "amtEntryQualityGate",
  "amtHtfAlignGate",
  "amtMinBodyAtr",
  "amtMinVolumeRatio",
  "amtMinVwapDistanceAtr",
  "amtEdgeAtrMult",
  "amtEdgePenetrationAtr",
  "amtVahRejectEnabled",
];

function pickKeys(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key)) result[key] = source[key];
  }
  return result;
}

/**
 * The live Trend Surge umbrella supplies its parent TS config, while the
 * isolated AMT backtest supplies the AMT component config. Load the component
 * preset lazily so both callers share the same AMT defaults without creating a
 * module-level config cycle.
 */
function resolveAmtPreset(tier) {
  try {
    const { STRATEGIES } = require("../../../config/strategyDefaults");
    const preset = STRATEGIES?.AUCTION_MARKET_THEORY;
    return {
      base: pickKeys(preset, AMT_PRESET_KEYS),
      tier: pickKeys(preset?.typeOverrides?.[tier], AMT_TIER_KEYS),
    };
  } catch {
    return { base: {}, tier: {} };
  }
}

function inferBarMs(timestamps, lastIdx) {
  if (!Array.isArray(timestamps) || lastIdx < 1) return null;
  for (let i = lastIdx; i >= 1; i--) {
    const a = timestamps[i];
    const b = timestamps[i - 1];
    if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && a > b) {
      return a - b;
    }
  }
  return null;
}

function utcWeekStartMs(ts) {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sun … 6=Sat
  const daysFromMonday = (day + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysFromMonday);
}

/**
 * Resolve session period + min bars for AMT.
 * Swing / ≥4h → UTC week + lower bar floor; otherwise UTC day + 20.
 */
function resolveSessionParams(config = {}, timestamps = null, lastIdx = -1) {
  const tip = String(
    config.tradeType || config.entryTf || config.interval || config.sessionMode || ""
  ).toLowerCase();
  const barMs = inferBarMs(timestamps, lastIdx);
  const isSwing = tip === "swing" || tip === "4h" || tip === "1d" || tip === "utc_week"
    || tip === "week"
    || (barMs != null && barMs >= MS_4H);

  const periodMs = isSwing ? MS_WEEK : MS_DAY;
  const defaultMin = isSwing
    ? (config.minSessionBarsSwing ?? DEFAULTS.minSessionBarsSwing)
    : DEFAULTS.minSessionBars;
  // Explicit minSessionBars always wins (tests / FE overrides).
  const minSessionBars = config.minSessionBars != null ? config.minSessionBars : defaultMin;
  return {
    periodMs,
    minSessionBars,
    sessionMode: isSwing ? "utc_week" : "utc_day",
    isSwing,
  };
}

/**
 * Find start index of the session containing lastIdx (UTC day or UTC week).
 */
function sessionStartIdx(timestamps, lastIdx, periodMs = MS_DAY) {
  if (!Array.isArray(timestamps) || lastIdx < 0) return 0;
  const ts = timestamps[lastIdx];
  if (ts == null || !Number.isFinite(ts)) return 0;

  const periodStart = periodMs >= MS_WEEK
    ? utcWeekStartMs(ts)
    : Math.floor(ts / periodMs) * periodMs;

  for (let i = lastIdx; i >= 0; i--) {
    const t = timestamps[i];
    if (t == null || !Number.isFinite(t) || t < periodStart) {
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
function calculateSessionVwap(highs, lows, closes, volumes, timestamps, lastIdx, periodMs = MS_DAY) {
  const start = sessionStartIdx(timestamps, lastIdx, periodMs);
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

/** Resolve the leg used to select AMT-specific quality overrides. */
function resolveAmtTradeTier(config = {}) {
  if (config.tradeType) return String(config.tradeType);
  if (Array.isArray(config.activeComponents) && config.activeComponents.length === 1) {
    return String(config.activeComponents[0]);
  }
  if (Array.isArray(config.enabledComponents) && config.enabledComponents.length === 1) {
    return String(config.enabledComponents[0]);
  }

  // Live Trend Surge calls normally carry the entry interval, not a backtest
  // tradeType. Resolve the same leg preset from that timeframe so live AMT
  // quality gates match the isolated Scalping/Intraday/Swing backtests.
  const timeframe = String(config.entryTf || config.interval || config.entryTimeframe || "").toLowerCase();
  if (["1m", "3m", "5m"].includes(timeframe)) return "Scalping";
  if (["15m", "30m", "1h", "2h"].includes(timeframe)) return "Intraday";
  if (["4h", "6h", "8h", "12h", "1d", "3d", "1w"].includes(timeframe)) return "Swing";

  return null;
}

/**
 * Resolve AMT config with per-leg overrides. Backtest typeConfig already
 * flattens these fields, but live callers commonly keep them under
 * typeOverrides, so both paths must produce the same decision.
 */
function resolveAmtConfig(config = {}) {
  const tier = resolveAmtTradeTier(config);
  const preset = resolveAmtPreset(tier);
  const tierOverride = tier && config.typeOverrides?.[tier]
    && typeof config.typeOverrides[tier] === "object"
    ? config.typeOverrides[tier]
    : {};
  return {
    ...DEFAULTS,
    ...preset.base,
    ...preset.tier,
    ...(config.volumeProfile && typeof config.volumeProfile === "object" ? config.volumeProfile : {}),
    ...config,
    ...tierOverride,
    amtTradeTier: tier,
  };
}

function isCounterHtfTrend(signal, htfTrend) {
  const trend = String(htfTrend || "").toUpperCase();
  if (trend === "" || trend === "SIDEWAYS" || trend === "UNKNOWN") return false;
  return (signal === "LONG" && trend === "BEARISH")
    || (signal === "SHORT" && trend === "BULLISH");
}

/**
 * Use the previous completed candle's volume SMA so the denominator does not
 * contain the entry candle itself. If the caller did not precompute volSMA,
 * derive the same 20-bar prior average locally.
 */
function resolvePriorVolumeRatio(indicators, volumes, lastIdx, lookback = 20) {
  const volume = volumes?.[lastIdx];
  if (volume == null || !Number.isFinite(volume) || volume <= 0) return null;

  const previousSma = indicators?.volSMA?.[lastIdx - 1];
  if (previousSma != null && Number.isFinite(previousSma) && previousSma > 0) {
    return volume / previousSma;
  }

  const end = lastIdx - 1;
  const start = Math.max(0, end - lookback + 1);
  const prior = volumes
    .slice(start, end + 1)
    .filter((v) => v != null && Number.isFinite(v) && v > 0);
  if (!prior.length) return null;
  const average = prior.reduce((sum, v) => sum + v, 0) / prior.length;
  return average > 0 ? volume / average : null;
}

function resolveEntryCandleQuality(indicators, lastIdx, signal, vwap, cfg) {
  const closes = indicators?.closes || [];
  const opens = indicators?.opens || [];
  const volumes = indicators?.volumes || [];
  const price = closes[lastIdx];
  const prev = closes[lastIdx - 1];
  const open = opens[lastIdx] != null && Number.isFinite(opens[lastIdx])
    ? opens[lastIdx]
    : prev;
  const atr = indicators?.atr?.[lastIdx];
  const body = price != null && open != null ? Math.abs(price - open) : null;
  const bodyAtr = body != null && Number.isFinite(atr) && atr > 0 ? body / atr : null;
  const volumeRatio = resolvePriorVolumeRatio(indicators, volumes, lastIdx);
  const trend = String(cfg.htfTrend || "").toUpperCase();
  const counterHtfTrend = isCounterHtfTrend(signal, trend);

  const candleDirection = signal === "LONG"
    ? price != null && open != null && price > open && price > prev
    : price != null && open != null && price < open && price < prev;
  const minBodyAtr = Number(cfg.amtMinBodyAtr);
  const minVolumeRatio = Number(cfg.amtMinVolumeRatio);
  const minVwapDistanceAtr = Number(cfg.amtMinVwapDistanceAtr);
  const vwapDistanceAtr = price != null && vwap != null && Number.isFinite(atr) && atr > 0
    ? (signal === "LONG" ? price - vwap : vwap - price) / atr
    : null;

  let rejection = null;
  if (cfg.amtHtfAlignGate !== false && counterHtfTrend) {
    rejection = "amt_htf_counter_trend";
  } else if (cfg.amtEntryQualityGate !== false) {
    // Missing quality inputs fail closed. Production backtest/live indicator
    // snapshots always contain OHLCV, ATR and prior volume SMA; direct callers
    // must opt out explicitly if they intentionally omit these fields.
    if (!candleDirection) rejection = "amt_candle_confirmation";
    else if (minBodyAtr > 0 && (bodyAtr == null || bodyAtr < minBodyAtr)) {
      rejection = "amt_body_too_small";
    } else if (minVolumeRatio > 0 && (volumeRatio == null || volumeRatio < minVolumeRatio)) {
      rejection = "amt_volume_confirmation";
    } else if (
      minVwapDistanceAtr > 0
      && (vwapDistanceAtr == null || vwapDistanceAtr < minVwapDistanceAtr)
    ) {
      rejection = "amt_vwap_acceptance_distance";
    }
  }

  return {
    allowed: rejection == null,
    rejection,
    open,
    body,
    bodyAtr,
    volumeRatio,
    candleDirection,
    htfTrend: trend || null,
    htfCounterTrend: counterHtfTrend,
    vwapDistanceAtr,
    minBodyAtr: Number.isFinite(minBodyAtr) ? minBodyAtr : 0,
    minVolumeRatio: Number.isFinite(minVolumeRatio) ? minVolumeRatio : 0,
    minVwapDistanceAtr: Number.isFinite(minVwapDistanceAtr) ? minVwapDistanceAtr : 0,
  };
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
  const session = resolveSessionParams(cfg, timestamps, lastIdx);

  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx, session.periodMs
  );

  if (bars < session.minSessionBars || vwap == null) {
    // Early session: do not block entries (insufficient VWAP/profile data).
    return {
      allowed: true,
      vote: "NEUTRAL",
      confidence: 0,
      reason: "session_warmup_passthrough",
      meta: { bars, vwap, startIdx, sessionMode: session.sessionMode },
    };
  }

  // Freeze VAH/VAL/POC at the previous completed candle. Including the entry
  // candle in its own profile makes an extreme expand the range that is then
  // used to declare that same candle a "bounce" or "rejection".
  const profileIdx = lastIdx - 1;
  const profile = buildVolumeProfile(
    highs, lows, closes, volumes, startIdx, profileIdx, cfg.bins, cfg.valueAreaPct
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
  const session = resolveSessionParams(cfg, timestamps, lastIdx);
  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx, session.periodMs
  );
  if (vwap == null || bars < session.minSessionBars) {
    return {
      vote: "NEUTRAL",
      confidence: 0,
      reason: "session_warmup",
      meta: { bars, vwap, sessionMode: session.sessionMode },
    };
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
function hasUsableSessionTimestamps(timestamps, lastIdx) {
  if (!Array.isArray(timestamps) || lastIdx < 0) return false;
  const ts = timestamps[lastIdx];
  return ts != null && Number.isFinite(ts) && ts > 0;
}

function evaluateVolumeProfileEntry(indicators, lastIdx, config = {}) {
  const cfg = resolveAmtConfig(config);
  const ablation = config.ablation || null;
  const _abl = (k) => { if (ablation && Object.prototype.hasOwnProperty.call(ablation, k)) ablation[k] += 1; };
  _abl("evaluated");

  if (scalpingSessionBlocked(cfg, indicators, lastIdx, "amtSessionFilter", applyAmtSessionFilter, ablation)) {
    return { vote: "NEUTRAL", signal: null, confidence: 0, reason: "amt_session_block", meta: {} };
  }

  const highs = indicators.highs || [];
  const lows = indicators.lows || [];
  const closes = indicators.closes || [];
  const opens = indicators.opens || [];
  const volumes = indicators.volumes || [];
  const timestamps = indicators.timestamps || indicators.times || indicators.openTimes || null;

  if (!Number.isInteger(lastIdx) || lastIdx < 1) {
    _abl("rejWarmup");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "session_warmup",
      meta: {},
    };
  }

  // Fail closed: without bar timestamps, sessionStartIdx falls back to 0 and treats
  // the entire history as one "session" — not a real AMT auction window.
  if (!hasUsableSessionTimestamps(timestamps, lastIdx)) {
    _abl("rejSession");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "session_timestamps_missing",
      meta: { bars: 0, vwap: null, startIdx: 0 },
    };
  }

  const session = resolveSessionParams(cfg, timestamps, lastIdx);
  const { vwap, bars, startIdx } = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx, session.periodMs
  );
  const previousSession = calculateSessionVwap(
    highs, lows, closes, volumes, timestamps, lastIdx - 1, session.periodMs
  );
  if (bars < session.minSessionBars || vwap == null) {
    _abl("rejVwapBars");
    return {
      vote: "NEUTRAL",
      signal: null,
      confidence: 0,
      reason: "session_warmup",
      meta: {
        bars,
        vwap,
        startIdx,
        sessionMode: session.sessionMode,
        minSessionBars: session.minSessionBars,
      },
    };
  }

  // Freeze VAH/VAL/POC at the previous completed candle. Including the entry
  // candle in its own profile makes an extreme expand the range that is then
  // used to declare that same candle a "bounce" or "rejection".
  const profileIdx = lastIdx - 1;
  const profile = buildVolumeProfile(
    highs, lows, closes, volumes, startIdx, profileIdx, cfg.bins, cfg.valueAreaPct
  );
  const price = closes[lastIdx];
  const prev = closes[lastIdx - 1];
  const open = opens[lastIdx];
  const barLow = lows[lastIdx];
  const barHigh = highs[lastIdx];
  if (price == null || prev == null || !Number.isFinite(price) || !Number.isFinite(prev)) {
    _abl("rejProfile");
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
    prevVwap: previousSession.vwap,
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
    sessionMode: session.sessionMode,
    minSessionBars: session.minSessionBars,
    amtTradeTier: cfg.amtTradeTier,
    profileIdx,
  };

  // VWAP reclaim / lose (primary AMT entry). Compare the previous close with
  // the previous completed VWAP, not with the VWAP after the current candle's
  // volume has been added. The old comparison made a moving-level mismatch
  // look like a cross and was the main source of one-candle churn.
  const vwapReclaim = previousSession.vwap != null
    && prev < previousSession.vwap
    && price >= vwap;
  const vwapLose = previousSession.vwap != null
    && prev > previousSession.vwap
    && price <= vwap;

  const evaluateCandidate = (signal, reason, { requireVwapDistance = true } = {}) => {
    const quality = resolveEntryCandleQuality(indicators, lastIdx, signal, vwap, {
      ...cfg,
      amtMinVwapDistanceAtr: requireVwapDistance ? cfg.amtMinVwapDistanceAtr : 0,
    });
    const candidateMeta = {
      ...metaBase,
      ...quality,
      triggerType: reason,
    };
    if (!quality.allowed) {
      if (quality.rejection === "amt_htf_counter_trend") _abl("rejHtf");
      else _abl("rejQuality");
      return {
        vote: "NEUTRAL",
        signal: null,
        confidence: 0,
        reason: quality.rejection,
        meta: candidateMeta,
      };
    }
    _abl("passed");
    return {
      vote: signal,
      signal,
      confidence: reason.startsWith("vwap_") ? 0.72 : 0.68,
      reason,
      meta: candidateMeta,
    };
  };

  if (vwapReclaim) return evaluateCandidate("LONG", "vwap_reclaim");
  if (vwapLose) return evaluateCandidate("SHORT", "vwap_lose");

  // Value Area edge bounce / rejection
  const val = profile.val;
  const vah = profile.vah;
  const edgeAtrMult = Number(cfg.amtEdgeAtrMult);
  const edgePenetrationAtr = Number(cfg.amtEdgePenetrationAtr);
  const edgeTol = atr != null && Number.isFinite(atr) && atr > 0 && edgeAtrMult > 0
    ? atr * edgeAtrMult
    : Math.abs(vwap) * cfg.vwapTolerancePct;
  const edgePenetration = atr != null && Number.isFinite(atr) && atr > 0 && edgePenetrationAtr > 0
    ? atr * edgePenetrationAtr
    : 0;

  if (val != null && Number.isFinite(val) && barLow != null) {
    // `edgeTol` is for close/acceptance proximity; it must not make a bar
    // that stopped above VAL count as a VAL sweep.
    const touchedVal = barLow <= val - edgePenetration;
    const closedAbove = price > val && (open == null || price >= open || price > prev);
    if (touchedVal && closedAbove && price >= vwap - edgeTol) {
      const result = evaluateCandidate("LONG", "val_bounce", { requireVwapDistance: false });
      return {
        ...result,
        meta: { ...result.meta, edgeTol, edgePenetration },
      };
    }
  }

  if (cfg.amtVahRejectEnabled === false) {
    if (vah != null && Number.isFinite(vah) && barHigh != null) _abl("rejVahDisabled");
  } else if (vah != null && Number.isFinite(vah) && barHigh != null) {
    const touchedVah = barHigh >= vah + edgePenetration;
    const closedBelow = price < vah && (open == null || price <= open || price < prev);
    if (touchedVah && closedBelow && price <= vwap + edgeTol) {
      const result = evaluateCandidate("SHORT", "vah_reject", { requireVwapDistance: false });
      return {
        ...result,
        meta: { ...result.meta, edgeTol, edgePenetration },
      };
    }
  }

  // Single terminal "no trigger" exit: neither VWAP reclaim/lose nor VAL/VAH
  // edge fired. Attributed to the final gate stage (rejValVahReject); rejVwap has
  // no dedicated early exit because a VWAP non-trigger falls through to this stage.
  _abl("rejValVahReject");
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
  MS_DAY,
  MS_WEEK,
  sessionStartIdx,
  calculateSessionVwap,
  buildVolumeProfile,
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileComponent,
  evaluateVolumeProfileEntry,
  resolveVwapTolerance,
  resolveSessionParams,
  hasUsableSessionTimestamps,
  utcWeekStartMs,
};
