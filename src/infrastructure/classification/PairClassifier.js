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

const https = require("https");

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

// ─── Stablecoins to skip during dynamic classification ────────────────────────
const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "USDP", "GUSD", "FRAX", "USDD", "PYUSD", "FDUSD"]);

// ─── PairClassifier ───────────────────────────────────────────────────────────
class PairClassifier {
  constructor() {
    // Dynamic sets populated from CoinGecko — empty means "use static fallback"
    this._dynamicLiquid   = new Set();
    this._dynamicVolatile = new Set();
    this._dynamicLastAt   = null;
    // 4-hour refresh interval (don't hammer CoinGecko free tier: ~6 calls/day)
    this._CACHE_TTL_MS = 4 * 60 * 60 * 1000;
  }

  /**
   * Fetch coin market data from CoinGecko and update dynamic tier sets.
   * Rank ≤ 15 (non-stablecoin) → LIQUID
   * Rank 16–100  → STABLE
   * Rank > 100   → VOLATILE
   * Falls back to static tables silently on error.
   */
  async refreshDynamic() {
    return new Promise((resolve) => {
      const url = "https://api.coingecko.com/api/v3/coins/markets"
        + "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1";
      const req = https.get(url, { headers: { "Accept": "application/json", "User-Agent": "Quantara-Bot/1.0" } }, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              console.warn(`[PairClassifier] CoinGecko returned ${res.statusCode} — using static tables`);
              return resolve(false);
            }
            const coins = JSON.parse(body);
            const newLiquid   = new Set();
            const newVolatile = new Set();
            for (const coin of coins) {
              const sym = (coin.symbol || "").toUpperCase();
              if (STABLECOINS.has(sym)) continue;
              const rank = coin.market_cap_rank ?? 9999;
              const binanceSym = `${sym}USDT`;
              if (rank <= 15)       newLiquid.add(binanceSym);
              else if (rank > 100)  newVolatile.add(binanceSym);
              // rank 16-100 → STABLE (default, no set needed)
            }
            this._dynamicLiquid   = newLiquid;
            this._dynamicVolatile = newVolatile;
            this._dynamicLastAt   = Date.now();
            console.log(`[PairClassifier] Dynamic refresh OK — ${newLiquid.size} LIQUID, ${newVolatile.size} VOLATILE (CoinGecko top-250)`);
            resolve(true);
          } catch (e) {
            console.warn("[PairClassifier] CoinGecko parse error:", e.message, "— using static tables");
            resolve(false);
          }
        });
      });
      req.on("error", (e) => {
        console.warn("[PairClassifier] CoinGecko fetch error:", e.message, "— using static tables");
        resolve(false);
      });
      req.setTimeout(10_000, () => {
        req.destroy();
        console.warn("[PairClassifier] CoinGecko timeout — using static tables");
        resolve(false);
      });
    });
  }

  /**
   * Classify a symbol into LIQUID | STABLE | VOLATILE.
   * Uses dynamic CoinGecko data if available, otherwise static fallback.
   * Falls back to STABLE for unknown symbols (safe default).
   * @param {string} symbol  e.g. "BTCUSDT", "WLDUSDT"
   * @returns {'LIQUID' | 'STABLE' | 'VOLATILE'}
   */
  determineTier(symbol) {
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Use dynamic data if populated (CoinGecko refresh succeeded)
    if (this._dynamicLiquid.size > 0) {
      if (this._dynamicLiquid.has(sym))   return PAIR_TIER.LIQUID;
      if (this._dynamicVolatile.has(sym)) return PAIR_TIER.VOLATILE;
      // If dynamic data loaded but sym not in either set → STABLE (rank 16-100)
      // BUT: fall back to static for explicitly known VOLATILE (safety net while dynamic warms up)
      if (VOLATILE_PAIRS.has(sym)) return PAIR_TIER.VOLATILE;
      return PAIR_TIER.STABLE;
    }
    // Static fallback
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
