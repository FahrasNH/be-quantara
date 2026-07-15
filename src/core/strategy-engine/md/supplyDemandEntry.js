/**
 * Supply and Demand (SUPPLY_AND_DEMAND) — standalone race entry for MEAN_DRIFT.
 *
 * Catalog method: Supply and Demand. OB/FVG detection is an implementation
 * detail under S&D (base-rally / base-drop zones + imbalance gaps).
 *
 * Entry: price retests an unfilled demand (LONG) or supply (SHORT) zone with
 * a reversal candle confirmation. Not a refiner of MEAN_REVERSION.
 */

"use strict";

const {
  detectFairValueGaps,
  detectOrderBlocks,
  resolveMdTakeProfit,
} = require("./orderBlockFvg");

const DEFAULTS = {
  confluenceAtrMult: 0.75,
  minReversalBodyPct: 0.35, // body ≥ 35% of range = rejection candle
  volConfirmMult: 0.9, // soft volume confirm (fail-soft, not hard AND)
  scanBars: 40,
  fvgMinGapPct: 0.0015,
  obLookback: 25,
  obDispMult: 1.3,
  baseConfidence: 0.62,
  zoneBoost: 0.18,
  volBoost: 0.1,
};

function _zoneDistance(price, zoneLow, zoneHigh) {
  if (price >= zoneLow && price <= zoneHigh) return 0;
  if (price < zoneLow) return zoneLow - price;
  return price - zoneHigh;
}

function _isReversalCandle(opens, highs, lows, closes, idx, direction, minReversalBodyPct = DEFAULTS.minReversalBodyPct) {
  const o = opens?.[idx] ?? closes[idx - 1] ?? closes[idx];
  const h = highs[idx];
  const l = lows[idx];
  const c = closes[idx];
  const range = Math.max(h - l, 1e-12);
  const body = Math.abs(c - o);
  const bodyPct = body / range;
  if (bodyPct < minReversalBodyPct) return false;
  if (direction === "LONG") {
    // Bullish rejection: close in upper half, preferably green
    return c >= o && c >= l + range * 0.55;
  }
  return c <= o && c <= h - range * 0.55;
}

/**
 * Standalone Supply & Demand entry at lastIdx.
 *
 * @returns {{
 *   signal: 'LONG'|'SHORT'|null,
 *   confidence: number,
 *   reason: string,
 *   zoneType: string|null,
 *   nearestZone: object|null,
 *   takeProfit: number|null,
 *   tpSource: string|null,
 * }}
 */
