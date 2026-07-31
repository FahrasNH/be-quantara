/**
 * component-scoring-engine.test.js — Sprint 16 graded 0-100 component scoring
 *
 * Run: node test/component-scoring-engine.test.js
 */

"use strict";

const assert = require("assert");
const {
  SCORERS,
  SMC_RUBRIC_DEFAULT,
  SMC_RUBRIC_SCALPING,
  scoreComponent,
  enrichMetaWithGradedScore,
  gradedConfidenceFromMeta,
  buildFeaturesFromMeta,
} = require("../src/core/strategy-engine/scoring/ComponentScoringEngine");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(".");
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${name}: ${err.message}`);
  }
}

const SAMPLE_FEATURES = {
  SMART_MONEY_CONCEPTS: {
    sweepStrength: 1.5,
    displacementPct: 1.2,
    fvgSizeAtr: 0.7,
    obDistanceAtr: 0.4,
    htfAdx: 28,
    confObConfluence: true,
    confMitigationDepth: 0.5,
  },
  ICT_STYLE_TRADING: {
    ictKillZoneHour: 8,
    ictRaidDepthAtr: 0.6,
    ictMssPct: 0.5,
    ictVolumeRatio: 1.8,
    ictReversal: true,
  },
  SUPPLY_AND_DEMAND: {
    sdTimeToRetestBars: 12,
    sdZoneSizeAtr: 0.9,
    sdRetestDepthAtr: 0.35,
    sdVolumeConfirmation: true,
    sdConfluence: true,
  },
  TREND_FOLLOWING: {
    tfAdxStrength: 32,
    tfHtfTrendConfirmed: true,
    tfBarsInTrend: 14,
    tfVolRatio: 1.5,
    tfDonchianPeriod: 20,
  },
  MEAN_REVERSION: {
    mrRsiValue: 72,
    mrVwapDeviation: 1.2,
    mrAdxRegime: "BALANCE",
    price: 105,
    mrBbMidLevel: 100,
    mrBbUpperLevel: 108,
    mrBbLowerLevel: 92,
    signal: "SHORT",
  },
  BREAKOUT_RETEST: {
    bbSqueezeWidthAtr: 0.35,
    breakoutVolumeRatio: 1.8,
    retestDepthAtr: 0.3,
    rejectionWickPct: 0.55,
    consolidationBars: 18,
    fundingRateAtEntry: 0.0002,
  },
  MARKET_STRUCTURE: {
    msHhPattern: true,
    msPullbackDepthAtr: 0.45,
    msSwingHighPrice: 110,
    msSwingLowPrice: 100,
    msPullbackConfirmed: true,
    htfAligned: true,
    signal: "LONG",
  },
  WYCKOFF: {
    wyPatternType: "SPRING",
    wyFakeBreakDepthAtr: 0.5,
    wyVolumeRatio: 1.6,
    wySosOrSow: "SOS",
    wyLpsLevel: 99,
    wyAccumulationBars: 60,
  },
  VOLUME_SPREAD_ANALYSIS: {
    vsaPatternType: "STOPPING_VOLUME",
    vsaSpread: 1.2,
    vsaVolume: 2.4,
    vsaAvgSpread: 1.0,
    vsaAvgVolume: 1.5,
    vsaSwingProximity: 0.01,
    vsaReversal: true,
  },
  AUCTION_MARKET_THEORY: {
    price: 102,
    vpVahLevel: 105,
    vpValLevel: 95,
    vpPocLevel: 100,
    vpVwapLevel: 101,
    vpTriggerType: "VAH_REJECTION",
    vpAcceptanceScore: 0.8,
  },
  STATISTICAL_ARBITRAGE: {
    saZScore: 2.5,
    saBandTouch: "UPPER",
    saMeanRevertBars: 8,
    saMaValue: 100,
    saStdDev: 2,
    saMaDriftPct: 0.005,
  },
  LIQUIDATION_SQUEEZE: {
    lsOiPercentile: 92,
    lsLiquidationDistancePct: 0.02,
    lsWickDepthAtr: 0.7,
    lsBbWidthPercentile: 75,
    lsOiForecast24h: 0.08,
    lsBbWidth: 0.025,
  },
};

test("SCORERS exposes all 12 strategy keys", () => {
  assert.strictEqual(Object.keys(SCORERS).length, 12);
  for (const key of Object.keys(SAMPLE_FEATURES)) {
    assert.ok(SCORERS[key], `missing scorer for ${key}`);
  }
});

for (const [key, features] of Object.entries(SAMPLE_FEATURES)) {
  test(`${key} scoreComponent returns 0-100 with breakdown`, () => {
    const result = scoreComponent(key, features, features);
    assert.ok(Number.isFinite(result.total), "total must be finite");
    assert.ok(result.total >= 0 && result.total <= 100, `total out of range: ${result.total}`);
    assert.ok(result.breakdown && typeof result.breakdown === "object");
    assert.ok(Object.keys(result.breakdown).length > 0, "breakdown must not be empty");
    for (const v of Object.values(result.breakdown)) {
      assert.ok(Number.isFinite(v), "breakdown values must be finite");
      assert.ok(v >= 0, "breakdown values must be non-negative");
    }
  });
}

test("enrichMetaWithGradedScore attaches graded fields", () => {
  const meta = enrichMetaWithGradedScore({
    winningComponent: "TREND_FOLLOWING",
    tfAdxStrength: 30,
    tfHtfTrendConfirmed: true,
    tfBarsInTrend: 10,
    tfVolRatio: 1.4,
    tfDonchianPeriod: 18,
  }, "TREND_FOLLOWING");
  assert.ok(meta.gradedScore >= 0 && meta.gradedScore <= 100);
  assert.ok(meta.gradedScoreBreakdown && typeof meta.gradedScoreBreakdown === "object");
  assert.strictEqual(meta.scoringStrategyKey, "TREND_FOLLOWING");
  assert.strictEqual(meta.componentConfidence, meta.gradedScore);
});

test("gradedConfidenceFromMeta returns 0-1 scale", () => {
  const conf = gradedConfidenceFromMeta({
    winningComponent: "WYCKOFF",
    wyPatternType: "SPRING",
    wyFakeBreakDepthAtr: 0.45,
    wyVolumeRatio: 1.5,
    wyAccumulationBars: 40,
    wyLpsLevel: 100,
    wySosOrSow: "SOS",
  }, "WYCKOFF");
  assert.ok(conf >= 0 && conf <= 1);
});

test("buildFeaturesFromMeta merges Sprint 15 ML extractors", () => {
  const features = buildFeaturesFromMeta({
    winningComponent: "BREAKOUT_RETEST",
    bbSqueezeWidthAtr: 0.4,
    breakoutVolumeRatio: 1.5,
    retestDepthAtr: 0.25,
  }, "BREAKOUT_RETEST");
  assert.strictEqual(features.bbSqueezeWidthAtr, 0.4);
  assert.strictEqual(features.breakoutVolumeRatio, 1.5);
});

test("unknown strategy key returns zero score", () => {
  const result = scoreComponent("NOT_A_STRATEGY", {});
  assert.strictEqual(result.total, 0);
  assert.deepStrictEqual(result.breakdown, {});
});

function rubricMaxSum(rubric) {
  return rubric.sweepQuality.maxPts
    + rubric.chochDisplacement.maxPts
    + rubric.fvgQuality.maxPts
    + rubric.obConfluence.proximityMax + rubric.obConfluence.booleanMax
    + rubric.htfAlignment.adxMax + rubric.htfAlignment.alignMax
    + rubric.liquidityFreshness.mitigationMax + rubric.liquidityFreshness.sweepAgeMax;
}

test("SMC default rubric max caps unchanged for Intraday/Swing", () => {
  assert.strictEqual(SMC_RUBRIC_DEFAULT.sweepQuality.maxPts, 25);
  assert.strictEqual(SMC_RUBRIC_DEFAULT.chochDisplacement.maxPts, 20);
  assert.strictEqual(SMC_RUBRIC_DEFAULT.fvgQuality.maxPts, 15);
  assert.strictEqual(SMC_RUBRIC_DEFAULT.obConfluence.proximityMax + SMC_RUBRIC_DEFAULT.obConfluence.booleanMax, 20);
  assert.strictEqual(SMC_RUBRIC_DEFAULT.htfAlignment.adxMax + SMC_RUBRIC_DEFAULT.htfAlignment.alignMax, 15);
  assert.strictEqual(
    SMC_RUBRIC_DEFAULT.liquidityFreshness.mitigationMax + SMC_RUBRIC_DEFAULT.liquidityFreshness.sweepAgeMax,
    10,
  );
  assert.strictEqual(rubricMaxSum(SMC_RUBRIC_DEFAULT), 105);
});

test("SMC Scalping rubric max caps match sweep+CHOCH calibration", () => {
  assert.strictEqual(SMC_RUBRIC_SCALPING.sweepQuality.maxPts, 35);
  assert.strictEqual(SMC_RUBRIC_SCALPING.chochDisplacement.maxPts, 35);
  assert.strictEqual(SMC_RUBRIC_SCALPING.fvgQuality.maxPts, 15);
  assert.strictEqual(SMC_RUBRIC_SCALPING.obConfluence.proximityMax + SMC_RUBRIC_SCALPING.obConfluence.booleanMax, 10);
  assert.strictEqual(SMC_RUBRIC_SCALPING.htfAlignment.adxMax + SMC_RUBRIC_SCALPING.htfAlignment.alignMax, 3);
  assert.strictEqual(SMC_RUBRIC_SCALPING.htfAlignment.adxMax, 2);
  assert.strictEqual(SMC_RUBRIC_SCALPING.htfAlignment.alignMax, 1);
  assert.strictEqual(
    SMC_RUBRIC_SCALPING.liquidityFreshness.mitigationMax + SMC_RUBRIC_SCALPING.liquidityFreshness.sweepAgeMax,
    2,
  );
  assert.strictEqual(SMC_RUBRIC_SCALPING.liquidityFreshness.mitigationMax, 2);
  assert.strictEqual(SMC_RUBRIC_SCALPING.liquidityFreshness.sweepAgeMax, 0);
  assert.strictEqual(rubricMaxSum(SMC_RUBRIC_SCALPING), 100);
});

test("SMC Scalping tradeType uses scalp rubric; Intraday keeps default", () => {
  const features = { ...SAMPLE_FEATURES.SMART_MONEY_CONCEPTS, confObConfluence: true };
  const scalp = scoreComponent("SMART_MONEY_CONCEPTS", features, { tradeType: "Scalping" });
  const intraday = scoreComponent("SMART_MONEY_CONCEPTS", features, { tradeType: "Intraday" });
  assert.ok(scalp.total > 0 && scalp.total <= 100);
  assert.ok(intraday.total > 0 && intraday.total <= 100);
  assert.ok(scalp.breakdown.sweepQuality >= intraday.breakdown.sweepQuality);
  assert.ok(scalp.breakdown.obConfluence <= intraday.breakdown.obConfluence);
  assert.ok(scalp.breakdown.liquidityFreshness <= intraday.breakdown.liquidityFreshness);
});

test("enrichMetaWithGradedScore routes SMC Scalping via tradeType", () => {
  const meta = enrichMetaWithGradedScore({
    winningComponent: "SMART_MONEY_CONCEPTS",
    tradeType: "Scalping",
    ...SAMPLE_FEATURES.SMART_MONEY_CONCEPTS,
  }, "SMART_MONEY_CONCEPTS");
  assert.strictEqual(meta.scoringStrategyKey, "SMART_MONEY_CONCEPTS");
  assert.ok(meta.gradedScoreBreakdown.sweepQuality <= 35);
  assert.ok(meta.gradedScoreBreakdown.obConfluence <= 10);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
