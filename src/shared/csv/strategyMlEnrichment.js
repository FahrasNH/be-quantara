/**
 * strategyMlEnrichment.js — Sprint 15 per-strategy ML field extractors.
 *
 * Flattens getLastSignalMeta() / nested component meta into trade.* columns
 * used by Dynamic ML multi-sheet export (ML_FIELD_SETS keys).
 */

"use strict";

function _num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function _bool(v) {
  if (v == null) return null;
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return Boolean(v);
}

/** TS_TF — 6 fields */
function extractTsTfEnrichment(meta) {
  if (!meta) return {};
  const checklist = meta.entryChecklist || {};
  return {
    tfAdxStrength: _num(meta.tfAdxStrength ?? meta.adxStrength),
    tfDonchianPeriod: _num(meta.tfDonchianPeriod ?? meta.donchianPeriod ?? checklist.donchianPeriod),
    tfBarsInTrend: _num(meta.tfBarsInTrend ?? meta.barsInTrend),
    tfVolRatio: _num(meta.tfVolRatio ?? checklist.volRatio ?? meta.volRatio),
    tfHtfTrendConfirmed: _bool(meta.tfHtfTrendConfirmed ?? meta.htfTrendConfirmed),
    tfEmaCrossover: _bool(
      meta.tfEmaCrossover ?? checklist.ema9Retest ?? meta.emaCrossover ?? meta.ema9Retest
    ),
  };
}

/** TS_MS — 6 fields */
function extractTsMsEnrichment(meta) {
  if (!meta) return {};
  const nested = meta.meta && typeof meta.meta === "object" ? meta.meta : {};
  const lastSH = nested.lastSwingHigh || meta.lastSwingHigh;
  const lastSL = nested.lastSwingLow || meta.lastSwingLow;
  const atr = _num(meta.atr ?? nested.atr);
  const dist = _num(meta.msPullbackDepthAtr ?? nested.dist ?? meta.dist);
  const pullbackDepthAtr = dist != null && atr != null && atr > 0
    ? dist / atr
    : _num(meta.msPullbackDepthAtr ?? nested.pullbackDepthAtr);
  const hh = nested.hh ?? meta.hh;
  const ll = nested.ll ?? meta.ll;
  const reason = String(meta.reason || nested.reason || "");
  return {
    msSwingHighPrice: _num(meta.msSwingHighPrice ?? lastSH?.price ?? lastSH),
    msSwingLowPrice: _num(meta.msSwingLowPrice ?? lastSL?.price ?? lastSL),
    msPullbackDepthAtr: pullbackDepthAtr,
    msHhPattern: _bool(meta.msHhPattern ?? (hh != null ? hh >= 1 : null) ?? nested.structure === "uptrend"),
    msLlPattern: _bool(meta.msLlPattern ?? (ll != null ? ll >= 1 : null) ?? nested.structure === "downtrend"),
    msPullbackConfirmed: _bool(
      meta.msPullbackConfirmed
      ?? (reason.includes("pullback") || reason.includes("bounce") || reason.includes("reject")
        ? Boolean(meta.signal || meta.winningComponent === "TS_MS")
        : null)
    ),
  };
}

/** TS_VP — 5 fields (existing) */
function extractTsVpEnrichment(meta) {
  if (!meta) return {};
  const nested = meta.meta && typeof meta.meta === "object" ? meta.meta : {};
  const reason = meta.reason || nested.reason || null;
  return {
    vpVwapLevel: meta.vpVwapLevel ?? nested.vwap ?? null,
    vpVahLevel: meta.vpVahLevel ?? nested.vah ?? null,
    vpValLevel: meta.vpValLevel ?? nested.val ?? null,
    vpPocLevel: meta.vpPocLevel ?? nested.poc ?? null,
    vpTriggerType: meta.vpTriggerType
      ?? (reason ? String(reason).toUpperCase() : null),
  };
}

/** MD_MR — 7 fields */
function extractMdMrEnrichment(meta) {
  if (!meta) return {};
  const bb = meta._lastBBLevels || meta.bbLevels || {};
  const bbA = bb.bbA || meta.bbA || {};
  return {
    mrRsiValue: _num(meta.mrRsiValue ?? meta.rsiValue ?? meta.rsi),
    mrBbMidLevel: _num(meta.mrBbMidLevel ?? bbA.middle ?? meta.bbMid),
    mrBbUpperLevel: _num(meta.mrBbUpperLevel ?? bbA.upper ?? meta.bbUpper),
    mrBbLowerLevel: _num(meta.mrBbLowerLevel ?? bbA.lower ?? meta.bbLower),
    mrVwapLevel: _num(meta.mrVwapLevel ?? bb.vwap ?? meta.vwap),
    mrVwapDeviation: _num(meta.mrVwapDeviation ?? meta.vwapDeviation),
    mrAdxRegime: meta.mrAdxRegime ?? meta.adxRegime ?? null,
  };
}

