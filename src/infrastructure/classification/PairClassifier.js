/**
 * PairClassifier.js  (src/infrastructure/classification/PairClassifier.js)
 *
 * PAIR-TIER-01 (AC-PAIR-01, AC-PAIR-02)
 *
 * Classifies a trading pair into one of four volatility tiers (v2.3):
 *   LIQUID        — ultra blue-chip, high-liquidity (rank ≤ 12)
 *   STABLE        — mid-cap, moderate-volatility (rank 13–60)
 *   SEMI_VOLATILE — transisi (rank 61–150) [v2.3 baru]
 *   VOLATILE      — high-volatility altcoins (rank > 150 / unknown)
 *
 * NOTE: "pair tier" is distinct from the user's subscription tier
 * (FOUNDRY/FORGE/MINT/VAULT). Pair tier affects strategy param overrides
 * and which strategies are safe to run on that specific symbol.
 */

'use strict';

const https = require("https");

// ─── Pair Tier Constants ──────────────────────────────────────────────────────
// v2.3 spec (PAIR_VOLATILITY.md): tier SEMI_VOLATILE baru ditambahkan sebagai
// transisi halus antara STABLE dan VOLATILE (rank CoinGecko 61–150).
const PAIR_TIER = Object.freeze({
  LIQUID:        'LIQUID',
  STABLE:        'STABLE',
  SEMI_VOLATILE: 'SEMI_VOLATILE',
  VOLATILE:      'VOLATILE',
});

// Urutan tier dari paling aman → paling berisiko. Dipakai untuk "bump up 1 level"
// pada hybrid metric (ATR% 30-hari tinggi → naikkan tier). v2.3 spec.
const TIER_ORDER = Object.freeze([
  PAIR_TIER.LIQUID,
  PAIR_TIER.STABLE,
  PAIR_TIER.SEMI_VOLATILE,
  PAIR_TIER.VOLATILE,
]);

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
// v2.3 spec (PAIR_VOLATILITY.md §6): VOLATILE & SEMI_VOLATILE merekomendasikan
// MEAN_REVERSION + TREND_MOMENTUM (dengan regime filter ketat). ADAPTIVE_FUSION
// hanya diizinkan di LIQUID/STABLE (diblokir di SEMI_VOLATILE & VOLATILE).
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
  SEMI_VOLATILE: {
    // Transisi: TM diizinkan (dengan regime filter wajib), AF diblokir karena
    // voting-nya rentan over-trading di pair transisi. BR masih hati-hati.
    recommended: ['MEAN_REVERSION', 'TREND_MOMENTUM'],
    cautious:    ['BREAKOUT_RETEST'],
    blocked:     ['ADAPTIVE_FUSION'],
  },
  VOLATILE: {
    // MR + TM (dengan HTF regime filter ketat). AF & BR diblokir di altcoin
    // thin-book berisiko tinggi. v2.3: TM tidak lagi diblokir total — diizinkan
    // hanya jika lolos triple-EMA regime filter (regimeFilterRequired=true).
    recommended: ['MEAN_REVERSION', 'TREND_MOMENTUM'],
    cautious:    [],
    blocked:     ['ADAPTIVE_FUSION', 'BREAKOUT_RETEST'],
  },
});

// ─── Param Overrides per Pair Tier ───────────────────────────────────────────
// v2.3 spec (PAIR_VOLATILITY.md §"Override Parameter Risk (Diperketat)"):
// risk di-tighten lintas tier. CONFLICT NOTE: votingThresholdOverride VOLATILE —
// PAIR_VOLATILITY.md menulis 0.78, STRATEGIES.md §4 menulis 0.75. PairClassifier
// adalah sumber kebenaran runtime, jadi kita pakai nilai TER-KETAT 0.78.
// regimeFilterRequired = true untuk SEMUA tier kecuali LIQUID.
const PARAM_OVERRIDES = Object.freeze({
  LIQUID: {
    slMultiplier:            1.0,   // baseline SL width
    positionSizeAdjustment:  1.0,   // no reduction
    maxTradesPerDay:         null,  // unlimited
    dailyLossLimit:          null,  // no override
    regimeFilterRequired:    false, // optional for MR (satu-satunya tier tanpa regime filter)
    votingThresholdOverride: null,  // AF uses default
  },
  STABLE: {
    slMultiplier:            1.1,   // 10% wider SL (less liquid)
    positionSizeAdjustment:  0.95,  // 5% smaller position (v2.3: 0.9 → 0.95)
    maxTradesPerDay:         8,
    dailyLossLimit:          null,
    regimeFilterRequired:    true,  // v2.3: regime filter wajib untuk semua tier kecuali LIQUID
    votingThresholdOverride: 0.60,  // v2.3: 0.55 → 0.60 (AF needs stronger consensus)
  },
  SEMI_VOLATILE: {
    slMultiplier:            1.3,   // v2.3 tier transisi baru
    positionSizeAdjustment:  0.75,
    maxTradesPerDay:         6,
    dailyLossLimit:          0.025, // hard 2.5% daily loss cap
    regimeFilterRequired:    true,
    votingThresholdOverride: 0.70,  // AF tetap diblokir di tier ini; nilai disiapkan untuk MR/TM gating
  },
  VOLATILE: {
    slMultiplier:            1.5,   // 50% wider SL (volatile moves)
    positionSizeAdjustment:  0.55,  // v2.3: 0.6 → 0.55 (45% smaller, risk management)
    maxTradesPerDay:         4,     // v2.3: 5 → 4
    dailyLossLimit:          0.03,  // hard 3% daily loss cap
    regimeFilterRequired:    true,  // MUST pass HTF regime check
    votingThresholdOverride: 0.78,  // v2.3 (stricter of 0.78 vs 0.75) — single dissent blocks entry
  },
});

