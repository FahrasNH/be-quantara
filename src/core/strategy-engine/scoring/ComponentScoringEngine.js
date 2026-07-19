"use strict";

/**
 * ComponentScoringEngine.js — Sprint 16 EPIC
 *
 * Unified 0-100 graded, explainable component scoring for all 12 live strategies.
 * Rubric weights from Notion EPIC (initial calibration; evidence-weighted tuning via SSOT).
 *
 * Interface: scoreComponent(strategyKey, features) → { total, breakdown }
 */

const { normalizeStrategyKey, normalizeTradeTypeKey } = require("../../../config/strategyKeyNormalizer");
const {
  clamp,
  linearPts,
  inverseLinearPts,
  booleanPts,
  enumPts,
  proximityPts,
  sweetSpotPts,
  finalizeBreakdown,
} = require("./scoringUtils");

const {
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
  extractSmcEnrichment,
  extractBrEnrichment,
} = require("../../../shared/csv/strategyMlEnrichment");

// ─── Per-strategy scorers (Notion rubric) ───────────────────────────────────

/** Intraday/Swing SMC graded rubric — max component caps sum to 105 (clamped to 100). */
const SMC_RUBRIC_DEFAULT = Object.freeze({
  sweepQuality: { maxPts: 25, floor: 3 },
  chochDisplacement: { maxPts: 20, floor: 2 },
  fvgQuality: { maxPts: 15, floor: 2 },
  obConfluence: { proximityMax: 15, booleanMax: 5 },
  htfAlignment: { adxMax: 10, alignMax: 5 },
  liquidityFreshness: { mitigationMax: 7, sweepAgeMax: 3 },
});

/** Scalping SMC graded rubric — de-emphasizes OB/HTF/freshness; sweep +5 vs default. */
const SMC_RUBRIC_SCALPING = Object.freeze({
  sweepQuality: { maxPts: 30, floor: 3 },
  chochDisplacement: { maxPts: 20, floor: 2 },
  fvgQuality: { maxPts: 15, floor: 2 },
  obConfluence: { proximityMax: 8, booleanMax: 2 },
  htfAlignment: { adxMax: 7, alignMax: 3 },
  liquidityFreshness: { mitigationMax: 4, sweepAgeMax: 1 },
});

function canonicalTradeType(raw) {
  if (raw == null || raw === "") return null;
  const leg = normalizeTradeTypeKey(String(raw).toUpperCase());
  return ["Scalping", "Intraday", "Swing"].find((t) => t.toUpperCase() === String(leg).toUpperCase()) ?? null;
}

function resolveSmcTradeType(f, opts = {}) {
  return canonicalTradeType(f.tradeType ?? opts.tradeType ?? f.component ?? opts.component);
}

function resolveSmcRubric(f, opts = {}) {
  return resolveSmcTradeType(f, opts) === "Scalping"
    ? SMC_RUBRIC_SCALPING
    : SMC_RUBRIC_DEFAULT;
}

function buildSmcBreakdown(f, rubric) {
  return {
    sweepQuality: sweetSpotPts(f.sweepStrength, {
      peak: 1.5, inner: 0.35, outer: 2.5,
      maxPts: rubric.sweepQuality.maxPts,
      floor: rubric.sweepQuality.floor,
    }),
    chochDisplacement: sweetSpotPts(f.displacementPct, {
      peak: 1.2, inner: 0.4, outer: 3.0,
      maxPts: rubric.chochDisplacement.maxPts,
      floor: rubric.chochDisplacement.floor,
    }),
    fvgQuality: sweetSpotPts(f.fvgSizeAtr, {
      peak: 0.7, inner: 0.3, outer: 2.0,
      maxPts: rubric.fvgQuality.maxPts,
      floor: rubric.fvgQuality.floor,
    }),
    obConfluence: proximityPts(f.obDistanceAtr, 1.5, rubric.obConfluence.proximityMax)
      + booleanPts(f.confObConfluence ?? f.obConfluence, rubric.obConfluence.booleanMax),
    htfAlignment: linearPts(f.htfAdx, 15, 35, rubric.htfAlignment.adxMax)
      + linearPts(Math.abs(f.confHtfAlignment ?? 0), 0, 15, rubric.htfAlignment.alignMax),
    liquidityFreshness: linearPts(
      f.confMitigationDepth ?? f.mitigationDepth,
      0.15,
      0.85,
      rubric.liquidityFreshness.mitigationMax,
    )
      + inverseLinearPts(
        f.sweepAgeBars ?? f.zoneAgeBars,
        5,
        60,
        rubric.liquidityFreshness.sweepAgeMax,
      ),
  };
}