/** MD_SD — 7 fields */
function extractMdSdEnrichment(meta) {
  if (!meta) return {};
  const zone = meta.nearestZone || {};
  const zoneTypeRaw = meta.sdZoneType ?? meta.zoneType;
  let zoneType = zoneTypeRaw || null;
  if (zoneType && String(zoneType).includes("demand")) zoneType = "DEMAND";
  else if (zoneType && String(zoneType).includes("supply")) zoneType = "SUPPLY";
  else if (zoneType) zoneType = String(zoneType).toUpperCase();

  const low = _num(zone.low ?? zone.bottom);
  const high = _num(zone.high ?? zone.top);
  const mid = low != null && high != null ? (low + high) / 2 : _num(zone.level);
  const atr = _num(meta.atr);
  const sizeAtr = meta.sdZoneSizeAtr != null
    ? _num(meta.sdZoneSizeAtr)
    : (low != null && high != null && atr > 0 ? (high - low) / atr : null);
  const retestDepth = meta.sdRetestDepthAtr != null
    ? _num(meta.sdRetestDepthAtr)
    : (mid != null && atr > 0 && meta.price != null
      ? Math.abs(_num(meta.price) - mid) / atr
      : null);

  return {
    sdZoneType: zoneType,
    sdZoneLevel: _num(meta.sdZoneLevel ?? mid),
    sdZoneSizeAtr: sizeAtr,
    sdRetestDepthAtr: retestDepth,
    sdVolumeConfirmation: _bool(meta.sdVolumeConfirmation ?? meta.hasVolConfirm),
    sdTimeToRetestBars: _num(meta.sdTimeToRetestBars ?? zone.barsSince ?? zone.ageBars),
    sdConfluence: _bool(
      meta.sdConfluence
      ?? (zone.zoneKind && (String(zone.zoneKind).includes("ob") || String(zone.zoneKind).includes("fvg"))
        ? true
        : meta.hasObFvgConfluence)
    ),
  };
}

/** MD_SA — 7 fields */
function extractMdSaEnrichment(meta) {
  if (!meta) return {};
  const z = _num(meta.saZScore ?? meta.zScore);
  const mean = _num(meta.saMaValue ?? meta.mean ?? meta.ma);
  const std = _num(meta.saStdDev ?? meta.std ?? meta.stdDev);
  const upper = _num(meta.saUpperBand ?? meta.upperBand ?? (mean != null && std != null ? mean + 2 * std : null));
  const lower = _num(meta.saLowerBand ?? meta.lowerBand ?? (mean != null && std != null ? mean - 2 * std : null));
  let bandTouch = meta.saBandTouch ?? meta.bandTouch ?? null;
  if (!bandTouch && z != null) {
    if (z >= 2) bandTouch = "UPPER";
    else if (z <= -2) bandTouch = "LOWER";
    else bandTouch = "NONE";
  }
  return {
    saZScore: z,
    saMaValue: mean,
    saStdDev: std,
    saUpperBand: upper,
    saLowerBand: lower,
    saBandTouch: bandTouch,
    saMeanRevertBars: _num(meta.saMeanRevertBars ?? meta.meanRevertBars),
  };
}

/** BS_ICT — 7 fields */
function extractBsIctEnrichment(meta) {
  if (!meta) return {};
  const kz = meta.killZone || {};
  const raid = meta.raid || {};
  const reason = String(meta.reason || raid.reason || "");
  let raidType = meta.ictRaidType ?? null;
  if (!raidType) {
    if (reason.includes("raid_high") || raid.direction === "SHORT") raidType = "RAID_HIGH";
    else if (reason.includes("raid_low") || raid.direction === "LONG") raidType = "RAID_LOW";
    else if (raid.detected === false) raidType = "NO_RAID";
  }
  const atr = _num(meta.atr);
  const level = _num(meta.ictKillZoneLevel ?? raid.level);
  const price = _num(meta.price);
  const raidDepth = meta.ictRaidDepthAtr != null
    ? _num(meta.ictRaidDepthAtr)
    : (level != null && price != null && atr > 0 ? Math.abs(price - level) / atr : null);

  return {
    ictKillZoneHour: _num(meta.ictKillZoneHour ?? kz.hourUtc ?? (kz.minuteOfDay != null ? Math.floor(kz.minuteOfDay / 60) : null)),
    ictKillZoneLevel: level,
    ictRaidType: raidType,
    ictRaidDepthAtr: raidDepth,
    ictVolumeRatio: _num(meta.ictVolumeRatio ?? meta.volumeRatio ?? raid.volumeRatio),
    ictReversal: _bool(
      meta.ictReversal ?? (reason.includes("reversal") || Boolean(raid.detected && meta.winningComponent === "BS_ICT"))
    ),
    ictMssPct: _num(meta.ictMssPct ?? meta.mssPct),
  };
}