const RISK_LEVEL = Object.freeze({
  LIQUID:        'LOW',
  STABLE:        'MEDIUM',
  SEMI_VOLATILE: 'MEDIUM-HIGH',
  VOLATILE:      'HIGH',
});

// ─── Stablecoins to skip during dynamic classification ────────────────────────
const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "USDP", "GUSD", "FRAX", "USDD", "PYUSD", "FDUSD"]);

// ─── PairClassifier ───────────────────────────────────────────────────────────
class PairClassifier {
  constructor() {
    // Dynamic sets populated from CoinGecko — empty means "use static fallback".
    // Stored as BASE tickers (BTC, ETH, …), not BTCUSDT, so we can match exchange
    // symbols that carry leverage-token prefixes (1000BONK, 1000000BOB → BONK, BOB).
    // v2.3 spec: ambang rank lebih granular (≤12 / 13–60 / 61–150 / >150).
    this._dynamicLiquid       = new Set();  // market_cap_rank ≤ 12
    this._dynamicStable       = new Set();  // market_cap_rank 13–60
    this._dynamicSemiVolatile = new Set();  // market_cap_rank 61–150
    this._dynamicLastAt = null;
    // v2.3 spec: refresh tiap 2 jam (dari 4 jam) — masih hemat CoinGecko free tier (~12 calls/day).
    this._CACHE_TTL_MS = 2 * 60 * 60 * 1000;
  }

  /**
   * Extract the underlying asset from an exchange symbol — strips the quote
   * (USDT/USDC/BUSD) and Binance leverage-token multipliers so the result lines
   * up with CoinGecko base tickers. "1000BONKUSDT" → "BONK", "BTCUSDT" → "BTC".
   */
  _baseOf(symbol) {
    let s = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    s = s.replace(/(USDT|USDC|BUSD)$/, "");
    s = s.replace(/^(1000000|100000|10000|1000|1M)/, "");
    return s;
  }