function scoreSmc(f, opts = {}) {
  const rubric = resolveSmcRubric(f, opts);
  return finalizeBreakdown(buildSmcBreakdown(f, rubric));
}

function scoreIct(f) {
  const kzHour = f.ictKillZoneHour;
  let killZone = 0;
  if (kzHour != null) {
    // London 7-10, NY 12-15 UTC — peak windows
    const inLondon = kzHour >= 7 && kzHour <= 10;
    const inNy = kzHour >= 12 && kzHour <= 15;
    killZone = inLondon || inNy ? 20 : linearPts(1 - Math.min(
      Math.abs(kzHour - 8.5), Math.abs(kzHour - 13.5),
    ) / 6, 0, 1, 12);
  }
  const breakdown = {
    killZoneTiming: killZone,
    liquidityRaidDepth: sweetSpotPts(f.ictRaidDepthAtr, {
      peak: 0.6, inner: 0.2, outer: 1.8, maxPts: 20, floor: 3,
    }),
    mssStrength: linearPts(Math.abs(f.ictMssPct ?? 0), 0.15, 1.0, 20),
    volumeConfirmation: linearPts(f.ictVolumeRatio, 1.0, 2.5, 15),
    reversalQuality: booleanPts(f.ictReversal, 15),
    displacement: sweetSpotPts(f.ictRaidDepthAtr, {
      peak: 0.5, inner: 0.15, outer: 1.2, maxPts: 10, floor: 2,
    }),
  };
  return finalizeBreakdown(breakdown);
}

function scoreSupplyDemand(f) {
  const breakdown = {
    zoneFreshness: inverseLinearPts(f.sdTimeToRetestBars, 3, 80, 20),
    zoneStrength: sweetSpotPts(f.sdZoneSizeAtr, {
      peak: 1.0, inner: 0.3, outer: 2.5, maxPts: 20, floor: 4,
    }),
    retestDepth: sweetSpotPts(f.sdRetestDepthAtr, {
      peak: 0.35, inner: 0.1, outer: 1.2, maxPts: 15, floor: 2,
    }),
    volumeConfirmation: booleanPts(f.sdVolumeConfirmation, 15),
    confluence: booleanPts(f.sdConfluence, 15),
    zoneSizeFit: sweetSpotPts(f.sdZoneSizeAtr, {
      peak: 0.8, inner: 0.25, outer: 2.0, maxPts: 15, floor: 3,
    }),
  };
  return finalizeBreakdown(breakdown);
}

function scoreTrendFollowing(f) {
  const breakdown = {
    adxStrength: linearPts(f.tfAdxStrength, 18, 45, 25),
    htfTrendConfirm: booleanPts(f.tfHtfTrendConfirmed, 20),
    barsInTrendMaturity: sweetSpotPts(f.tfBarsInTrend, {
      peak: 12, inner: 4, outer: 45, maxPts: 15, floor: 3,
    }),
    emaStructure: booleanPts(f.tfEmaCrossover, 15),
    volume: linearPts(f.tfVolRatio, 1.0, 2.0, 15),
    donchianBreakout: linearPts(f.tfDonchianPeriod, 10, 30, 10),
  };
  return finalizeBreakdown(breakdown);
}