function evaluateSupplyDemandEntry({
  opens,
  highs,
  lows,
  closes,
  volumes,
  volSMA,
  atr,
  lastIdx,
  config = {},
} = {}) {
  const atrMult = config.mdSdConfluenceAtrMult ?? config.confluenceAtrMult ?? DEFAULTS.confluenceAtrMult;
  const volMult = config.mdSdVolConfirmMult ?? config.volConfirmMult ?? DEFAULTS.volConfirmMult;
  const baseConf = config.mdSdBaseConfidence ?? DEFAULTS.baseConfidence;
  const zoneBoost = config.mdSdZoneBoost ?? DEFAULTS.zoneBoost;
  const volBoost = config.mdSdVolBoost ?? DEFAULTS.volBoost;
  const minReversalBodyPct = config.minReversalBodyPct ?? DEFAULTS.minReversalBodyPct;

  if (!closes || lastIdx < 30 || atr == null || !(atr > 0)) {
    return {
      signal: null,
      confidence: 0,
      reason: "warmup_or_atr_missing",
      zoneType: null,
      nearestZone: null,
      takeProfit: null,
      tpSource: null,
    };
  }

  const price = closes[lastIdx];
  const radius = atr * atrMult;
  const fvgOpts = {
    fvgScanBars: config.mdSdScanBars ?? config.mdFvgScanBars ?? DEFAULTS.scanBars,
    fvgMinGapPct: config.mdSdFvgMinGapPct ?? config.mdFvgMinGapPct ?? DEFAULTS.fvgMinGapPct,
  };
  const obOpts = {
    obLookback: config.mdSdObLookback ?? config.mdObLookback ?? DEFAULTS.obLookback,
    obDispMult: config.mdSdObDispMult ?? config.mdObDispMult ?? DEFAULTS.obDispMult,
  };

  const fvgs = detectFairValueGaps(highs, lows, closes, lastIdx, fvgOpts);
  const orderBlocks = detectOrderBlocks(opens, highs, lows, closes, volumes, volSMA, lastIdx, obOpts);

  // Demand = bullish OB + unfilled bullish FVG; Supply = bearish mirrors
  const demandZones = [
    ...orderBlocks.bullish.map((z) => ({ ...z, zoneKind: "demand_ob", low: z.low, high: z.high })),
    ...fvgs.bullish.filter((f) => !f.filled).map((z) => ({
      ...z,
      zoneKind: "demand_fvg",
      low: z.bottom,
      high: z.top,
    })),
  ];
  const supplyZones = [
    ...orderBlocks.bearish.map((z) => ({ ...z, zoneKind: "supply_ob", low: z.low, high: z.high })),
    ...fvgs.bearish.filter((f) => !f.filled).map((z) => ({
      ...z,
      zoneKind: "supply_fvg",
      low: z.bottom,
      high: z.top,
    })),
  ];

  function nearestIn(list) {
    let best = null;
    let bestDist = Infinity;
    for (const z of list) {
      const d = _zoneDistance(price, z.low, z.high);
      if (d < bestDist) {
        bestDist = d;
        best = z;
      }
    }
    return { zone: best, dist: bestDist };
  }

  const demand = nearestIn(demandZones);
  const supply = nearestIn(supplyZones);

  const volNow = volumes?.[lastIdx] ?? 0;
  const vsma = Array.isArray(volSMA) ? volSMA[lastIdx] : volSMA;
  const volOk = !(vsma > 0) || volNow >= vsma * volMult;

  let signal = null;
  let nearestZone = null;
  let zoneType = null;
  let conf = baseConf;

  const longOk =
    demand.zone &&
    demand.dist <= radius &&
    _isReversalCandle(opens, highs, lows, closes, lastIdx, "LONG", minReversalBodyPct);
  const shortOk =
    supply.zone &&
    supply.dist <= radius &&
    _isReversalCandle(opens, highs, lows, closes, lastIdx, "SHORT", minReversalBodyPct);

  // Prefer closer zone when both fire (rare)
  if (longOk && shortOk) {
    if (demand.dist <= supply.dist) {
      signal = "LONG";
      nearestZone = demand.zone;
      zoneType = demand.zone.zoneKind;
    } else {
      signal = "SHORT";
      nearestZone = supply.zone;
      zoneType = supply.zone.zoneKind;
    }
  } else if (longOk) {
    signal = "LONG";
    nearestZone = demand.zone;
    zoneType = demand.zone.zoneKind;
  } else if (shortOk) {
    signal = "SHORT";
    nearestZone = supply.zone;
    zoneType = supply.zone.zoneKind;
  }

  if (!signal) {
    return {
      signal: null,
      confidence: 0,
      reason: "no_sd_retest",
      zoneType: null,
      nearestZone: null,
      takeProfit: null,
      tpSource: null,
      fvgs,
      orderBlocks,
    };
  }

  conf += zoneBoost;
  if (volOk) conf += volBoost;
  conf = Math.min(1, conf);

  const tp = resolveMdTakeProfit({
    signal,
    entryPrice: price,
    fvgs,
    bbMiddle: null,
  });

  return {
    signal,
    confidence: conf,
    reason: `sd_retest_${zoneType}_${signal.toLowerCase()}${volOk ? "_vol_ok" : "_vol_soft"}`,
    zoneType,
    nearestZone,
    takeProfit: tp.takeProfit,
    tpSource: tp.source,
    fvgs,
    orderBlocks,
    hasVolConfirm: volOk,
  };
}

module.exports = {
  DEFAULTS,
  evaluateSupplyDemandEntry,
};