  /**
   * Fetch coin market data from CoinGecko and update dynamic tier sets.
   * v2.3 spec (PAIR_VOLATILITY.md §3) — ambang rank lebih granular:
   *   Rank ≤ 12 (non-stablecoin) → LIQUID
   *   Rank 13–60   → STABLE
   *   Rank 61–150  → SEMI_VOLATILE
   *   Rank > 150 atau tidak ada → VOLATILE (fail-safe)
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
            const newLiquid       = new Set();
            const newStable       = new Set();
            const newSemiVolatile = new Set();
            for (const coin of coins) {
              const sym = (coin.symbol || "").toUpperCase();
              if (!sym || STABLECOINS.has(sym)) continue;
              const rank = coin.market_cap_rank ?? 9999;
              // v2.3 spec: ≤12 LIQUID · 13–60 STABLE · 61–150 SEMI_VOLATILE · >150 VOLATILE
              if (rank <= 12)        newLiquid.add(sym);        // ultra blue-chip
              else if (rank <= 60)   newStable.add(sym);        // mid-cap stabil
              else if (rank <= 150)  newSemiVolatile.add(sym);  // transisi
              // rank > 150 (and the whole long tail not returned) → VOLATILE by default
            }
            this._dynamicLiquid       = newLiquid;
            this._dynamicStable       = newStable;
            this._dynamicSemiVolatile = newSemiVolatile;
            this._dynamicLastAt = Date.now();
            console.log(`[PairClassifier] Dynamic refresh OK — ${newLiquid.size} LIQUID (≤12), ${newStable.size} STABLE (13–60), ${newSemiVolatile.size} SEMI_VOLATILE (61–150); all other pairs → VOLATILE (CoinGecko market cap)`);
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
   * Bump a tier up by one level toward VOLATILE (e.g. STABLE → SEMI_VOLATILE,
   * SEMI_VOLATILE → VOLATILE). v2.3 hybrid-metric helper.
   * @param {string} tier
   * @returns {string} tier satu level lebih berisiko (atau VOLATILE bila sudah puncak)
   */
  _bumpTierUp(tier) {
    const idx = TIER_ORDER.indexOf(tier);
    if (idx < 0) return PAIR_TIER.VOLATILE;
    return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)];
  }

  /**
   * Apply v2.3 hybrid-metric adjustments on top of the base (market-cap) tier.
   *
   * INTEGRATION POINT (PAIR_VOLATILITY.md §"Tambahan Hybrid Metric"):
   *   - ATR% 30-hari > 4.5%  → naikkan tier 1 level (STABLE → SEMI_VOLATILE → VOLATILE).
   *   - Liquidity score (24h volume) di bawah threshold → paksa VOLATILE.
   *
   * Data ATR%/volume TIDAK di-fetch di modul ini (PairClassifier hanya tahu
   * market-cap rank dari CoinGecko). Mekanisme ini adalah HOOK terstruktur &
   * testable: caller (BotEngine / MarketSnapshotService yang sudah punya OHLCV)
   * boleh menyuplai metrics; bila tidak ada, tier dasar dikembalikan apa adanya.
   *
   * @param {string} baseTier
   * @param {Object} [metrics]
   * @param {number} [metrics.atrPct30d]   - ATR% historis 30-hari (mis. 5.2 = 5.2%)
   * @param {boolean} [metrics.lowLiquidity] - true bila 24h volume < threshold
   * @param {number} [metrics.volume24h]    - opsional; dibandingkan minVolume24h
   * @param {number} [metrics.minVolume24h] - threshold likuiditas (default 0 = nonaktif)
   * @returns {string} tier setelah penyesuaian hybrid
   */
  applyHybridMetrics(baseTier, metrics = null) {
    if (!metrics) return baseTier;
    let tier = baseTier;

    // ATR% 30-hari > 4.5% → naikkan tier 1 level (volatilitas riil tinggi).
    if (typeof metrics.atrPct30d === 'number' && metrics.atrPct30d > 4.5) {
      tier = this._bumpTierUp(tier);
    }

    // Likuiditas rendah → paksa VOLATILE (fail-safe untuk thin order book).
    const lowLiq = metrics.lowLiquidity === true
      || (typeof metrics.volume24h === 'number'
          && typeof metrics.minVolume24h === 'number'
          && metrics.minVolume24h > 0
          && metrics.volume24h < metrics.minVolume24h);
    if (lowLiq) tier = PAIR_TIER.VOLATILE;

    return tier;
  }

  /**
   * Classify a symbol into LIQUID | STABLE | SEMI_VOLATILE | VOLATILE.
   * Uses dynamic CoinGecko data if available, otherwise static fallback.
   * Optional `metrics` apply v2.3 hybrid adjustments (ATR%/liquidity).
   * @param {string} symbol  e.g. "BTCUSDT", "WLDUSDT"
   * @param {Object} [metrics] - lihat applyHybridMetrics()
   * @returns {'LIQUID' | 'STABLE' | 'SEMI_VOLATILE' | 'VOLATILE'}
   */
  determineTier(symbol, metrics = null) {
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const base = this._baseTier(sym);
    return this.applyHybridMetrics(base, metrics);
  }

  /**
   * Base tier from market-cap data only (no hybrid metric).
   * @param {string} sym - already normalised (uppercase, alnum)
   * @returns {string}
   */
  _baseTier(sym) {
    // Dynamic path — authoritative CoinGecko market-cap data is loaded.
    // v2.3: rank ≤12 LIQUID · 13–60 STABLE · 61–150 SEMI_VOLATILE · everything
    // else (the long tail of small/new alts off CoinGecko's top-150) → VOLATILE.
    // This is the safe default the old code got backwards (it defaulted unknowns
    // to STABLE, so microcaps wrongly got loose risk + all strategies).
    if (this._dynamicLiquid.size > 0 || this._dynamicStable.size > 0 || this._dynamicSemiVolatile.size > 0) {
      const base = this._baseOf(sym);
      if (this._dynamicLiquid.has(base))       return PAIR_TIER.LIQUID;
      if (this._dynamicStable.has(base))       return PAIR_TIER.STABLE;
      if (this._dynamicSemiVolatile.has(base)) return PAIR_TIER.SEMI_VOLATILE;
      return PAIR_TIER.VOLATILE;
    }
    // Static fallback (CoinGecko unreachable) — curated lists, conservative STABLE default.
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
  classify(symbol, metrics = null) {
    const tier = this.determineTier(symbol, metrics);
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
  isStrategyBlocked(symbol, strategyKey, metrics = null) {
    const tier = this.determineTier(symbol, metrics);
    return this.getStrategiesForTier(tier).blocked.includes(strategyKey);
  }
}

// Singleton export (no state, so one instance is fine)
const pairClassifier = new PairClassifier();

module.exports = {
  PairClassifier,
  pairClassifier,
  PAIR_TIER,
  TIER_ORDER,
  LIQUID_PAIRS,
  VOLATILE_PAIRS,
  STRATEGIES_BY_PAIR_TIER,
  PARAM_OVERRIDES,
  RISK_LEVEL,
};