function scoreMeanReversion(f, opts = {}) {
  const signal = opts.signal;
  const bbMid = f.mrBbMidLevel;
  const bbUpper = f.mrBbUpperLevel;
  const bbLower = f.mrBbLowerLevel;
  const price = f.price ?? opts.price;
  let bbDevPts = 0;
  if (price != null && bbMid != null && bbUpper != null && bbLower != null) {
    const band = signal === "SHORT" ? bbUpper - bbMid : bbMid - bbLower;
    const dist = signal === "SHORT"
      ? Math.max(0, price - bbMid)
      : Math.max(0, bbMid - price);
    bbDevPts = band > 0 ? linearPts(dist / band, 0.5, 1.2, 25) : 0;
  } else {
    bbDevPts = linearPts(Math.abs(f.mrRsiValue != null ? (50 - f.mrRsiValue) / 50 : 0), 0.2, 0.8, 20);
  }
  const adxRegime = String(f.mrAdxRegime || "").toUpperCase();
  const regimePts = adxRegime.includes("BALANCE") || adxRegime.includes("RANGE")
    ? 20
    : adxRegime.includes("TREND") ? 5 : linearPts(f.mrAdxValue, 0, 20, 15);
  let roomPts = 0;
  if (price != null && bbMid != null) {
    roomPts = proximityPts(Math.abs(price - bbMid) / Math.max(Math.abs(bbMid), 1), 0.08, 15);
  } else if (f.mrVwapDeviation != null) {
    roomPts = linearPts(Math.abs(f.mrVwapDeviation), 0.3, 2.5, 15);
  }
  const breakdown = {
    deviationExtremity: bbDevPts,
    vwapDeviation: linearPts(Math.abs(f.mrVwapDeviation ?? 0), 0.4, 2.5, 20),
    rsiExtremity: f.mrRsiValue != null
      ? linearPts(Math.abs(f.mrRsiValue - 50), 12, 35, 20)
      : 0,
    regimeSuitability: regimePts,
    roomToMean: roomPts,
  };
  return finalizeBreakdown(breakdown);
}

function scoreBreakoutRetest(f) {
  const breakdown = {
    squeezeTightness: inverseLinearPts(f.bbSqueezeWidthAtr, 0.15, 1.2, 20),
    breakoutVolume: linearPts(f.breakoutVolumeRatio ?? f.volumeRatio, 1.1, 2.5, 20),
    retestQuality: sweetSpotPts(f.retestDepthAtr, {
      peak: 0.3, inner: 0.08, outer: 1.0, maxPts: 20, floor: 3,
    }),
    rejectionWick: linearPts(f.rejectionWickPct, 0.25, 0.75, 15),
    consolidationMaturity: linearPts(f.consolidationBars, 6, 30, 15),
    fundingTailwind: f.fundingRateAtEntry != null
      ? linearPts(Math.abs(f.fundingRateAtEntry), 0.00005, 0.0005, 10)
      : linearPts(Math.abs(f.fundingForecast24h ?? 0), 0.0001, 0.001, 8),
  };
  return finalizeBreakdown(breakdown);
}

function scoreMarketStructure(f, opts = {}) {
  const isLong = opts.signal === "LONG";
  const structureClear = isLong
    ? booleanPts(f.msHhPattern, 25)
    : booleanPts(f.msLlPattern, 25);
  const swingMag = f.msSwingHighPrice != null && f.msSwingLowPrice != null
    ? linearPts(Math.abs(f.msSwingHighPrice - f.msSwingLowPrice)
      / Math.max(f.msSwingLowPrice, 1), 0.01, 0.08, 20)
    : 10;
  const breakdown = {
    structureClarity: structureClear,
    pullbackDepthFit: sweetSpotPts(f.msPullbackDepthAtr, {
      peak: 0.45, inner: 0.12, outer: 1.5, maxPts: 20, floor: 3,
    }),
    swingStrength: swingMag,
    pullbackConfirm: booleanPts(f.msPullbackConfirmed, 20),
    htfAlignment: booleanPts(opts.htfAligned ?? f.htfAligned, 15),
  };
  return finalizeBreakdown(breakdown);
}

