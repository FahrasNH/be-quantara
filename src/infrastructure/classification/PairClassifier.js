/**
 * PairClassifier.js  (src/infrastructure/classification/PairClassifier.js)
 *
 * PAIR-TIER-01 (AC-PAIR-01, AC-PAIR-02)
 *
 * Classifies a trading pair into one of three volatility tiers:
 *   LIQUID   — blue-chip, high-liquidity (BTC, ETH, SOL, BNB, XRP)
 *   STABLE   — mid-cap, moderate-volatility (AVAX, LINK, DOT, MATIC...)
 *   VOLATILE — high-volatility altcoins (WLD, HYPE, SUI, ENA, SEI...)
 *
 * NOTE: "pair tier" is distinct from the user's subscription tier
 * (FOUNDRY/FORGE/MINT/VAULT). Pair tier affects strategy param overrides
 * and which strategies are safe to run on that specific symbol.
 */

'use strict';

// ─── Pair Tier Constants ──────────────────────────────────────────────────────
const PAIR_TIER = Object.freeze({
  LIQUID:   'LIQUID',
  STABLE:   'STABLE',
  VOLATILE: 'VOLATILE',
});

// ─── Static Classification Tables ────────────────────────────────────────────
// LIQUID: top-10 by market cap, >$5B daily volume, institutional-grade liquidity.
const LIQUID_PAIRS = new Set([
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'TRXUSDT', 'LINKUSDT', 'LTCUSDT',
]);

// VOLATILE: altcoins with high beta, thin order books, wide spreads.
// Non-MR strategies are blocked on these pairs (AC-PAIR-04).
const VOLATILE_PAIRS = new Set([
  'WLDUSDT', 'HYPEUSDT', 'SUIUSDT', 'SEIUSDT', 'TIAUSDT',
  'INJUSDT', 'ENAUSDT', 'APEUSDT', 'GALAUSDT', 'ARBUSDT',
  'OPUSDT', 'STRKUSDT', 'JUPUSDT', 'RENDERUSDT', 'FETUSDT',
  'AGIXUSDT', 'WOOUSDT', 'GMXUSDT', 'DYDXUSDT', 'PERPUSDT',
]);

// Everything else → STABLE (mid-cap, moderate volatility)

// ─── Strategy Recommendations per Pair Tier ───────────────────────────────────
const STRATEGIES_BY_PAIR_TIER = Object.freeze({
  LIQUID: {
    recommended: ['ADAPTIVE_FUSION', 'TREND_MOMENTUM', 'MEAN_REVERSION'],
    cautious:    ['BREAKOUT_RETEST'],
    blocked:     [],
  },
  STABLE: {
    recommended: ['ADAPTIVE_FUSION', 'MEAN_REVERSION'],
    cautious:    ['TREND_MOMENTUM', 'BREAKOUT_RETEST'],
    blocked:     [],
  },
  VOLATILE: {
    // Only MR (with HTF filter) is allowed — it captures mean-reversion after
    // sharp moves. Trend-following strategies lose badly on thin-book altcoins.
    recommended: ['MEAN_REVERSION'],
    cautious:    [],
    blocked:     ['ADAPTIVE_FUSION', 'TREND_MOMENTUM', 'BREAKOUT_RETEST'],
  },
});

// ─── Param Overrides per Pair Tier ───────────────────────────────────────────
const PARAM_OVERRIDES = Object.freeze({
  LIQUID: {
    slMultiplier:            1.0,   // baseline SL width
    positionSizeAdjustment:  1.0,   // no reduction
    maxTradesPerDay:         null,  // unlimited
    dailyLossLimit:          null,  // no override
    regimeFilterRequired:    false, // optional for MR
    votingThresholdOverride: null,  // AF uses default (~0.50)
  },
  STABLE: {
    slMultiplier:            1.1,   // 10% wider SL (less liquid)
    positionSizeAdjustment:  0.9,   // 10% smaller position
    maxTradesPerDay:         8,
    dailyLossLimit:          null,
    regimeFilterRequired:    false,
    votingThresholdOverride: 0.55,  // AF needs stronger signal consensus
  },
  VOLATILE: {
    slMultiplier:            1.5,   // 50% wider SL (volatile moves)
    positionSizeAdjustment:  0.6,   // 40% smaller (risk management)
    maxTradesPerDay:         5,
    dailyLossLimit:          0.03,  // hard 3% daily loss cap
    regimeFilterRequired:    true,  // MUST pass HTF regime check
    votingThresholdOverride: 0.65,  // AF requires very strong consensus
  },
});

const RISK_LEVEL = Object.freeze({
  LIQUID:   'LOW',
  STABLE:   'MEDIUM',
  VOLATILE: 'HIGH',
});

// ─── PairClassifier ───────────────────────────────────────────────────────────
class PairClassifier {
  /**
   * Classify a symbol into LIQUID | STABLE | VOLATILE.
   * Falls back to STABLE for unknown symbols (safe default).
   * @param {string} symbol  e.g. "BTCUSDT", "WLDUSDT"
   * @returns {'LIQUID' | 'STABLE' | 'VOLATILE'}
   */
  determineTier(symbol) {
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (LIQUID_PAIRS.has(sym))   return PAIR_TIER.LIQUID;
    if (VOLATILE_PAIRS.has(sym)) return PAIR_TIER.VOLATILE;
    return PAIR_TIER.STABLE;
  }

  /**
   * Get strategy recommendations for a pair tier.
   * @param {'LIQUID'|'STABLE'|'VOLATILE'} tier
   * @returns {{ recommended: string[], cautious: string[], blocked: string[] }}
   */
  getStrategiesForTier(tier) {
    return STRATEGIES_BY_PAIR_TIER[tier] ?? STRATEGIES_BY_PAIR_TIER.STABLE;
  }

  /**
   * Get parameter overrides for a pair tier.
   * @param {'LIQUID'|'STABLE'|'VOLATILE'} tier
   * @returns {Object}
   */
  getParamOverridesForTier(tier) {
    return PARAM_OVERRIDES[tier] ?? PARAM_OVERRIDES.STABLE;
  }

  /**
   * Full classification result for a symbol.
   * @param {string} symbol
   * @returns {{
   *   tier: string,
   *   riskLevel: string,
   *   recommendedStrategies: string[],
   *   cautiousStrategies: string[],
   *   blockedStrategies: string[],
   *   paramOverrides: Object
   * }}
   */
  classify(symbol) {
    const tier = this.determineTier(symbol);
    const strategies = this.getStrategiesForTier(tier);
    const paramOverrides = this.getParamOverridesForTier(tier);
    return {
      tier,
      riskLevel:            RISK_LEVEL[tier],
      recommendedStrategies: strategies.recommended,
      cautiousStrategies:    strategies.cautious,
      blockedStrategies:     strategies.blocked,
      paramOverrides,
    };
  }

  /**
   * Whether a strategy is blocked for a given symbol.
   * @param {string} symbol
   * @param {string} strategyKey
   * @returns {boolean}
   */
  isStrategyBlocked(symbol, strategyKey) {
    const tier = this.determineTier(symbol);
    return STRATEGIES_BY_PAIR_TIER[tier].blocked.includes(strategyKey);
  }
}

// Singleton export (no state, so one instance is fine)
const pairClassifier = new PairClassifier();

module.exports = {
  PairClassifier,
  pairClassifier,
  PAIR_TIER,
  LIQUID_PAIRS,
  VOLATILE_PAIRS,
  STRATEGIES_BY_PAIR_TIER,
  PARAM_OVERRIDES,
  RISK_LEVEL,
};
