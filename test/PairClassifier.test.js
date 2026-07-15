'use strict';
/**
 * PairClassifier.test.js  (test/PairClassifier.test.js)
 *
 * PAIR-TIER-04 — Unit tests for PairClassifier v2.1
 */

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  PairClassifier,
  pairClassifier,
  PAIR_TIER,
  STRATEGIES_BY_PAIR_TIER,
  PARAM_OVERRIDES,
  LIQUID_PAIRS,
  VOLATILE_PAIRS,
  computeHybridScore,
  tierFromHybridScore,
  calculateHybridVolatilityScore,
} = require('../src/infrastructure/classification/PairClassifier');

/** Seed CoinGecko dynamic data for test instances. */
function seedCoinData(pc, base, { rank, marketCap, volume24h, priceChange24h = 5 }) {
  pc._dynamicCoinData.set(base, {
    id:             `${base.toLowerCase()}-test`,
    marketCap,
    volume24h,
    rank,
    priceChange24h,
  });
  pc._dynamicRankMap.set(base, rank);
}

describe('PairClassifier', () => {
  // ── determineTier — static emergency fallback (CoinGecko offline) ─────────

  describe('determineTier() — LIQUID pairs (static emergency)', () => {
    const liquidPairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'];
    for (const sym of liquidPairs) {
      it(`classifies ${sym} as LIQUID`, () => {
        assert.equal(pairClassifier.determineTier(sym), PAIR_TIER.LIQUID);
      });
    }

    it('classifies BTCUSDT regardless of case', () => {
      assert.equal(pairClassifier.determineTier('btcusdt'), PAIR_TIER.LIQUID);
    });
  });

  describe('determineTier() — unknown symbols (conservative fail-safe)', () => {
    it('classifies an unknown symbol as VOLATILE when CoinGecko unavailable', () => {
      assert.equal(pairClassifier.determineTier('UNKNOWNUSDT'), PAIR_TIER.VOLATILE);
    });
    it('classifies an empty symbol as VOLATILE', () => {
      assert.equal(pairClassifier.determineTier(''), PAIR_TIER.VOLATILE);
    });
    it('classifies null/undefined as VOLATILE without throwing', () => {
      assert.equal(pairClassifier.determineTier(null), PAIR_TIER.VOLATILE);
    });
  });

  // ── classify() ────────────────────────────────────────────────────────────

  describe('classify() — full output structure', () => {
    it('BTCUSDT returns correct LIQUID classification', () => {
      const r = pairClassifier.classify('BTCUSDT');
      assert.equal(r.tier, 'LIQUID');
      assert.equal(r.riskLevel, 'LOW');
      assert.ok(r.recommendedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.recommendedStrategies.includes('TREND_FOLLOWING'));
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.deepEqual(r.blockedStrategies, []);
      assert.equal(r.paramOverrides.slMultiplier, 1.0);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 1.0);
      assert.equal(r.paramOverrides.maxTradesPerDay, null);
      assert.equal(r.paramOverrides.regimeFilterRequired, false);
      assert.equal(r.paramOverrides.votingThresholdOverride, null);
    });

    it('WLDUSDT with hybrid metrics → SEMI_VOLATILE (v2.4 continuous)', () => {
      // v2.4: beta/rank penalties are now continuous ramps rather than step
      // functions, so fixtures near the old hard thresholds (1.8/150) need
      // moderately lower beta/rank to still land in SEMI_VOLATILE — see
      // ATR_AND_PAIR_TIER_GUIDE.md §2.2.
      const metrics = {
        hv30: 88, atrPercent14: 4.2, liquidityRatio: 0.02,
        marketCapRank: 90, betaToBTC: 1.3,
      };
      const r = pairClassifier.classify('WLDUSDT', metrics);
      assert.equal(r.tier, 'SEMI_VOLATILE');
      assert.equal(r.riskLevel, 'HIGH-MED');
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.ok(r.recommendedStrategies.includes('TREND_FOLLOWING'));
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      // Continuous SL/size now interpolate from the score instead of the
      // fixed tier step (1.3/0.75) — verify against the same formula.
      assert.ok(Math.abs(r.paramOverrides.slMultiplier - (1.0 + 0.5 * Math.min(Math.max((r.hybridScore - 0.40) / 0.45, 0), 1))) < 1e-9);
      assert.ok(Math.abs(r.paramOverrides.positionSizeAdjustment - (1.0 - 0.45 * Math.min(Math.max((r.hybridScore - 0.45) / 0.40, 0), 1))) < 1e-9);
      assert.ok(r.paramOverrides.slMultiplier > 1.3 && r.paramOverrides.slMultiplier < 1.5);
      assert.ok(r.paramOverrides.positionSizeAdjustment > 0.55 && r.paramOverrides.positionSizeAdjustment < 0.75);
    });

    it('AVAXUSDT with hybrid metrics → STABLE (v2.4 continuous)', () => {
      const metrics = {
        hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04,
        marketCapRank: 40, betaToBTC: 1.2,
      };
      const r = pairClassifier.classify('AVAXUSDT', metrics);
      assert.equal(r.tier, 'STABLE');
      assert.equal(r.riskLevel, 'MEDIUM');
      assert.ok(r.recommendedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.deepEqual(r.blockedStrategies, []);
      // Continuous sizing: score sits mid-STABLE, so SL/size land between the
      // old LIQUID and STABLE fixed steps rather than exactly on 1.1/0.95.
      assert.ok(r.paramOverrides.slMultiplier > 1.0 && r.paramOverrides.slMultiplier < 1.3);
      assert.ok(r.paramOverrides.positionSizeAdjustment > 0.75 && r.paramOverrides.positionSizeAdjustment < 1.0);
      assert.equal(r.paramOverrides.maxTradesPerDay, 8);
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.60);
    });

    it('HYPEUSDT with hybrid metrics → SEMI_VOLATILE (v2.4 doc example)', () => {
      const metrics = {
        hv30: 88, atrPercent14: 4.2, liquidityRatio: 0.02,
        marketCapRank: 70, betaToBTC: 1.3,
      };
      const r = pairClassifier.classify('HYPEUSDT', metrics);
      assert.equal(r.tier, 'SEMI_VOLATILE');
      assert.equal(r.riskLevel, 'HIGH-MED');
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
    });

    it('thin microcap with hybrid metrics → VOLATILE', () => {
      const metrics = {
        hv30: 110, atrPercent14: 5.5, liquidityRatio: 0.002,
        marketCapRank: 200, betaToBTC: 2.0,
      };
      const r = pairClassifier.classify('GRASSUSDT', metrics);
      assert.equal(r.tier, 'VOLATILE');
      assert.equal(r.riskLevel, 'HIGH');
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.ok(r.recommendedStrategies.includes('TREND_FOLLOWING'));
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.blockedStrategies.includes('BREAKOUT_RETEST'));
      assert.equal(r.paramOverrides.slMultiplier, 1.5);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.55);
      assert.equal(r.paramOverrides.maxTradesPerDay, 4);
      assert.equal(r.paramOverrides.dailyLossLimit, 0.03);
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.78);
    });

    it('ETHUSDT is LIQUID with LOW risk', () => {
      const r = pairClassifier.classify('ETHUSDT');
      assert.equal(r.tier, 'LIQUID');
      assert.equal(r.riskLevel, 'LOW');
    });
  });

  // ── isStrategyBlocked() ───────────────────────────────────────────────────

  describe('isStrategyBlocked()', () => {
    it('ADAPTIVE_FUSION NOT blocked on BTCUSDT', () => {
      assert.equal(pairClassifier.isStrategyBlocked('BTCUSDT', 'ADAPTIVE_FUSION'), false);
    });
    it('ADAPTIVE_FUSION IS blocked on WLDUSDT with semi-volatile metrics', () => {
      const metrics = { hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 120 };
      assert.equal(pairClassifier.isStrategyBlocked('WLDUSDT', 'ADAPTIVE_FUSION', metrics), true);
    });
    it('TREND_FOLLOWING NOT blocked on HYPEUSDT with semi-volatile metrics', () => {
      const metrics = { hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 80 };
      assert.equal(pairClassifier.isStrategyBlocked('HYPEUSDT', 'TREND_FOLLOWING', metrics), false);
    });
    it('BREAKOUT_RETEST IS blocked on thin microcap (Gen1 ingress normalizes)', () => {
      const metrics = { hv30: 110, atrPercent14: 5.5, liquidityRatio: 0.002, marketCapRank: 200 };
      assert.equal(pairClassifier.isStrategyBlocked('SUIUSDT', 'BREAKOUT_RETEST', metrics), true);
    });
    it('MEAN_REVERSION NOT blocked on WLDUSDT with semi-volatile metrics', () => {
      const metrics = { hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 120 };
      assert.equal(pairClassifier.isStrategyBlocked('WLDUSDT', 'MEAN_REVERSION', metrics), false);
    });
    it('TREND_FOLLOWING NOT blocked on ETHUSDT (LIQUID)', () => {
      assert.equal(pairClassifier.isStrategyBlocked('ETHUSDT', 'TREND_FOLLOWING'), false);
    });
    it('ADAPTIVE_FUSION NOT blocked on AVAXUSDT with stable metrics', () => {
      const metrics = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 };
      assert.equal(pairClassifier.isStrategyBlocked('AVAXUSDT', 'ADAPTIVE_FUSION', metrics), false);
    });
  });

  // ── PARAM_OVERRIDES constants ─────────────────────────────────────────────

  describe('PARAM_OVERRIDES constants', () => {
    it('LIQUID has slMultiplier 1.0 and no daily loss limit', () => {
      assert.equal(PARAM_OVERRIDES.LIQUID.slMultiplier, 1.0);
      assert.equal(PARAM_OVERRIDES.LIQUID.dailyLossLimit, null);
      assert.equal(PARAM_OVERRIDES.LIQUID.regimeFilterRequired, false);
    });
    it('STABLE has slMultiplier 1.1 and votingThresholdOverride 0.60', () => {
      assert.equal(PARAM_OVERRIDES.STABLE.slMultiplier, 1.1);
      assert.equal(PARAM_OVERRIDES.STABLE.votingThresholdOverride, 0.60);
    });
    it('SEMI_VOLATILE has slMultiplier 1.3 and dailyLossLimit 0.025', () => {
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.slMultiplier, 1.3);
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.positionSizeAdjustment, 0.75);
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.maxTradesPerDay, 6);
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.dailyLossLimit, 0.025);
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.regimeFilterRequired, true);
      assert.equal(PARAM_OVERRIDES.SEMI_VOLATILE.votingThresholdOverride, 0.70);
    });
    it('VOLATILE has slMultiplier 1.5 and regimeFilterRequired true', () => {
      assert.equal(PARAM_OVERRIDES.VOLATILE.slMultiplier, 1.5);
      assert.equal(PARAM_OVERRIDES.VOLATILE.regimeFilterRequired, true);
      assert.equal(PARAM_OVERRIDES.VOLATILE.dailyLossLimit, 0.03);
      assert.equal(PARAM_OVERRIDES.VOLATILE.votingThresholdOverride, 0.78);
    });
  });

  // ── Hybrid Volatility Score (v2.1) ────────────────────────────────────────

  describe('calculateHybridVolatilityScore() — v2.1 thresholds', () => {
    const lowRisk = {
      hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12, marketCapRank: 5, betaToBTC: 1.0,
    };
    const midRisk = {
      hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 80, betaToBTC: 1.2,
    };
    const highMed = {
      hv30: 88, atrPercent14: 4.2, liquidityRatio: 0.02, marketCapRank: 90, betaToBTC: 1.3,
    };
    const highRisk = {
      hv30: 110, atrPercent14: 5.5, liquidityRatio: 0.002, marketCapRank: 200, betaToBTC: 2.0,
    };

    it('blue-chip metrics → LIQUID (score < 0.48)', () => {
      assert.equal(calculateHybridVolatilityScore(lowRisk), PAIR_TIER.LIQUID);
      assert.ok(computeHybridScore(lowRisk) < 0.48);
    });

    it('mid-cap metrics → STABLE (0.48–0.65)', () => {
      assert.equal(calculateHybridVolatilityScore(midRisk), PAIR_TIER.STABLE);
      const s = computeHybridScore(midRisk);
      assert.ok(s > 0.48 && s <= 0.65, `score=${s}`);
    });

    it('transitional metrics → SEMI_VOLATILE (0.66–0.78)', () => {
      assert.equal(calculateHybridVolatilityScore(highMed), PAIR_TIER.SEMI_VOLATILE);
      const s = computeHybridScore(highMed);
      assert.ok(s > 0.65 && s <= 0.78, `score=${s}`);
    });

    it('microcap / thin liquidity → VOLATILE (> 0.78)', () => {
      assert.equal(calculateHybridVolatilityScore(highRisk), PAIR_TIER.VOLATILE);
      assert.ok(computeHybridScore(highRisk) > 0.78);
    });

    // v2.4: beta/rank penalties are now continuous ramps (linear/log scaling)
    // instead of step functions — see ATR_AND_PAIR_TIER_GUIDE.md §2.2. These
    // tests verify the ramp shape (monotonic, saturates at the cap, no cliff
    // at the old hard thresholds) rather than a single fixed jump amount.
    it('betaToBTC penalty ramps continuously and saturates at +0.08 (score ≥2.5)', () => {
      const base = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 80, betaToBTC: 1.0 };
      const mid = { ...base, betaToBTC: 1.75 };
      const saturated = { ...base, betaToBTC: 2.5 };
      const beyond = { ...base, betaToBTC: 4.0 };
      const s0 = computeHybridScore(base), sMid = computeHybridScore(mid);
      const sSat = computeHybridScore(saturated), sBeyond = computeHybridScore(beyond);
      // Monotonic increase with beta, no jump: beta 1.0→1.75 (mid-ramp) adds less
      // than the full +0.08 that only kicks in once beta reaches 2.5.
      assert.ok(sMid - s0 > 0 && sMid - s0 < 0.08, `delta=${sMid - s0}`);
      assert.ok(Math.abs((sSat - s0) - 0.08) < 1e-9, `delta=${sSat - s0}`);
      // Saturation: beta beyond 2.5 adds no further penalty (clamped, not unbounded).
      assert.equal(sBeyond, sSat);
    });

    it('marketCapRank penalty ramps continuously (log scale) and saturates at +0.10', () => {
      const base = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 50, betaToBTC: 1.0 };
      const mid = { ...base, marketCapRank: 150 };
      const saturated = { ...base, marketCapRank: 300 };
      const s0 = computeHybridScore(base), sMid = computeHybridScore(mid);
      const sSat = computeHybridScore(saturated);
      assert.ok(sMid - s0 > 0 && sMid - s0 < 0.10, `delta=${sMid - s0}`);
      assert.ok(Math.abs((sSat - s0) - 0.10) < 1e-9, `delta=${sSat - s0}`);
      // Log scaling: the 50→100 step (rank doubling near the origin) should
      // add MORE penalty than the 200→250 step (same absolute distance, far
      // out on the curve) — thinning liquidity is not linear with rank.
      const rank100 = computeHybridScore({ ...base, marketCapRank: 100 });
      const rank200 = computeHybridScore({ ...base, marketCapRank: 200 });
      const rank250 = computeHybridScore({ ...base, marketCapRank: 250 });
      assert.ok((rank100 - s0) > (rank250 - rank200));
    });

    it('tierFromHybridScore respects boundary at 0.48 / 0.65 / 0.78', () => {
      assert.equal(tierFromHybridScore(0.48), PAIR_TIER.LIQUID);
      assert.equal(tierFromHybridScore(0.49), PAIR_TIER.STABLE);
      assert.equal(tierFromHybridScore(0.65), PAIR_TIER.STABLE);
      assert.equal(tierFromHybridScore(0.66), PAIR_TIER.SEMI_VOLATILE);
      assert.equal(tierFromHybridScore(0.78), PAIR_TIER.SEMI_VOLATILE);
      assert.equal(tierFromHybridScore(0.79), PAIR_TIER.VOLATILE);
    });
  });

  describe('determineTier() — hybrid score path (v2.1)', () => {
    it('uses hybrid score when full metrics supplied', () => {
      const pc = new PairClassifier();
      const metrics = {
        hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12,
        marketCapRank: 5, betaToBTC: 1.0,
      };
      assert.equal(pc.determineTier('BTCUSDT', metrics), PAIR_TIER.LIQUID);
    });

    it('classify() includes hybridScore when metrics supplied', () => {
      const pc = new PairClassifier();
      const metrics = {
        hv30: 110, atrPercent14: 5.5, liquidityRatio: 0.002,
        marketCapRank: 200, betaToBTC: 2.0,
      };
      const r = pc.classify('GRASSUSDT', metrics);
      assert.equal(r.tier, PAIR_TIER.VOLATILE);
      assert.ok(typeof r.hybridScore === 'number');
      assert.ok(r.hybridScore > 0.78);
    });

    it('lowLiquidity fail-safe forces VOLATILE even on low hybrid score', () => {
      const pc = new PairClassifier();
      const metrics = {
        hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12,
        marketCapRank: 5, betaToBTC: 1.0, lowLiquidity: true,
      };
      assert.equal(pc.determineTier('BTCUSDT', metrics), PAIR_TIER.VOLATILE);
    });
  });

  // ── CoinGecko dynamic hybrid (v2.1 real-API path) ─────────────────────────

  describe('CoinGecko dynamic hybrid (v2.1)', () => {
    it('HYPE classifies as SEMI_VOLATILE from CoinGecko data (high vol, large cap)', () => {
      const pc = new PairClassifier();
      // Simulates HYPE: rank ~40, high 24h change, moderate liquidity ratio
      seedCoinData(pc, 'HYPE', {
        rank: 40, marketCap: 12_000_000_000, volume24h: 1_200_000_000, priceChange24h: 6.5,
      });
      const tier = pc.determineTier('HYPEUSDT');
      assert.equal(tier, PAIR_TIER.SEMI_VOLATILE);
      const r = pc.classify('HYPEUSDT');
      assert.equal(r.tier, 'SEMI_VOLATILE');
      assert.equal(r.riskLevel, 'HIGH-MED');
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(typeof r.hybridScore === 'number');
    });

    it('BTC classifies as LIQUID from CoinGecko data (low vol, deep liquidity)', () => {
      const pc = new PairClassifier();
      seedCoinData(pc, 'BTC', {
        rank: 1, marketCap: 1_200_000_000_000, volume24h: 40_000_000_000, priceChange24h: 1.2,
      });
      assert.equal(pc.determineTier('BTCUSDT'), PAIR_TIER.LIQUID);
    });

    it('hybrid metric: extreme ATR%30d continuously bumps STABLE → SEMI_VOLATILE', () => {
      // v2.4: replaces the old step "ATR30 > 4.5% → bump 1 tier" with a
      // continuous penalty (0 at ≤3.5%, saturates at +0.15 by 6.5%) — a coin
      // needs genuinely extreme realized volatility to cross a tier, not just
      // a hair over the old cliff. See ATR_AND_PAIR_TIER_GUIDE.md §2.2.
      const pc = new PairClassifier();
      const stableMetrics = {
        hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40,
      };
      assert.equal(pc.determineTier('BARUSDT', stableMetrics), PAIR_TIER.STABLE);
      // A mild breach (5.0%) is not yet enough to flip the tier — proportional,
      // not a cliff.
      assert.equal(pc.determineTier('BARUSDT', { ...stableMetrics, atrPct30d: 5.0 }), PAIR_TIER.STABLE);
      // A genuinely extreme reading (6.0%, near the saturation point) does.
      assert.equal(pc.determineTier('BARUSDT', { ...stableMetrics, atrPct30d: 6.0 }), PAIR_TIER.SEMI_VOLATILE);
    });

    it('hybrid metric: low liquidity forces VOLATILE', () => {
      const pc = new PairClassifier();
      seedCoinData(pc, 'BAZ', {
        rank: 1, marketCap: 1_000_000_000_000, volume24h: 50_000_000_000, priceChange24h: 1.0,
      });
      assert.equal(pc.determineTier('BAZUSDT'), PAIR_TIER.LIQUID);
      assert.equal(pc.determineTier('BAZUSDT', { lowLiquidity: true }), PAIR_TIER.VOLATILE);
    });

    it('hybrid metric: volume24h < minVolume24h forces VOLATILE', () => {
      const pc = new PairClassifier();
      seedCoinData(pc, 'QUX', {
        rank: 1, marketCap: 1_000_000_000_000, volume24h: 50_000_000_000, priceChange24h: 1.0,
      });
      assert.equal(
        pc.determineTier('QUXUSDT', { volume24h: 500_000, minVolume24h: 2_000_000 }),
        PAIR_TIER.VOLATILE,
      );
      assert.equal(
        pc.determineTier('QUXUSDT', { volume24h: 50_000_000, minVolume24h: 2_000_000 }),
        PAIR_TIER.LIQUID,
      );
    });

    it('getCoinGeckoMarketData returns stored refresh data', () => {
      const pc = new PairClassifier();
      seedCoinData(pc, 'HYPE', {
        rank: 40, marketCap: 12e9, volume24h: 800e6, priceChange24h: 8.5,
      });
      const data = pc.getCoinGeckoMarketData('HYPEUSDT');
      assert.ok(data);
      assert.equal(data.marketCapRank, 40);
      assert.equal(data.volume24h, 800e6);
    });
  });

  // ── HV7/HV14/HV30 blend (v2.4) ─────────────────────────────────────────────

  describe('HV blend (v2.4 dynamic ATR review)', () => {
    it('a spiking HV7 raises the score faster than HV30 alone would', () => {
      // Same HV30 in both cases; only HV7 differs (volatility just started
      // rising this week). The blend should react — HV30-only would not.
      const calmingDown = { hv7: 40, hv14: 55, hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 };
      const flaringUp    = { hv7: 100, hv14: 80, hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 };
      assert.ok(computeHybridScore(flaringUp) > computeHybridScore(calmingDown));
    });

    it('falls back to hv30 alone when hv7/hv14 are not supplied (backward compatible)', () => {
      const hv30Only = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 };
      const blendEquivalent = { hv7: 70, hv14: 70, hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 };
      assert.equal(computeHybridScore(hv30Only), computeHybridScore(blendEquivalent));
    });

    it('blendHV weights HV7 0.5 / HV14 0.3 / HV30 0.2', () => {
      const { blendHV } = require('../src/infrastructure/classification/PairClassifier');
      assert.ok(Math.abs(blendHV(100, 50, 20) - (100 * 0.5 + 50 * 0.3 + 20 * 0.2)) < 1e-9);
    });
  });

  // ── Continuous SL multiplier / position size (v2.4) ───────────────────────

  describe('slMultiplierFromScore() / positionSizeFromScore() — continuous sizing', () => {
    const { slMultiplierFromScore, positionSizeFromScore } = require('../src/infrastructure/classification/PairClassifier');

    it('reproduces the old tier-boundary values at the same score points', () => {
      assert.ok(Math.abs(slMultiplierFromScore(0.40) - 1.0) < 1e-9);
      assert.ok(Math.abs(slMultiplierFromScore(0.85) - 1.5) < 1e-9);
      assert.ok(Math.abs(positionSizeFromScore(0.45) - 1.0) < 1e-9);
      assert.ok(Math.abs(positionSizeFromScore(0.85) - 0.55) < 1e-9);
    });

    it('interpolates smoothly with no jump around old tier boundaries (0.48/0.65/0.78)', () => {
      // Max slope of slMultiplierFromScore is 0.5/0.45 ≈ 1.111 per unit score,
      // so a ±eps window can move the output by at most ~2×eps×slope. Any
      // delta near that bound is smooth interpolation; a "jump" would be an
      // order of magnitude larger (the old step table jumped by 0.2 instantly).
      const eps = 0.005;
      const maxSlope = 0.5 / 0.45;
      for (const boundary of [0.48, 0.65, 0.78]) {
        const below = slMultiplierFromScore(boundary - eps);
        const above = slMultiplierFromScore(boundary + eps);
        assert.ok(Math.abs(above - below) <= 2 * eps * maxSlope + 1e-9, `jump at ${boundary}: ${below} -> ${above}`);
      }
    });

    it('clamps outside its domain (never below 1.0x / above 1.5x, never above 100% / below 55%)', () => {
      assert.equal(slMultiplierFromScore(0), 1.0);
      assert.equal(slMultiplierFromScore(1), 1.5);
      assert.equal(positionSizeFromScore(0), 1.0);
      assert.equal(positionSizeFromScore(1), 0.55);
    });
  });

  // ── Confidence score (v2.4) ────────────────────────────────────────────────

  describe('classify() confidence score', () => {
    it('candle-metrics path (Jalur 1) yields high confidence away from tier boundaries', () => {
      const pc = new PairClassifier();
      const metrics = { hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12, marketCapRank: 5, betaToBTC: 1.0 };
      const r = pc.classify('BTCUSDT', metrics);
      assert.equal(r.dataPath, 1);
      assert.ok(r.confidence >= 90, `confidence=${r.confidence}`);
    });

    it('CoinGecko path (Jalur 2) yields materially lower confidence than the candle path', () => {
      const pc = new PairClassifier();
      seedCoinData(pc, 'HYPE', { rank: 40, marketCap: 12e9, volume24h: 1.2e9, priceChange24h: 6.5 });
      const r = pc.classify('HYPEUSDT');
      assert.equal(r.dataPath, 2);
      assert.ok(r.confidence < 80, `confidence=${r.confidence}`);
      assert.ok(r.confidence > 0);
    });

    it('emergency static fallback (Jalur 3) yields the lowest confidence', () => {
      const pc = new PairClassifier();
      const r = pc.classify('UNKNOWNRANDOMCOINUSDT');
      assert.equal(r.dataPath, 3);
      assert.equal(r.confidence, 40);
    });

    it('a score sitting right on a tier boundary loses confidence vs. one comfortably inside a tier', () => {
      const pc = new PairClassifier();
      const onBoundary = pc.classify('BOUNDARYUSDT', {
        hv7: 66, hv14: 66, hv30: 66, atrPercent14: 2.86, liquidityRatio: 0.0486, marketCapRank: 10,
      });
      const midTier = pc.classify('MIDTIERUSDT', {
        hv7: 25, hv14: 25, hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12, marketCapRank: 5,
      });
      assert.ok(Math.abs(onBoundary.hybridScore - 0.48) <= 0.03, `expected score near 0.48, got ${onBoundary.hybridScore}`);
      assert.ok(onBoundary.confidence < midTier.confidence);
    });
  });

  // ── OHLCV rescue path — Jalur 2.5 (v2.4) ───────────────────────────────────

  describe('OHLCV rescue path (CoinGecko down, exchange candles available)', () => {
    it('uses self-computed ATR/HV instead of defaulting straight to VOLATILE', () => {
      const pc = new PairClassifier();
      // No CoinGecko data seeded (simulates an outage). Caller supplies only
      // what it can compute locally from OHLCV — no liquidityRatio (needs
      // market cap, which is unavailable offline).
      const metrics = { hv30: 30, atrPercent14: 1.1, marketCapRank: 3 };
      const r = pc.classify('RESCUEDCOINUSDT', metrics);
      assert.equal(r.dataPath, 2.5);
      // A liquid-looking coin (calm ATR/HV, top-3 rank) should NOT be forced
      // to VOLATILE just because liquidityRatio was unavailable.
      assert.notEqual(r.tier, PAIR_TIER.VOLATILE);
    });

    it('conservative liquidity estimate still allows a clearly-risky coin to read VOLATILE', () => {
      const pc = new PairClassifier();
      const metrics = { hv30: 110, atrPercent14: 5.5, marketCapRank: 250 };
      const r = pc.classify('RISKYRESCUEUSDT', metrics);
      assert.equal(r.dataPath, 2.5);
      assert.equal(r.tier, PAIR_TIER.VOLATILE);
    });

    it('falls through to Jalur 3 (static/VOLATILE) when there is truly no data at all', () => {
      const pc = new PairClassifier();
      const r = pc.classify('TRULYBLINDUSDT');
      assert.equal(r.dataPath, 3);
      assert.equal(r.tier, PAIR_TIER.VOLATILE);
    });

    it('confidence on the rescue path sits between the CoinGecko path and the static fallback', () => {
      const pc = new PairClassifier();
      const rescued = pc.classify('RESCUEDCOINUSDT', { hv30: 30, atrPercent14: 1.1, marketCapRank: 3 });
      const blind = pc.classify('TRULYBLINDUSDT');
      assert.ok(rescued.confidence > blind.confidence);
    });
  });

  // ── Confidence gate enforcement (v2.4 live safety net) ────────────────────

  describe('applyConfidenceGate()', () => {
    const { CONFIDENCE_GATE_MIN } = require('../src/infrastructure/classification/PairClassifier');

    it('high-confidence classification passes through unchanged (gated: false)', () => {
      const pc = new PairClassifier();
      const metrics = { hv30: 25, atrPercent14: 1.0, liquidityRatio: 0.12, marketCapRank: 5, betaToBTC: 1.0 };
      const raw = pc.classify('BTCUSDT', metrics);
      const gated = pc.applyConfidenceGate(raw);
      assert.equal(gated.gated, false);
      assert.equal(gated.tier, raw.tier);
      assert.equal(gated.paramOverrides.slMultiplier, raw.paramOverrides.slMultiplier);
      assert.equal(gated.paramOverrides.positionSizeAdjustment, raw.paramOverrides.positionSizeAdjustment);
    });

    it('low-confidence result gets more conservative sizing (wider SL, smaller size)', () => {
      const pc = new PairClassifier();
      const raw = pc.classify('SOMECOINUSDT', { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40 });
      // Force low confidence without depending on data-path internals.
      const lowConf = { ...raw, confidence: CONFIDENCE_GATE_MIN - 10 };
      const gated = pc.applyConfidenceGate(lowConf);
      assert.equal(gated.gated, true);
      assert.equal(gated.gatedFromTier, raw.tier);
      assert.ok(gated.paramOverrides.slMultiplier > raw.paramOverrides.slMultiplier);
      assert.ok(gated.paramOverrides.positionSizeAdjustment < raw.paramOverrides.positionSizeAdjustment);
      assert.equal(gated.paramOverrides.regimeFilterRequired, true);
      // Tier label stays the measured one — the gate changes risk, not belief.
      assert.equal(gated.tier, raw.tier);
    });

    it('gated discrete policy takes the STRICTER of current and bumped tier', () => {
      const pc = new PairClassifier();
      // STABLE-ish score → bump lands in SEMI_VOLATILE territory.
      const raw = pc.classify('SOMECOINUSDT', { hv30: 75, atrPercent14: 3.4, liquidityRatio: 0.03, marketCapRank: 50 });
      assert.equal(raw.tier, PAIR_TIER.STABLE);
      const gated = pc.applyConfidenceGate({ ...raw, confidence: 30 });
      // STABLE allows 8 trades/day, SEMI_VOLATILE 6 → gate takes 6.
      assert.ok(gated.paramOverrides.maxTradesPerDay <= 8);
      // Voting threshold takes the max (stricter consensus).
      assert.ok(gated.paramOverrides.votingThresholdOverride >= 0.60);
    });

    it('emergency-path result without a score still gets regime filter forced on', () => {
      const pc = new PairClassifier();
      const raw = pc.classify('BTCUSDT'); // Jalur 3: static LIQUID, no score, confidence 40
      assert.equal(raw.dataPath, 3);
      const gated = pc.applyConfidenceGate(raw);
      assert.equal(gated.gated, true);
      assert.equal(gated.paramOverrides.regimeFilterRequired, true);
      assert.equal(gated.tier, PAIR_TIER.LIQUID);
    });

    it('never loosens anything: gated params are ≥ conservative vs raw on every axis', () => {
      const pc = new PairClassifier();
      const raw = pc.classify('XCOINUSDT', { hv30: 95, atrPercent14: 4.8, liquidityRatio: 0.01, marketCapRank: 180, betaToBTC: 2.2 });
      const gated = pc.applyConfidenceGate({ ...raw, confidence: 10 });
      assert.ok(gated.paramOverrides.slMultiplier >= raw.paramOverrides.slMultiplier);
      assert.ok(gated.paramOverrides.positionSizeAdjustment <= raw.paramOverrides.positionSizeAdjustment);
      // Already at/near VOLATILE ceiling → clamps hold (sl ≤ 1.5, size ≥ 0.55).
      assert.ok(gated.paramOverrides.slMultiplier <= 1.5);
      assert.ok(gated.paramOverrides.positionSizeAdjustment >= 0.55);
    });
  });

  // ── Singleton export ──────────────────────────────────────────────────────

  it('pairClassifier singleton is an instance of PairClassifier', () => {
    assert.ok(pairClassifier instanceof PairClassifier);
  });

  // ── static tables ─────────────────────────────────────────────────────────

  it('LIQUID_PAIRS has at least 10 entries (emergency fallback)', () => {
    assert.ok(LIQUID_PAIRS.size >= 10);
  });

  it('VOLATILE_PAIRS is empty (v2.1: fully dynamic, no manual list)', () => {
    assert.equal(VOLATILE_PAIRS.size, 0);
  });

  it('VOLATILE_PAIRS and LIQUID_PAIRS are disjoint', () => {
    for (const sym of VOLATILE_PAIRS) {
      assert.ok(!LIQUID_PAIRS.has(sym), `${sym} found in both LIQUID and VOLATILE`);
    }
  });
});