function scoreWyckoff(f) {
  const breakdown = {
    phaseConfidence: enumPts(f.wyPatternType, {
      SPRING: 1, UPTHRUST: 1, UTAD: 0.9, ACCUMULATION: 0.7, DISTRIBUTION: 0.7,
    }, 25),
    springUtDepth: sweetSpotPts(f.wyFakeBreakDepthAtr, {
      peak: 0.5, inner: 0.15, outer: 1.5, maxPts: 20, floor: 3,
    }),
    sosSowVolume: (f.wySosOrSow ? 10 : 0)
      + linearPts(f.wyVolumeRatio, 1.2, 2.5, 10),
    lpsQuality: f.wyLpsLevel != null ? 12 : 3,
    causeDuration: linearPts(f.wyAccumulationBars, 20, 120, 10),
    effortVsResult: sweetSpotPts(f.wyVolumeRatio, {
      peak: 1.6, inner: 0.4, outer: 3.0, maxPts: 10, floor: 2,
    }),
  };
  return finalizeBreakdown(breakdown);
}

function scoreVsa(f) {
  const volRatio = f.vsaAvgVolume > 0 && f.vsaVolume != null
    ? f.vsaVolume / f.vsaAvgVolume
    : null;
  const spreadRatio = f.vsaAvgSpread > 0 && f.vsaSpread != null
    ? f.vsaSpread / f.vsaAvgSpread
    : null;
  let effortResult = 0;
  if (volRatio != null && spreadRatio != null && spreadRatio > 0) {
    const er = volRatio / spreadRatio;
    effortResult = sweetSpotPts(er, { peak: 1.4, inner: 0.35, outer: 3.0, maxPts: 25, floor: 4 });
  }
  const breakdown = {
    effortVsResult: effortResult,
    volumeAnomaly: linearPts(volRatio, 1.2, 2.8, 20),
    spreadAnomaly: inverseLinearPts(spreadRatio, 0.4, 1.2, 20),
    patternStrength: enumPts(f.vsaPatternType, {
      STOPPING_VOLUME: 1, NO_SUPPLY: 0.85, NO_DEMAND: 0.85,
    }, 15),
    swingProximity: inverseLinearPts(f.vsaSwingProximity, 0.002, 0.04, 10),
    backgroundContext: booleanPts(f.vsaReversal, 10),
  };
  return finalizeBreakdown(breakdown);
}

function scoreAmt(f, opts = {}) {
  const price = f.price ?? opts.price;
  const poc = f.vpPocLevel;
  const vah = f.vpVahLevel;
  const val = f.vpValLevel;
  const vwap = f.vpVwapLevel;
  let edgePts = 0;
  let pocPts = 0;
  let vwapPts = 0;
  if (price != null) {
    if (vah != null && val != null) {
      const edgeDist = Math.min(Math.abs(price - vah), Math.abs(price - val));
      const vaWidth = Math.abs(vah - val);
      edgePts = vaWidth > 0
        ? linearPts(edgeDist / vaWidth, 0.05, 0.45, 25)
        : proximityPts(edgeDist / Math.max(price, 1), 0.02, 20);
    }
    if (poc != null) {
      pocPts = proximityPts(Math.abs(price - poc) / Math.max(price, 1), 0.025, 20);
    }
    if (vwap != null) {
      vwapPts = proximityPts(Math.abs(price - vwap) / Math.max(vwap, 1), 0.015, 20);
    }
  }
  const breakdown = {
    valueAreaEdge: edgePts,
    pocMagnetism: pocPts,
    vwapRelationship: vwapPts,
    triggerTypeQuality: enumPts(f.vpTriggerType, {
      VAH_REJECTION: 1, VAL_REJECTION: 1, POC_MAGNET: 0.85,
      VA_BREAKOUT: 0.7, VA_REENTRY: 0.75,
    }, 20),
    acceptanceRejection: linearPts(f.vpAcceptanceScore ?? 0.5, 0.3, 1.0, 15),
  };
  return finalizeBreakdown(breakdown);
}