/** BS_LS — 7 fields */
function extractBsLsEnrichment(meta) {
  if (!meta) return {};
  const wick = meta.wick || {};
  return {
    lsOiValue: _num(meta.lsOiValue ?? meta.oiValue ?? meta.oi),
    lsOiPercentile: _num(meta.lsOiPercentile ?? meta.oiPercentile),
    lsBbWidth: _num(meta.lsBbWidth ?? meta.bbWidth),
    lsBbWidthPercentile: _num(meta.lsBbWidthPercentile ?? meta.bbWidthPercentile),
    lsLiquidationLevel: _num(meta.lsLiquidationLevel ?? wick.level ?? meta.liquidationLevel),
    lsWickDepthAtr: _num(meta.lsWickDepthAtr ?? wick.depthAtr ?? wick.wickAtr ?? meta.wickDepthAtr),
    lsOiForecast24h: _num(meta.lsOiForecast24h ?? meta.oiForecast24h ?? meta.oiChange),
  };
}

/** AF_VSA — 7 fields */
function extractAfVsaEnrichment(meta) {
  if (!meta) return {};
  const nested = meta.meta && typeof meta.meta === "object" ? meta.meta : {};
  const spreadType = nested.spreadType || meta.spreadType || {};
  const reason = String(meta.reason || nested.reason || "");
  let patternType = meta.vsaPatternType ?? null;
  if (!patternType && reason) {
    if (reason.includes("stopping_volume")) patternType = "STOPPING_VOLUME";
    else if (reason.includes("no_demand")) patternType = "NO_DEMAND";
    else if (reason.includes("no_supply")) patternType = "NO_SUPPLY";
  }
  const nearSwing = nested.nearSwing || meta.nearSwing || {};
  return {
    vsaPatternType: patternType,
    vsaSpread: _num(meta.vsaSpread ?? spreadType.spread ?? nested.spread),
    vsaVolume: _num(meta.vsaVolume ?? nested.volume ?? meta.volume),
    vsaAvgSpread: _num(meta.vsaAvgSpread ?? nested.avgSpread ?? spreadType.avgSpread),
    vsaAvgVolume: _num(meta.vsaAvgVolume ?? nested.avgVolume ?? nested.volSMA),
    vsaSwingProximity: _num(
      meta.vsaSwingProximity
      ?? nearSwing.distancePct
      ?? nearSwing.proximity
      ?? (nearSwing.distance != null ? nearSwing.distance : null)
    ),
    vsaReversal: _bool(
      meta.vsaReversal
      ?? (patternType === "STOPPING_VOLUME" || reason.includes("stopping_volume") || nested.reversal)
    ),
  };
}

/** AF_WYCKOFF — 7 fields */
function extractAfWyckoffEnrichment(meta) {
  if (!meta) return {};
  const nested = meta.meta && typeof meta.meta === "object" ? meta.meta : {};
  const range = nested.range || meta.range || {};
  const spring = nested.spring || meta.spring || {};
  const upthrust = nested.upthrust || meta.upthrust || {};
  const entry = nested.entry || meta.entry || {};
  const checklist = entry.checklist || {};
  const reason = String(meta.reason || nested.reason || "");
  let patternType = meta.wyPatternType ?? null;
  if (!patternType) {
    if (spring.detected || reason.toLowerCase().includes("spring")) patternType = "SPRING";
    else if (upthrust.detected || reason.toLowerCase().includes("upthrust") || reason.includes("utad")) {
      patternType = "UPTHRUST";
    }
  }
  const event = spring.detected ? spring : (upthrust.detected ? upthrust : null);
  const atr = _num(meta.atr ?? range.atr);
  const fakeDepth = meta.wyFakeBreakDepthAtr != null
    ? _num(meta.wyFakeBreakDepthAtr)
    : _num(event?.depthAtr ?? event?.penetrationAtr);
  const sosOrSow = meta.wySosOrSow
    ?? (checklist.sosOrSow ? (patternType === "SPRING" ? "SOS" : "SOW") : null)
    ?? (reason.includes("sos") ? "SOS" : reason.includes("sow") ? "SOW" : null);

  return {
    wyPatternType: patternType,
    wyAccumulationBars: _num(
      meta.wyAccumulationBars
      ?? range.bars
      ?? (range.rangeEndIdx != null && range.rangeStartIdx != null
        ? range.rangeEndIdx - range.rangeStartIdx
        : null)
    ),
    wyFakeBreakDepthAtr: fakeDepth,
    wyReclameBars: _num(meta.wyReclameBars ?? event?.reclaimBars ?? entry.reclaimBars),
    wyVolumeRatio: _num(meta.wyVolumeRatio ?? event?.volRatio ?? entry.volRatio ?? nested.volumeRatio),
    wySosOrSow: sosOrSow,
    wyLpsLevel: _num(meta.wyLpsLevel ?? entry.lpsLevel ?? nested.lpsLevel ?? range.rangeLow ?? range.rangeHigh),
  };
}

