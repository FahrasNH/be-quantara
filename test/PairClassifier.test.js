'use strict';
/**
 * PairClassifier.test.js  (test/PairClassifier.test.js)
 *
 * PAIR-TIER-04 — Unit tests for PairClassifier
 *
 * Coverage:
 *  - determineTier() on 25+ symbols across all three tiers
 *  - classify() full output (tier, riskLevel, strategies, paramOverrides)
 *  - isStrategyBlocked() for VOLATILE pair restrictions
 *  - paramOverrides correctness per tier
 *  - Unknown symbol falls back to STABLE
 *  - Strategy blocking rules
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
} = require('../src/infrastructure/classification/PairClassifier');

describe('PairClassifier', () => {
  // ── determineTier ─────────────────────────────────────────────────────────

  describe('determineTier() — LIQUID pairs', () => {
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

  describe('determineTier() — VOLATILE pairs', () => {
    const volatilePairs = [
      'WLDUSDT', 'HYPEUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT',
      'INJUSDT', 'ENAUSDT', 'APEUSDT', 'ARBUSDT', 'OPUSDT',
      'STRKUSDT', 'JUPUSDT', 'RENDERUSDT', 'FETUSDT', 'GMXUSDT',
    ];
    for (const sym of volatilePairs) {
      it(`classifies ${sym} as VOLATILE`, () => {
        assert.equal(pairClassifier.determineTier(sym), PAIR_TIER.VOLATILE);
      });
    }
  });

  describe('determineTier() — STABLE pairs (mid-cap / unknown)', () => {
    it('classifies AVAXUSDT as STABLE', () => {
      assert.equal(pairClassifier.determineTier('AVAXUSDT'), PAIR_TIER.STABLE);
    });
    it('classifies MATICUSDT as STABLE', () => {
      assert.equal(pairClassifier.determineTier('MATICUSDT'), PAIR_TIER.STABLE);
    });
    it('classifies DOTUSDT as STABLE', () => {
      assert.equal(pairClassifier.determineTier('DOTUSDT'), PAIR_TIER.STABLE);
    });
    it('classifies an unknown symbol as STABLE (safe default)', () => {
      assert.equal(pairClassifier.determineTier('UNKNOWNUSDT'), PAIR_TIER.STABLE);
    });
    it('classifies an empty symbol as STABLE', () => {
      assert.equal(pairClassifier.determineTier(''), PAIR_TIER.STABLE);
    });
    it('classifies null/undefined as STABLE without throwing', () => {
      assert.equal(pairClassifier.determineTier(null), PAIR_TIER.STABLE);
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

    it('WLDUSDT returns correct VOLATILE classification', () => {
      const r = pairClassifier.classify('WLDUSDT');
      assert.equal(r.tier, 'VOLATILE');
      assert.equal(r.riskLevel, 'HIGH');
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.equal(r.recommendedStrategies.length, 1);
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.blockedStrategies.includes('TREND_MOMENTUM'));
      assert.ok(r.blockedStrategies.includes('BREAKOUT_RETEST'));
      assert.equal(r.paramOverrides.slMultiplier, 1.5);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.6);
      assert.equal(r.paramOverrides.maxTradesPerDay, 5);
      assert.equal(r.paramOverrides.dailyLossLimit, 0.03);
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.65);
    });

    it('AVAXUSDT returns correct STABLE classification', () => {
      const r = pairClassifier.classify('AVAXUSDT');
      assert.equal(r.tier, 'STABLE');
      assert.equal(r.riskLevel, 'MEDIUM');
      assert.ok(r.recommendedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.deepEqual(r.blockedStrategies, []);
      assert.equal(r.paramOverrides.slMultiplier, 1.1);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.9);
      assert.equal(r.paramOverrides.maxTradesPerDay, 8);
      assert.equal(r.paramOverrides.dailyLossLimit, null);
      assert.equal(r.paramOverrides.regimeFilterRequired, false);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.55);
    });

    it('HYPEUSDT returns VOLATILE classification', () => {
      const r = pairClassifier.classify('HYPEUSDT');
      assert.equal(r.tier, 'VOLATILE');
    });

    it('SUIUSDT returns VOLATILE classification', () => {
      const r = pairClassifier.classify('SUIUSDT');
      assert.equal(r.tier, 'VOLATILE');
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
    it('ADAPTIVE_FUSION IS blocked on WLDUSDT', () => {
      assert.equal(pairClassifier.isStrategyBlocked('WLDUSDT', 'ADAPTIVE_FUSION'), true);
    });
    it('TREND_MOMENTUM IS blocked on HYPEUSDT', () => {
      assert.equal(pairClassifier.isStrategyBlocked('HYPEUSDT', 'TREND_MOMENTUM'), true);
    });
    it('BREAKOUT_RETEST IS blocked on SUIUSDT', () => {
      assert.equal(pairClassifier.isStrategyBlocked('SUIUSDT', 'BREAKOUT_RETEST'), true);
    });
    it('MEAN_REVERSION NOT blocked on WLDUSDT', () => {
      assert.equal(pairClassifier.isStrategyBlocked('WLDUSDT', 'MEAN_REVERSION'), false);
    });
    it('TREND_MOMENTUM NOT blocked on ETHUSDT (LIQUID)', () => {
      assert.equal(pairClassifier.isStrategyBlocked('ETHUSDT', 'TREND_MOMENTUM'), false);
    });
    it('ADAPTIVE_FUSION NOT blocked on AVAXUSDT (STABLE)', () => {
      assert.equal(pairClassifier.isStrategyBlocked('AVAXUSDT', 'ADAPTIVE_FUSION'), false);
    });
  });

  // ── PARAM_OVERRIDES constants ─────────────────────────────────────────────

  describe('PARAM_OVERRIDES constants', () => {
    it('LIQUID has slMultiplier 1.0 and no daily loss limit', () => {
      assert.equal(PARAM_OVERRIDES.LIQUID.slMultiplier, 1.0);
      assert.equal(PARAM_OVERRIDES.LIQUID.dailyLossLimit, null);
      assert.equal(PARAM_OVERRIDES.LIQUID.regimeFilterRequired, false);
    });
    it('STABLE has slMultiplier 1.1 and votingThresholdOverride 0.55', () => {
      assert.equal(PARAM_OVERRIDES.STABLE.slMultiplier, 1.1);
      assert.equal(PARAM_OVERRIDES.STABLE.votingThresholdOverride, 0.55);
    });
    it('VOLATILE has slMultiplier 1.5 and regimeFilterRequired true', () => {
      assert.equal(PARAM_OVERRIDES.VOLATILE.slMultiplier, 1.5);
      assert.equal(PARAM_OVERRIDES.VOLATILE.regimeFilterRequired, true);
      assert.equal(PARAM_OVERRIDES.VOLATILE.dailyLossLimit, 0.03);
    });
  });

  // ── Singleton export ──────────────────────────────────────────────────────

  it('pairClassifier singleton is an instance of PairClassifier', () => {
    assert.ok(pairClassifier instanceof PairClassifier);
  });

  // ── static tables ─────────────────────────────────────────────────────────

  it('LIQUID_PAIRS has at least 10 entries', () => {
    assert.ok(LIQUID_PAIRS.size >= 10);
  });

  it('VOLATILE_PAIRS has at least 20 entries', () => {
    assert.ok(VOLATILE_PAIRS.size >= 20);
  });

  it('VOLATILE_PAIRS and LIQUID_PAIRS are disjoint', () => {
    for (const sym of VOLATILE_PAIRS) {
      assert.ok(!LIQUID_PAIRS.has(sym), `${sym} found in both LIQUID and VOLATILE`);
    }
  });
});
