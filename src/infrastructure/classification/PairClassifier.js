/**
 * PairClassifier.js  (src/infrastructure/classification/PairClassifier.js)
 *
 * PAIR-TIER-01 (AC-PAIR-01, AC-PAIR-02)
 *
 * Classifies a trading pair into one of four volatility tiers (v2.0 Hybrid):
 *   LIQUID        — score < 0.48  (blue-chip, likuiditas tinggi)
 *   STABLE        — score 0.48–0.65
 *   SEMI_VOLATILE — score 0.66–0.78 (WLD, HYPE, ENA, TAO, …)
 *   VOLATILE      — score > 0.78
 *
 * Primary path (PAIR_VOLATILITY.md v2.1): Hybrid Volatility Score dari
 * HV30 + ATR%14 + liquidityRatio + soft adjustment rank/beta.
 * Secondary: CoinGecko real-time data (volume, market cap, 24h change proxy).
 * Emergency fallback bila CoinGecko unreachable: static LIQUID table saja.
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

// Emergency-only fallback when CoinGecko is unreachable (v2.1: no manual volatile list).
const VOLATILE_PAIRS = new Set([]);

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
  SEMI_VOLATILE: 'HIGH-MED',
  VOLATILE:      'HIGH',
});

// ─── Hybrid Volatility Score (PAIR_VOLATILITY.md v2.0 §2) ───────────────────
/** Normalisasi linear ke [0, 1]; nilai di luar range di-clamp. */
function normalize(value, min, max) {
  if (value == null || !Number.isFinite(value) || max <= min) return 0.5;
  return Math.min(Math.max((value - min) / (max - min), 0), 1);
}

/** Semakin rendah liquidityRatio → skor semakin tinggi (lebih berbahaya). */
function normalizeInverted(value, min, max) {
  return 1 - normalize(value, min, max);
}

/**
 * Hitung Hybrid Volatility Score (0.0–1.0).
 * @param {Object} data
 * @param {number} [data.hv30]
 * @param {number} [data.atrPercent14]
 * @param {number} [data.liquidityRatio]
 * @param {number} [data.marketCapRank]
 * @param {number} [data.betaToBTC]
 * @returns {number}
 */
function computeHybridScore(data = {}) {
  const { hv30, atrPercent14, liquidityRatio, marketCapRank, betaToBTC } = data;
  const hvScore  = normalize(hv30, 20, 120);
  const atrScore = normalize(atrPercent14, 0.5, 6.0);
  const liqScore = normalizeInverted(liquidityRatio, 0.001, 0.15);

  let score = (hvScore * 0.40) + (atrScore * 0.35) + (liqScore * 0.25);

  if (typeof betaToBTC === 'number' && betaToBTC > 1.8) score += 0.08;
  if (typeof marketCapRank === 'number' && marketCapRank > 150) score += 0.10;

  return Math.min(Math.max(score, 0), 1);
}

/**
 * Map hybrid score ke tier string.
 * @param {number} score
 * @returns {string}
 */
function tierFromHybridScore(score) {
  if (score > 0.78) return PAIR_TIER.VOLATILE;
  if (score > 0.65) return PAIR_TIER.SEMI_VOLATILE;
  if (score > 0.48) return PAIR_TIER.STABLE;
  return PAIR_TIER.LIQUID;
}

/**
 * Menghitung Hybrid Volatility Score → tier (sumber kebenaran PAIR_VOLATILITY.md).
 * @param {Object} data
 * @returns {string}
 */
function calculateHybridVolatilityScore(data) {
  return tierFromHybridScore(computeHybridScore(data));
}

// ─── Stablecoins to skip during dynamic classification ────────────────────────
const STABLECOINS = new Set(["USDT", "USDC", "BUSD", "DAI", "TUSD", "USDP", "GUSD", "FRAX", "USDD", "PYUSD", "FDUSD"]);