function scoreStatArb(f) {
  const breakdown = {
    zScoreExtremity: linearPts(Math.abs(f.saZScore ?? 0), 1.5, 3.5, 30),
    bandTouchQuality: enumPts(f.saBandTouch, { UPPER: 1, LOWER: 1, NONE: 0.2 }, 20),
    revertSpeed: inverseLinearPts(f.saMeanRevertBars, 3, 40, 20),
    regimeStationarity: f.saMaDriftPct != null
      ? inverseLinearPts(f.saMaDriftPct, 0.001, 0.03, 20)
      : linearPts(f.saZScore != null ? 1 / (1 + Math.abs(f.saZScore)) : 0.3, 0.1, 0.8, 15),
    stdDevStability: f.saStdDev != null && f.saMaValue != null && f.saMaValue > 0
      ? inverseLinearPts(f.saStdDev / f.saMaValue, 0.005, 0.04, 10)
      : 5,
  };
  return finalizeBreakdown(breakdown);
}

function scoreLiquidationSqueeze(f) {
  const breakdown = {
    oiPercentileExtremity: linearPts(f.lsOiPercentile, 70, 98, 25),
    liqClusterProximity: proximityPts(
      f.lsLiquidationDistancePct ?? (f.lsLiquidationLevel != null ? 0.02 : null),
      0.06,
      20,
    ),
    wickReclaimDepth: sweetSpotPts(f.lsWickDepthAtr, {
      peak: 0.7, inner: 0.2, outer: 2.0, maxPts: 20, floor: 3,
    }),
    bbWidthPercentile: linearPts(f.lsBbWidthPercentile, 10, 85, 15),
    oiForecast: linearPts(Math.abs(f.lsOiForecast24h ?? 0), 0.02, 0.15, 10),
    squeezeConfirmation: linearPts(f.lsBbWidthExpansion ?? f.lsBbWidth, 0.005, 0.04, 10),
  };
  return finalizeBreakdown(breakdown);
}

const SCORERS = Object.freeze({
  SMART_MONEY_CONCEPTS: scoreSmc,
  ICT_STYLE_TRADING: scoreIct,
  SUPPLY_AND_DEMAND: scoreSupplyDemand,
  TREND_FOLLOWING: scoreTrendFollowing,
  MEAN_REVERSION: scoreMeanReversion,
  BREAKOUT_RETEST: scoreBreakoutRetest,
  MARKET_STRUCTURE: scoreMarketStructure,
  WYCKOFF: scoreWyckoff,
  VOLUME_SPREAD_ANALYSIS: scoreVsa,
  AUCTION_MARKET_THEORY: scoreAmt,
  STATISTICAL_ARBITRAGE: scoreStatArb,
  LIQUIDATION_SQUEEZE: scoreLiquidationSqueeze,
});

/** Resolve scoring key from meta (winner-aware). */
function resolveScoringStrategyKey(meta, fallbackKey) {
  const raw = meta?.winningComponent || meta?.component || fallbackKey || "";
  return normalizeStrategyKey(String(raw).toUpperCase()) || String(fallbackKey || "").toUpperCase();
}

/** Flatten meta → feature map for scoring (reuses Sprint 15 ML extractors). */
function buildFeaturesFromMeta(meta, strategyKey) {
  if (!meta) return {};
  const key = resolveScoringStrategyKey(meta, strategyKey);
  const comps = meta.confidenceComponents || meta.sequenceMeta?.confidenceComponents || {};
  return {
    ...extractSmcEnrichment(meta),
    ...extractBrEnrichment(meta),
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
    price: meta.price ?? meta.entryPrice ?? null,
    signal: meta.signal ?? meta.vote ?? null,
    htfAligned: meta.htfAligned ?? meta.tfHtfTrendConfirmed ?? null,
    mitigationDepth: comps.mitigationDepth ?? meta.confMitigationDepth ?? null,
    obConfluence: comps.obConfluence ?? meta.confObConfluence ?? null,
    sweepAgeBars: meta.sweepAgeBars ?? comps.sweepAge ?? null,
    zoneAgeBars: meta.zoneAgeBars ?? null,
    vpAcceptanceScore: meta.vpAcceptanceScore ?? null,
    saMaDriftPct: meta.saMaDriftPct ?? null,
    lsLiquidationDistancePct: meta.lsLiquidationDistancePct ?? null,
    lsBbWidthExpansion: meta.lsBbWidthExpansion ?? null,
    scoringKey: key,
    tradeType: canonicalTradeType(meta.tradeType)
      ?? canonicalTradeType(meta.component)
      ?? canonicalTradeType(meta.winningComponent),
    component: canonicalTradeType(meta.component) ?? meta.component,
  };
}

