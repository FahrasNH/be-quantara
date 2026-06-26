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
  computeHybridScore,
  tierFromHybridScore,
  calculateHybridVolatilityScore,
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

    it('WLDUSDT returns correct VOLATILE classification (v2.3)', () => {
      const r = pairClassifier.classify('WLDUSDT');
      assert.equal(r.tier, 'VOLATILE');
      assert.equal(r.riskLevel, 'HIGH');
      // v2.3: VOLATILE merekomendasikan MEAN_REVERSION + TREND_MOMENTUM (regime filter ketat)
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.ok(r.recommendedStrategies.includes('TREND_MOMENTUM'));
      assert.equal(r.recommendedStrategies.length, 2);
      // v2.3: AF & BR diblokir; TM TIDAK lagi diblokir (diizinkan dengan regime filter)
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.blockedStrategies.includes('BREAKOUT_RETEST'));
      assert.ok(!r.blockedStrategies.includes('TREND_MOMENTUM'));
      assert.equal(r.paramOverrides.slMultiplier, 1.5);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.55);
      assert.equal(r.paramOverrides.maxTradesPerDay, 4);
      assert.equal(r.paramOverrides.dailyLossLimit, 0.03);
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.78);
    });

    it('AVAXUSDT returns correct STABLE classification (v2.3)', () => {
      const r = pairClassifier.classify('AVAXUSDT');
      assert.equal(r.tier, 'STABLE');
      assert.equal(r.riskLevel, 'MEDIUM');
      assert.ok(r.recommendedStrategies.includes('ADAPTIVE_FUSION'));
      assert.ok(r.recommendedStrategies.includes('MEAN_REVERSION'));
      assert.deepEqual(r.blockedStrategies, []);
      assert.equal(r.paramOverrides.slMultiplier, 1.1);
      assert.equal(r.paramOverrides.positionSizeAdjustment, 0.95);
      assert.equal(r.paramOverrides.maxTradesPerDay, 8);
      assert.equal(r.paramOverrides.dailyLossLimit, null);
      // v2.3: regime filter wajib untuk semua tier kecuali LIQUID
      assert.equal(r.paramOverrides.regimeFilterRequired, true);
      assert.equal(r.paramOverrides.votingThresholdOverride, 0.60);
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
    it('TREND_MOMENTUM NOT blocked on HYPEUSDT (v2.3: allowed with regime filter)', () => {
      assert.equal(pairClassifier.isStrategyBlocked('HYPEUSDT', 'TREND_MOMENTUM'), false);
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
    it('STABLE has slMultiplier 1.1 and votingThresholdOverride 0.60 (v2.3)', () => {
      assert.equal(PARAM_OVERRIDES.STABLE.slMultiplier, 1.1);
      assert.equal(PARAM_OVERRIDES.STABLE.votingThresholdOverride, 0.60);
    });
    it('SEMI_VOLATILE (v2.3) has slMultiplier 1.3 and dailyLossLimit 0.025', () => {
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

  // ── Hybrid Volatility Score (v2.0) ────────────────────────────────────────

  describe('calculateHybridVolatilityScore() — v2.0 thresholds', () => {
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

  describe('determineTier() — hybrid score path (v2.0)', () => {
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

  // ── SEMI_VOLATILE dynamic tier (fallback rank) ────────────────────────────

  describe('dynamic SEMI_VOLATILE tier (v2.3)', () => {
    it('rank 61–150 base ticker classifies as SEMI_VOLATILE', () => {
      const pc = new PairClassifier();
      pc._dynamicSemiVolatile = new Set(['FOO']);
      assert.equal(pc.determineTier('FOOUSDT'), PAIR_TIER.SEMI_VOLATILE);
      const r = pc.classify('FOOUSDT');
      assert.equal(r.tier, 'SEMI_VOLATILE');
      assert.equal(r.riskLevel, 'HIGH-MED');
      assert.ok(r.blockedStrategies.includes('ADAPTIVE_FUSION'));
    });

    it('hybrid metric: ATR% 30d > 4.5% bumps STABLE → SEMI_VOLATILE', () => {
      const pc = new PairClassifier();
      pc._dynamicStable = new Set(['BAR']);
      assert.equal(pc.determineTier('BARUSDT'), PAIR_TIER.STABLE);
      assert.equal(pc.determineTier('BARUSDT', { atrPct30d: 5.0 }), PAIR_TIER.SEMI_VOLATILE);
    });

    it('hybrid metric: low liquidity forces VOLATILE', () => {
      const pc = new PairClassifier();
      pc._dynamicLiquid = new Set(['BAZ']);
      assert.equal(pc.determineTier('BAZUSDT'), PAIR_TIER.LIQUID);
      assert.equal(pc.determineTier('BAZUSDT', { lowLiquidity: true }), PAIR_TIER.VOLATILE);
    });

    it('hybrid metric: volume24h < minVolume24h forces VOLATILE (wired path)', () => {
      const pc = new PairClassifier();
      pc._dynamicLiquid = new Set(['QUX']);
      // Likuiditas tipis: volume24h < threshold → paksa VOLATILE meski base LIQUID.
      assert.equal(
        pc.determineTier('QUXUSDT', { volume24h: 500_000, minVolume24h: 2_000_000 }),
        PAIR_TIER.VOLATILE,
      );
      // Likuiditas cukup → tetap di tier dasar.
      assert.equal(
        pc.determineTier('QUXUSDT', { volume24h: 50_000_000, minVolume24h: 2_000_000 }),
        PAIR_TIER.LIQUID,
      );
    });

    it('hybrid metric: full classify() honors ATR bump + propagates overrides', () => {
      const pc = new PairClassifier();
      pc._dynamicStable = new Set(['QZ']);
      const base = pc.classify('QZUSDT');
      assert.equal(base.tier, PAIR_TIER.STABLE);
      const bumped = pc.classify('QZUSDT', { atrPct30d: 6.0 });
      assert.equal(bumped.tier, PAIR_TIER.SEMI_VOLATILE);
      // Override paramnya ikut tier hasil bump (SL diperlebar, AF diblokir).
      assert.ok(bumped.paramOverrides.slMultiplier > base.paramOverrides.slMultiplier);
      assert.ok(bumped.blockedStrategies.includes('ADAPTIVE_FUSION'));
    });

    it('hybrid metric: backward-compatible — no metrics & ATR ≤ 4.5% = no bump', () => {
      const pc = new PairClassifier();
      pc._dynamicStable = new Set(['NB']);
      assert.equal(pc.determineTier('NBUSDT'), PAIR_TIER.STABLE);          // no metrics
      assert.equal(pc.determineTier('NBUSDT', null), PAIR_TIER.STABLE);     // explicit null
      assert.equal(pc.determineTier('NBUSDT', { atrPct30d: 4.5 }), PAIR_TIER.STABLE); // boundary, not >
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