// ─── PairClassifier ───────────────────────────────────────────────────────────
class PairClassifier {
  constructor() {
    // CoinGecko real-time market data keyed by base ticker (BTC, HYPE, …).
    // Populated by refreshDynamic(); drives v2.1 hybrid score without manual lists.
    this._dynamicCoinData = new Map(); // base → { id, marketCap, volume24h, rank, priceChange24h }
    this._dynamicRankMap  = new Map(); // base ticker → market_cap_rank (soft adjustment)
    this._dynamicLastAt   = null;
    // Refresh tiap 2 jam — hemat CoinGecko free tier (~12 calls/day).
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
   * Fetch top-250 coin market data from CoinGecko for v2.1 hybrid classification.
   * Stores marketCap, volume24h, rank per base ticker — no manual tier lists.
   * Falls back to static LIQUID table silently on error.
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
            const newCoinData = new Map();
            const newRankMap  = new Map();
            for (const coin of coins) {
              const sym = (coin.symbol || "").toUpperCase();
              if (!sym || STABLECOINS.has(sym)) continue;
              const rank = coin.market_cap_rank ?? 9999;
              newRankMap.set(sym, rank);
              newCoinData.set(sym, {
                id:             coin.id,
                marketCap:      coin.market_cap ?? null,
                volume24h:      coin.total_volume ?? null,
                rank,
                priceChange24h: coin.price_change_percentage_24h ?? null,
              });
            }
            this._dynamicCoinData = newCoinData;
            this._dynamicRankMap  = newRankMap;
            this._dynamicLastAt   = Date.now();
            console.log(`[PairClassifier] Dynamic refresh OK — ${newCoinData.size} coins loaded from CoinGecko (hybrid v2.1)`);
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
   * Real-time CoinGecko market data for a symbol (from last refreshDynamic()).
   * @param {string} symbol
   * @returns {{ coinId: string, marketCap: number, volume24h: number, marketCapRank: number, priceChange24h: number|null }|null}
   */
  getCoinGeckoMarketData(symbol) {
    const base = this._baseOf(symbol);
    const data = this._dynamicCoinData.get(base);
    if (!data) return null;
    return {
      coinId:          data.id,
      marketCap:       data.marketCap,
      volume24h:       data.volume24h,
      marketCapRank:   data.rank,
      priceChange24h:  data.priceChange24h,
    };
  }

  /**
   * Build hybrid-score inputs from CoinGecko data when candle metrics unavailable.
   * Uses 24h price change as HV/ATR proxy (v2.1 real-API path).
   * @param {string} sym - normalised symbol
   * @returns {Object|null}
   */
  _buildCoinGeckoHybridData(sym) {
    const cg = this.getCoinGeckoMarketData(sym);
    if (!cg?.marketCap || !cg.volume24h) return null;

    const liquidityRatio = cg.volume24h / cg.marketCap;
    const absChange = Math.abs(cg.priceChange24h ?? 0);
    // Proxy HV/ATR from 24h volatility when 30-day candles not yet fetched.
    const atrProxy = Math.max(0.5, Math.min(6.0, absChange * 1.2 + 0.8));
    const hvProxy  = Math.max(20, Math.min(120, absChange * 8 + 30));

    return {
      hv30:           hvProxy,
      atrPercent14:   atrProxy,
      liquidityRatio,
      marketCapRank:  cg.marketCapRank,
    };
  }

  /**
   * Ambil market cap rank CoinGecko untuk base ticker (fallback hybrid adjustment).
   * @param {string} baseOrSymbol
   * @returns {number|null}
   */
  getMarketCapRank(baseOrSymbol) {
    const base = this._baseOf(baseOrSymbol);
    if (this._dynamicRankMap.has(base)) return this._dynamicRankMap.get(base);
    return null;
  }

  /**
   * Apakah metrics cukup untuk jalur hybrid score v2.0?
   * @param {Object|null} metrics
   * @returns {boolean}
   */
  _hasHybridInputs(metrics) {
    if (!metrics) return false;
    const hasAtr = typeof (metrics.atrPercent14 ?? metrics.atrPct30d) === 'number';
    const hasLiq = typeof metrics.liquidityRatio === 'number'
      || (typeof metrics.volume24h === 'number' && typeof metrics.marketCap === 'number' && metrics.marketCap > 0);
    return hasAtr && hasLiq;
  }

  /**
   * Susun input hybrid score dari metrics + rank map internal.
   * @param {string} sym
   * @param {Object} metrics
   * @returns {Object}
   */
  _resolveHybridData(sym, metrics) {
    const atrPercent14 = metrics.atrPercent14 ?? metrics.atrPct30d;
    let liquidityRatio = metrics.liquidityRatio;
    if (liquidityRatio == null && metrics.volume24h > 0 && metrics.marketCap > 0) {
      liquidityRatio = metrics.volume24h / metrics.marketCap;
    }
    const base = this._baseOf(sym);
    return {
      hv30:           metrics.hv30,
      atrPercent14,
      liquidityRatio,
      marketCapRank:  metrics.marketCapRank ?? this.getMarketCapRank(base),
      betaToBTC:      metrics.betaToBTC,
    };
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

    // v2.1 primary: full hybrid score from candle metrics (HV30 + ATR%14 + liquidity).
    if (this._hasHybridInputs(metrics)) {
      const hybridData = this._resolveHybridData(sym, metrics);
      let tier = calculateHybridVolatilityScore(hybridData);
      if (metrics.lowLiquidity === true) return PAIR_TIER.VOLATILE;
      tier = this.applyHybridMetrics(tier, metrics);
      return tier;
    }

    // v2.1 secondary: CoinGecko real-time hybrid (volume, market cap, 24h change proxy).
    const cgHybrid = this._buildCoinGeckoHybridData(sym);
    if (cgHybrid) {
      let tier = calculateHybridVolatilityScore(cgHybrid);
      if (metrics) tier = this.applyHybridMetrics(tier, metrics);
      return tier;
    }

    // Emergency: static table when CoinGecko unreachable.
    let tier = this._staticFallbackTier(sym);
    if (metrics) tier = this.applyHybridMetrics(tier, metrics);
    return tier;
  }

  /**
   * Emergency tier when CoinGecko data unavailable (offline / unknown symbol).
   * @param {string} sym - already normalised (uppercase, alnum)
   * @returns {string}
   */
  _staticFallbackTier(sym) {
    if (LIQUID_PAIRS.has(sym))   return PAIR_TIER.LIQUID;
    if (VOLATILE_PAIRS.has(sym)) return PAIR_TIER.VOLATILE;
    return PAIR_TIER.VOLATILE; // conservative fail-safe for unknown symbols
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
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const tier = this.determineTier(sym, metrics);
    const strategies = this.getStrategiesForTier(tier);
    const paramOverrides = this.getParamOverridesForTier(tier);
    const result = {
      tier,
      riskLevel:            RISK_LEVEL[tier],
      recommendedStrategies: strategies.recommended,
      cautiousStrategies:    strategies.cautious,
      blockedStrategies:     strategies.blocked,
      paramOverrides,
    };
    if (this._hasHybridInputs(metrics)) {
      result.hybridScore = computeHybridScore(this._resolveHybridData(sym, metrics));
    } else {
      const cgHybrid = this._buildCoinGeckoHybridData(sym);
      if (cgHybrid) result.hybridScore = computeHybridScore(cgHybrid);
    }
    return result;
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
  normalize,
  normalizeInverted,
  computeHybridScore,
  tierFromHybridScore,
  calculateHybridVolatilityScore,
};
