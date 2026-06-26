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
      assert.ok(r.recommendedStrategies.includes('TREND_MOMENTUM'));
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.deepEqual(r.blockedStrategies, []);
      assert.equal(r.paramOverrides.slMultiplier, 1.0);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 1.0);
      assert.equal(r.paramOverrides.maxTradesPerDay, null);
      assert.equal(r.paramOverrides.regimeFilterRequired, false);
      assert.equal(r.paramOverrides.votingThresholdOverride, null);
    });

    it('WLDUSDT with hybrid metrics → SEMI_VOLATILE (v2.1)', () => {
      const metrics = {
        hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015,
        marketCapRank: 120, betaToBTC: 1.5,
      };
      const r = pairClassifier.classify('WLDUSDT', metrics);
      assert.equal(r.tier, 'SEMI_VOLATILE');
      assert.equal(r.riskLevel, 'HIGH-MED');
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.ok(r.recommendedStrategies.includes('TREND_MOMENTUM'));
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      assert.equal(r.paramOverrides.slMultiplier, 1.3);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.75);
    });

    it('AVAXUSDT with hybrid metrics → STABLE (v2.1)', () => {
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
      assert.equal(r.paramOverrides.slMultiplier, 1.1);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.95);
      assert.equal(r.paramOverrides.maxTradesPerDay, 8);
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.60);
    });

    it('HYPEUSDT with hybrid metrics → SEMI_VOLATILE (v2.1 doc example)', () => {
      const metrics = {
        hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015,
        marketCapRank: 80, betaToBTC: 1.5,
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
      assert.ok(r.recommendedStrategies.includes('TREND_MOMENTUM'));
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
    it('TREND_MOMENTUM NOT blocked on HYPEUSDT with semi-volatile metrics', () => {
      const metrics = { hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 80 };
      assert.equal(pairClassifier.isStrategyBlocked('HYPEUSDT', 'TREND_MOMENTUM', metrics), false);
    });
    it('BREAKOUT_RETEST IS blocked on thin microcap', () => {
      const metrics = { hv30: 110, atrPercent14: 5.5, liquidityRatio: 0.002, marketCapRank: 200 };
      assert.equal(pairClassifier.isStrategyBlocked('SUIUSDT', 'BREAKOUT_RETEST', metrics), true);
    });
    it('MEAN_REVERSION NOT blocked on WLDUSDT with semi-volatile metrics', () => {
      const metrics = { hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 120 };
      assert.equal(pairClassifier.isStrategyBlocked('WLDUSDT', 'MEAN_REVERSION', metrics), false);
    });
    it('TREND_MOMENTUM NOT blocked on ETHUSDT (LIQUID)', () => {
      assert.equal(pairClassifier.isStrategyBlocked('ETHUSDT', 'TREND_MOMENTUM'), false);
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
      hv30: 90, atrPercent14: 4.5, liquidityRatio: 0.015, marketCapRank: 120, betaToBTC: 1.5,
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

    it('betaToBTC > 1.8 adds +0.08 to score', () => {
      const base = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 80, betaToBTC: 1.0 };
      const bumped = { ...base, betaToBTC: 2.0 };
      assert.ok(computeHybridScore(bumped) - computeHybridScore(base) >= 0.07);
    });

    it('marketCapRank > 150 adds +0.10 to score', () => {
      const base = { hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 100, betaToBTC: 1.0 };
      const bumped = { ...base, marketCapRank: 200 };
      assert.ok(computeHybridScore(bumped) - computeHybridScore(base) >= 0.09);
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

    it('hybrid metric: ATR% 30d > 4.5% bumps STABLE → SEMI_VOLATILE', () => {
      const pc = new PairClassifier();
      const stableMetrics = {
        hv30: 70, atrPercent14: 3.0, liquidityRatio: 0.04, marketCapRank: 40,
      };
      assert.equal(pc.determineTier('BARUSDT', stableMetrics), PAIR_TIER.STABLE);
      assert.equal(pc.determineTier('BARUSDT', { ...stableMetrics, atrPct30d: 5.0 }), PAIR_TIER.SEMI_VOLATILE);
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