/**
 * Copy BS_BR ML fields onto a live trade indicator snapshot (BotEngine).
 * Mirrors extractBsBrEnrichment keys used by backtest → CSV.
 */
function applyBsBrSnapshotFields(snapshot, meta) {
  if (!snapshot || !meta) return snapshot;
  snapshot.bbSqueezeWidthAtr = meta.bbSqueezeWidthAtr ?? null;
  snapshot.breakoutVolumeRatio = meta.breakoutVolumeRatio ?? null;
  snapshot.retestDepthAtr = meta.retestDepthAtr ?? null;
  snapshot.rejectionWickPct = meta.rejectionWickPct ?? null;
  snapshot.consolidationBars = meta.consolidationBars ?? null;
  snapshot.breakoutCandleAtr = meta.breakoutCandleAtr ?? null;
  snapshot.bbWidth = meta.bbWidth ?? meta.squeezeWidthPct ?? null;
  snapshot.volumeRatio = meta.volumeRatio ?? meta.breakoutVolumeRatio
    ?? snapshot.volumeRatio ?? null;
  return snapshot;
}

/** Merge all strategy enrichments from a meta blob (winner-aware). */
function extractAllStrategyEnrichment(meta) {
  if (!meta) return {};
  const winner = String(meta.winningComponent || meta.component || "").toUpperCase();
  const out = {
    ...extractTsTfEnrichment(meta),
    ...extractTsMsEnrichment(meta),
    ...extractTsVpEnrichment(meta),
    ...extractMdMrEnrichment(meta),
    ...extractMdSdEnrichment(meta),
    ...extractMdSaEnrichment(meta),
    ...extractBsIctEnrichment(meta),
    ...extractBsLsEnrichment(meta),
    ...extractAfVsaEnrichment(meta),
    ...extractAfWyckoffEnrichment(meta),
  };
  // Prefer winner-specific keys only when we know the winner (keeps CSV sparse)
  if (!winner) return out;
  return out;
}

/** Flat list of all Sprint 15 ML enrichment keys for pass-through. */
const ALL_ML_ENRICH_KEYS = Object.freeze([
  "tfAdxStrength", "tfDonchianPeriod", "tfBarsInTrend", "tfVolRatio", "tfHtfTrendConfirmed", "tfEmaCrossover",
  "msSwingHighPrice", "msSwingLowPrice", "msPullbackDepthAtr", "msHhPattern", "msLlPattern", "msPullbackConfirmed",
  "vpVwapLevel", "vpVahLevel", "vpValLevel", "vpPocLevel", "vpTriggerType",
  "mrRsiValue", "mrBbMidLevel", "mrBbUpperLevel", "mrBbLowerLevel", "mrVwapLevel", "mrVwapDeviation", "mrAdxRegime",
  "sdZoneType", "sdZoneLevel", "sdZoneSizeAtr", "sdRetestDepthAtr", "sdVolumeConfirmation", "sdTimeToRetestBars", "sdConfluence",
  "saZScore", "saMaValue", "saStdDev", "saUpperBand", "saLowerBand", "saBandTouch", "saMeanRevertBars",
  "ictKillZoneHour", "ictKillZoneLevel", "ictRaidType", "ictRaidDepthAtr", "ictVolumeRatio", "ictReversal", "ictMssPct",
  "lsOiValue", "lsOiPercentile", "lsBbWidth", "lsBbWidthPercentile", "lsLiquidationLevel", "lsWickDepthAtr", "lsOiForecast24h",
  "vsaPatternType", "vsaSpread", "vsaVolume", "vsaAvgSpread", "vsaAvgVolume", "vsaSwingProximity", "vsaReversal",
  "wyPatternType", "wyAccumulationBars", "wyFakeBreakDepthAtr", "wyReclameBars", "wyVolumeRatio", "wySosOrSow", "wyLpsLevel",
]);

module.exports = {
  extractTsTfEnrichment,
  extractTsMsEnrichment,
  extractTsVpEnrichment,
  extractMdMrEnrichment,
  extractMdSdEnrichment,
  extractMdSaEnrichment,
  extractBsIctEnrichment,
  extractBsLsEnrichment,
  extractAfVsaEnrichment,
  extractAfWyckoffEnrichment,
  applyBsBrSnapshotFields,
  extractAllStrategyEnrichment,
  ALL_ML_ENRICH_KEYS,
};