/**
 * Score a strategy component from a flat feature map.
 * @param {string} strategyKey
 * @param {object} features
 * @param {object} [opts] — { signal, price, htfAligned }
 * @returns {{ total: number, breakdown: Record<string, number> }}
 */
function scoreComponent(strategyKey, features = {}, opts = {}) {
  const key = normalizeStrategyKey(String(strategyKey || features.scoringKey || "").toUpperCase());
  const scorer = SCORERS[key];
  if (!scorer) {
    return { total: 0, breakdown: {} };
  }
  const merged = { ...features, ...opts };
  return scorer(merged, merged);
}

/**
 * Attach gradedScore + gradedScoreBreakdown to signal meta; updates componentConfidence.
 * @param {object|null} meta
 * @param {string} [strategyKey]
 * @returns {object|null}
 */
function enrichMetaWithGradedScore(meta, strategyKey) {
  if (!meta) return meta;
  const key = resolveScoringStrategyKey(meta, strategyKey);
  if (!SCORERS[key]) return meta;
  const features = buildFeaturesFromMeta(meta, key);
  const tradeType = features.tradeType ?? null;
  const scored = scoreComponent(key, features, {
    signal: meta.signal ?? meta.vote,
    price: meta.price ?? meta.entryPrice,
    htfAligned: meta.htfAligned ?? meta.tfHtfTrendConfirmed,
    tradeType,
    component: tradeType,
  });
  return {
    ...meta,
    gradedScore: scored.total,
    gradedScoreBreakdown: scored.breakdown,
    componentConfidence: scored.total,
    scoringStrategyKey: key,
  };
}

/** 0-1 confidence for race-to-confirm (Adaptive Fusion / TS / MD / BS). */
function gradedConfidenceFromMeta(meta, strategyKey) {
  const enriched = enrichMetaWithGradedScore(meta, strategyKey);
  return (enriched?.gradedScore ?? 0) / 100;
}

/** Copy graded score fields onto a trade/snapshot object (BotEngine / CSV). */
function applyGradedScoreToSnapshot(snapshot, meta, strategyKey) {
  if (!snapshot || !meta) return snapshot;
  const enriched = enrichMetaWithGradedScore(meta, strategyKey);
  if (enriched?.gradedScore == null) return snapshot;
  snapshot.gradedScore = enriched.gradedScore;
  snapshot.gradedScoreBreakdown = enriched.gradedScoreBreakdown;
  snapshot.scoringStrategyKey = enriched.scoringStrategyKey;
  snapshot.afConfidence = enriched.gradedScore;
  snapshot.componentConfidence = enriched.gradedScore;
  return snapshot;
}

/** Resolve 0-100 signal confidence for ML gate (prefers gradedScore). */
function resolveGradedSignalConfidence(snapshot) {
  if (snapshot?.gradedScore != null) return snapshot.gradedScore;
  return snapshot?.afAggregateConfidence ?? snapshot?.afConfidence ?? null;
}

module.exports = {
  SCORERS,
  SMC_RUBRIC_DEFAULT,
  SMC_RUBRIC_SCALPING,
  resolveSmcRubric,
  scoreComponent,
  buildFeaturesFromMeta,
  resolveScoringStrategyKey,
  enrichMetaWithGradedScore,
  gradedConfidenceFromMeta,
  applyGradedScoreToSnapshot,
  resolveGradedSignalConfidence,
};
