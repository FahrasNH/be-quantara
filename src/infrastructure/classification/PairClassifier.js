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
 * Primary path (PAIR_VOLATILITY.md v2.4 — dynamic ATR review): Hybrid
 * Volatility Score dari HV7/HV14/HV30 blend + ATR%14 + liquidityRatio +
 * CONTINUOUS penalties (beta/rank/ATR-extreme — no step-function jumps).
 * SL multiplier & position size are now continuous functions of the score,
 * not fixed per-tier steps (see ATR_AND_PAIR_TIER_GUIDE.md §4.1).
 * Secondary: CoinGecko real-time data (volume, market cap, 24h range proxy).
 * Rescue path: OHLCV self-computed ATR/HV/volume when CoinGecko is down but
 * exchange candles are available (see PAIR_VOLATILITY.md §"Emergency Fallback").
 * Emergency fallback (both CoinGecko AND candles unavailable): static LIQUID
 * table only, confidence 40.
 * Every classification carries a `confidence` (0-100) reflecting data path,
 * completeness, and freshness — see computeConfidence().
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
// MEAN_REVERSION + TREND_FOLLOWING (dengan regime filter ketat). ADAPTIVE_FUSION
// hanya diizinkan di LIQUID/STABLE (diblokir di SEMI_VOLATILE & VOLATILE).
const STRATEGIES_BY_PAIR_TIER = Object.freeze({
  LIQUID: {
    recommended: ['ADAPTIVE_FUSION', 'TREND_FOLLOWING', 'MEAN_REVERSION'],
    cautious:    ['BREAKOUT_RETEST'],
    blocked:     [],
  },
  STABLE: {
    recommended: ['ADAPTIVE_FUSION', 'MEAN_REVERSION'],
    cautious:    ['TREND_FOLLOWING', 'BREAKOUT_RETEST'],
    blocked:     [],
  },
  SEMI_VOLATILE: {
    // Transisi: TM diizinkan (dengan regime filter wajib), AF diblokir karena
    // voting-nya rentan over-trading di pair transisi. BR masih hati-hati.
    recommended: ['MEAN_REVERSION', 'TREND_FOLLOWING'],
    cautious:    ['BREAKOUT_RETEST'],
    blocked:     ['ADAPTIVE_FUSION'],
  },
  VOLATILE: {
    // MR + TM (dengan HTF regime filter ketat). AF & BR diblokir di altcoin
    // thin-book berisiko tinggi. v2.3: TM tidak lagi diblokir total — diizinkan
    // hanya jika lolos triple-EMA regime filter (regimeFilterRequired=true).
    recommended: ['MEAN_REVERSION', 'TREND_FOLLOWING'],
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

// ─── Continuous risk sizing (score-based, replaces fixed per-tier steps) ─────
// v2.4 dynamic-ATR review (ATR_AND_PAIR_TIER_GUIDE.md §4.1): two coins scored
// 0.64 and 0.67 are nearly identical risk, yet the old step table jumped SL
// 1.1×→1.3× and size 95%→75% between them. These functions reproduce the same
// tier-boundary values (continuity check) but interpolate smoothly in between.

/**
 * SL multiplier as a continuous function of the hybrid volatility score.
 * Linear ramp 1.0× (score ≤ 0.40) → 1.5× (score ≥ 0.85).
 * @param {number} score - hybrid volatility score [0,1]
 * @returns {number}
 */
function slMultiplierFromScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 1.0;
  return 1.0 + 0.5 * clamp01((score - 0.40) / 0.45);
}

/**
 * Position size adjustment as a continuous function of the hybrid volatility score.
 * Linear ramp 1.0 (score ≤ 0.45) → 0.55 (score ≥ 0.85).
 * @param {number} score - hybrid volatility score [0,1]
 * @returns {number}
 */
function positionSizeFromScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 1.0;
  return 1.0 - 0.45 * clamp01((score - 0.45) / 0.40);
}

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
 * Blend HV7/HV14/HV30 into a single responsive-yet-stable volatility figure.
 * HV30 alone lags ~3 weeks behind a real regime shift (a coin can spend that
 * whole window still classified "calm" while it's actually re-rating). The
 * blend weights HV7 heaviest for fast detection, HV30 lightest as an anchor
 * so a single wild day can't flip a blue-chip's tier.
 * @param {number} [hv7]
 * @param {number} [hv14]
 * @param {number} [hv30]
 * @returns {number|undefined}
 */
function blendHV(hv7, hv14, hv30) {
  const parts = [];
  if (typeof hv7 === 'number')  parts.push([hv7, 0.5]);
  if (typeof hv14 === 'number') parts.push([hv14, 0.3]);
  if (typeof hv30 === 'number') parts.push([hv30, 0.2]);
  if (!parts.length) return undefined;
  const wSum = parts.reduce((s, [, w]) => s + w, 0);
  return parts.reduce((s, [v, w]) => s + v * w, 0) / wSum;
}

/** Clamp x to [0, 1]. */
function clamp01(x) {
  return Math.min(Math.max(x, 0), 1);
}

/**
 * Continuous beta penalty (linear ramp, replaces step "beta > 1.8 → +0.08").
 * Beta 1.0 (moves with BTC) → 0. Beta ≥ 2.5 → saturates at +0.08.
 * @param {number} [betaToBTC]
 * @returns {number}
 */
function betaPenalty(betaToBTC) {
  if (typeof betaToBTC !== 'number' || !Number.isFinite(betaToBTC)) return 0;
  return 0.08 * clamp01((betaToBTC - 1.0) / 1.5);
}

/**
 * Continuous market-cap-rank penalty (log scaling, replaces step "rank > 150 → +0.10").
 * Log scale because liquidity thins out exponentially with rank, not linearly —
 * the risk delta from rank 50→100 is much larger than 250→300.
 * @param {number} [marketCapRank]
 * @returns {number}
 */
function rankPenalty(marketCapRank) {
  if (typeof marketCapRank !== 'number' || !Number.isFinite(marketCapRank) || marketCapRank <= 50) return 0;
  return 0.10 * clamp01(Math.log10(marketCapRank / 50) / Math.log10(6));
}

/**
 * Continuous ATR%30d penalty (replaces step "ATR30 > 4.5% → bump 1 tier").
 * ≤3.5% → 0. ≥6.5% → saturates at +0.15 (roughly one tier's worth).
 * @param {number} [atrPct30d]
 * @returns {number}
 */
function atrExtremePenalty(atrPct30d) {
  if (typeof atrPct30d !== 'number' || !Number.isFinite(atrPct30d)) return 0;
  return 0.15 * clamp01((atrPct30d - 3.5) / 3.0);
}

/**
 * Hitung Hybrid Volatility Score (0.0–1.0).
 * @param {Object} data
 * @param {number} [data.hv7]
 * @param {number} [data.hv14]
 * @param {number} [data.hv30]
 * @param {number} [data.atrPercent14]
 * @param {number} [data.atrPct30d] - untuk continuous extreme-volatility penalty
 * @param {number} [data.liquidityRatio]
 * @param {number} [data.marketCapRank]
 * @param {number} [data.betaToBTC]
 * @returns {number}
 */
function computeHybridScore(data = {}) {
  const { hv7, hv14, hv30, atrPercent14, atrPct30d, liquidityRatio, marketCapRank, betaToBTC } = data;
  const hvBlend  = blendHV(hv7, hv14, hv30) ?? hv30;
  const hvScore  = normalize(hvBlend, 20, 120);
  const atrScore = normalize(atrPercent14, 0.5, 6.0);
  const liqScore = normalizeInverted(liquidityRatio, 0.001, 0.15);

  let score = (hvScore * 0.40) + (atrScore * 0.35) + (liqScore * 0.25);

  score += betaPenalty(betaToBTC);
  score += rankPenalty(marketCapRank);
  // atrPct30d is a DISTINCT signal from atrPercent14 (already weighted above at
  // 35%) — a realized 30-day extreme-volatility flag, not the current-bar
  // ATR%. Only apply when explicitly supplied; falling back to atrPercent14
  // would double-count the same number through two penalty paths.
  score += atrExtremePenalty(atrPct30d);

  return clamp01(score);
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
                // v2.4: real 24h range (not just net displacement) for a more
                // honest ATR proxy — see _buildCoinGeckoHybridData().
                high24h:        coin.high_24h ?? null,
                low24h:         coin.low_24h ?? null,
                currentPrice:   coin.current_price ?? null,
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
   * @returns {{ coinId: string, marketCap: number, volume24h: number, marketCapRank: number, priceChange24h: number|null, high24h: number|null, low24h: number|null, currentPrice: number|null }|null}
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
      high24h:         data.high24h,
      low24h:          data.low24h,
      currentPrice:    data.currentPrice,
    };
  }

  /**
   * Build hybrid-score inputs from CoinGecko data when candle metrics unavailable.
   * v2.4: prefers the REAL 24h high/low range over net price-change displacement
   * — a coin can whipsaw 5% up and down repeatedly and close +0.2%, which the old
   * "|24h change| × 1.2 + 0.8" proxy misread as calm. Falls back to displacement
   * only when range data is missing, and reports `proxied: true` so callers can
   * dock confidence instead of pretending the estimate is precise.
   * @param {string} sym - normalised symbol
   * @returns {Object|null}
   */
  _buildCoinGeckoHybridData(sym) {
    const cg = this.getCoinGeckoMarketData(sym);
    if (!cg?.marketCap || !cg.volume24h) return null;

    const liquidityRatio = cg.volume24h / cg.marketCap;
    let atrProxy, hvProxy, proxied = true, proxyBasis;

    if (cg.high24h != null && cg.low24h != null && cg.currentPrice > 0) {
      // Range-based: true 24h range as % of price, discounted ~0.7 because a
      // full day's range typically overshoots a smoothed 14-period ATR.
      const rangePct = ((cg.high24h - cg.low24h) / cg.currentPrice) * 100;
      atrProxy = Math.max(0.5, Math.min(6.0, rangePct * 0.7));
      hvProxy  = Math.max(20, Math.min(120, rangePct * 5 + 25));
      proxyBasis = 'range';
    } else {
      // Displacement-only fallback — a lower bound on volatility, not a
      // faithful ATR estimate. Confidence must reflect that (see computeConfidence).
      const absChange = Math.abs(cg.priceChange24h ?? 0);
      atrProxy = Math.max(0.5, Math.min(6.0, absChange * 1.2 + 0.8));
      hvProxy  = Math.max(20, Math.min(120, absChange * 8 + 30));
      proxyBasis = 'displacement';
    }

    return {
      hv30:           hvProxy,
      atrPercent14:   atrProxy,
      liquidityRatio,
      marketCapRank:  cg.marketCapRank,
      _proxied:       proxied,
      _proxyBasis:    proxyBasis,
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
      hv7:            metrics.hv7,
      hv14:           metrics.hv14,
      hv30:           metrics.hv30,
      atrPercent14,
      atrPct30d:      metrics.atrPct30d,
      liquidityRatio,
      marketCapRank:  metrics.marketCapRank ?? this.getMarketCapRank(base),
      betaToBTC:      metrics.betaToBTC,
    };
  }

  /**
   * Apply v2.4 hybrid-metric adjustments on top of the base (score-derived) tier.
   *
   * INTEGRATION POINT (PAIR_VOLATILITY.md §"Tambahan Hybrid Metric"):
   *   - ATR% 30-hari ekstrem → sudah tercermin sebagai CONTINUOUS penalty di
   *     dalam computeHybridScore() (atrExtremePenalty), BUKAN lompatan tier
   *     diskrit di sini lagi (v2.3 lama: "ATR30 > 4.5% → naikkan 1 level" —
   *     dibuang karena coin di 4.49% vs 4.51% tidak boleh beda 1 tier penuh).
   *   - Liquidity score (24h volume) di bawah threshold → paksa VOLATILE. Ini
   *     TETAP diskrit dengan sengaja: order book tipis adalah risiko
   *     keselamatan (slippage tak terukur), bukan gradasi yang perlu dihaluskan.
   *
   * Data ATR%/volume TIDAK di-fetch di modul ini (PairClassifier hanya tahu
   * market-cap rank dari CoinGecko). Mekanisme ini adalah HOOK terstruktur &
   * testable: caller (BotEngine / MarketSnapshotService yang sudah punya OHLCV)
   * boleh menyuplai metrics; bila tidak ada, tier dasar dikembalikan apa adanya.
   *
   * @param {string} baseTier
   * @param {Object} [metrics]
   * @param {boolean} [metrics.lowLiquidity] - true bila 24h volume < threshold
   * @param {number} [metrics.volume24h]    - opsional; dibandingkan minVolume24h
   * @param {number} [metrics.minVolume24h] - threshold likuiditas (default 0 = nonaktif)
   * @returns {string} tier setelah penyesuaian hybrid
   */
  applyHybridMetrics(baseTier, metrics = null) {
    if (!metrics) return baseTier;
    let tier = baseTier;

    // Likuiditas rendah → paksa VOLATILE (fail-safe untuk thin order book).
    // Satu-satunya aturan diskrit yang sengaja dipertahankan — lihat catatan di atas.
    const lowLiq = metrics.lowLiquidity === true
      || (typeof metrics.volume24h === 'number'
          && typeof metrics.minVolume24h === 'number'
          && metrics.minVolume24h > 0
          && metrics.volume24h < metrics.minVolume24h);
    if (lowLiq) tier = PAIR_TIER.VOLATILE;

    return tier;
  }

  /**
   * True if metrics carry SOME candle-derived signal (ATR and/or HV) even
   * without a full liquidity ratio — enough for the v2.4 OHLCV rescue path
   * (Jalur 2.5) when CoinGecko is unreachable but the bot already holds
   * exchange candles for this symbol.
   * @param {Object|null} metrics
   * @returns {boolean}
   */
  _hasPartialCandleData(metrics) {
    if (!metrics) return false;
    return typeof (metrics.atrPercent14 ?? metrics.atrPct30d ?? metrics.hv7 ?? metrics.hv14 ?? metrics.hv30) === 'number';
  }

  /**
   * Build hybrid-score inputs from self-computed OHLCV metrics when CoinGecko
   * is down (Jalur 2.5 — "OHLCV rescue", PAIR_VOLATILITY.md §"Emergency Fallback").
   * A CoinGecko outage must NOT force every symbol to VOLATILE if the bot is
   * already holding candles for it: ATR/HV can be computed locally, only the
   * true liquidityRatio (needs market cap) is unavailable. We substitute a
   * DELIBERATELY CONSERVATIVE low liquidity estimate rather than assuming the
   * pair is as liquid as a blue-chip — this only ever pushes the score toward
   * more caution, never less.
   * @param {string} sym
   * @param {Object} metrics
   * @returns {Object}
   */
  _buildOhlcvRescueData(sym, metrics) {
    const atrPercent14 = metrics.atrPercent14 ?? metrics.atrPct30d;
    const base = this._baseOf(sym);
    // No market cap available offline → assume thin liquidity (conservative
    // low-end of the normalize range) unless the caller explicitly knows better.
    const liquidityRatio = metrics.liquidityRatio ?? 0.01;
    return {
      hv7:            metrics.hv7,
      hv14:           metrics.hv14,
      hv30:           metrics.hv30,
      atrPercent14,
      atrPct30d:      metrics.atrPct30d,
      liquidityRatio,
      marketCapRank:  metrics.marketCapRank ?? this.getMarketCapRank(base),
      betaToBTC:      metrics.betaToBTC,
      _rescued:       true,
      _liquidityIsEstimate: metrics.liquidityRatio == null,
    };
  }

  /**
   * Full internal classification: tier + score + which data path was used +
   * whatever the doc's confidence model needs. `determineTier()`/`classify()`
   * are thin wrappers around this so both stay backward-compatible.
   * @param {string} symbol
   * @param {Object} [metrics]
   * @returns {{ tier: string, score: number|null, path: 1|2|2.5|3, proxyBasis: string|null, liquidityIsEstimate: boolean }}
   */
  _classifyWithPath(symbol, metrics = null) {
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    // Jalur 1 (PRIMARY): full hybrid score from candle metrics supplied by caller
    // (HV7/14/30 blend + ATR%14 + real liquidity ratio).
    if (this._hasHybridInputs(metrics)) {
      const hybridData = this._resolveHybridData(sym, metrics);
      const score = computeHybridScore(hybridData);
      if (metrics.lowLiquidity === true) {
        return { tier: PAIR_TIER.VOLATILE, score, path: 1, proxyBasis: null, liquidityIsEstimate: false };
      }
      const tier = this.applyHybridMetrics(tierFromHybridScore(score), metrics);
      return { tier, score, path: 1, proxyBasis: null, liquidityIsEstimate: false };
    }

    // Jalur 2 (SECONDARY): CoinGecko real-time hybrid (real liquidity, proxied HV/ATR).
    const cgHybrid = this._buildCoinGeckoHybridData(sym);
    if (cgHybrid) {
      const score = computeHybridScore(cgHybrid);
      const tier = metrics ? this.applyHybridMetrics(tierFromHybridScore(score), metrics) : tierFromHybridScore(score);
      return { tier, score, path: 2, proxyBasis: cgHybrid._proxyBasis, liquidityIsEstimate: false };
    }

    // Jalur 2.5 (OHLCV RESCUE): CoinGecko unreachable, but caller already has
    // exchange candles for this symbol — compute what we can instead of
    // defaulting straight to VOLATILE.
    if (this._hasPartialCandleData(metrics)) {
      const rescueData = this._buildOhlcvRescueData(sym, metrics);
      const score = computeHybridScore(rescueData);
      if (metrics.lowLiquidity === true) {
        return { tier: PAIR_TIER.VOLATILE, score, path: 2.5, proxyBasis: 'ohlcv-rescue', liquidityIsEstimate: rescueData._liquidityIsEstimate };
      }
      const tier = this.applyHybridMetrics(tierFromHybridScore(score), metrics);
      return { tier, score, path: 2.5, proxyBasis: 'ohlcv-rescue', liquidityIsEstimate: rescueData._liquidityIsEstimate };
    }

    // Jalur 3 (EMERGENCY): genuinely blind — no CoinGecko, no candles. Static
    // table only; unknown symbols fail safe to VOLATILE.
    let tier = this._staticFallbackTier(sym);
    if (metrics) tier = this.applyHybridMetrics(tier, metrics);
    return { tier, score: null, path: 3, proxyBasis: null, liquidityIsEstimate: false };
  }

  /**
   * Classify a symbol into LIQUID | STABLE | SEMI_VOLATILE | VOLATILE.
   * Uses dynamic CoinGecko data if available, otherwise static fallback.
   * Optional `metrics` apply v2.4 hybrid adjustments (ATR%/liquidity) and,
   * when CoinGecko is unreachable, feed the OHLCV rescue path (Jalur 2.5).
   * @param {string} symbol  e.g. "BTCUSDT", "WLDUSDT"
   * @param {Object} [metrics] - lihat applyHybridMetrics()
   * @returns {'LIQUID' | 'STABLE' | 'SEMI_VOLATILE' | 'VOLATILE'}
   */
  determineTier(symbol, metrics = null) {
    return this._classifyWithPath(symbol, metrics).tier;
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
   * Confidence (0-100) that a classification reflects reality, per
   * ATR_AND_PAIR_TIER_GUIDE.md §2.4: basis by data path, minus penalties for
   * proxied metrics, stale CoinGecko cache, and scores sitting right on a
   * tier boundary (where a tiny data wobble would flip the tier).
   * @param {{ score: number|null, path: 1|2|2.5|3, proxyBasis: string|null, liquidityIsEstimate: boolean }} classResult
   * @returns {number}
   */
  computeConfidence(classResult) {
    const { score, path, proxyBasis, liquidityIsEstimate } = classResult;
    const BASIS = { 1: 95, 2: 70, 2.5: 55, 3: 40 };
    let confidence = BASIS[path] ?? 40;

    if (path === 2) {
      // HV/ATR are always proxied on this path; a range-based proxy is a
      // reasonably faithful single estimate (-10), a displacement-only proxy
      // is weaker because it can't see intra-day whipsaws (-20).
      confidence -= proxyBasis === 'range' ? 10 : 20;
      const isStale = this._dynamicLastAt != null && (Date.now() - this._dynamicLastAt) > this._CACHE_TTL_MS;
      if (isStale) confidence -= 5;
    } else if (path === 2.5 && liquidityIsEstimate) {
      // ATR/HV are real (self-computed from OHLCV); only liquidity is guessed.
      confidence -= 10;
    }

    if (typeof score === 'number') {
      const thresholds = [0.48, 0.65, 0.78];
      const nearBoundary = thresholds.some((t) => Math.abs(score - t) <= 0.03);
      if (nearBoundary) confidence -= 10;
    }

    return Math.round(clamp01(confidence / 100) * 100);
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
   *
   * `paramOverrides.slMultiplier` and `.positionSizeAdjustment` are now
   * CONTINUOUS functions of the hybrid score (ATR_AND_PAIR_TIER_GUIDE.md
   * §4.1) whenever a score is available — smoothly interpolated instead of
   * jumping at tier boundaries. The discrete per-tier table
   * (maxTradesPerDay/dailyLossLimit/regimeFilterRequired/votingThresholdOverride)
   * is kept as-is; those are policy steps, not magnitudes.
   *
   * @param {string} symbol
   * @returns {{
   *   tier: string,
   *   riskLevel: string,
   *   confidence: number,
   *   dataPath: 1|2|2.5|3,
   *   recommendedStrategies: string[],
   *   cautiousStrategies: string[],
   *   blockedStrategies: string[],
   *   paramOverrides: Object
   * }}
   */
  classify(symbol, metrics = null) {
    const sym = (symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const classResult = this._classifyWithPath(sym, metrics);
    const { tier, score, path } = classResult;
    const strategies = this.getStrategiesForTier(tier);
    const tierOverrides = this.getParamOverridesForTier(tier);
    const paramOverrides = {
      ...tierOverrides,
      // Continuous sizing takes precedence over the tier-step defaults when
      // we actually have a score to interpolate from.
      slMultiplier:           typeof score === 'number' ? slMultiplierFromScore(score) : tierOverrides.slMultiplier,
      positionSizeAdjustment: typeof score === 'number' ? positionSizeFromScore(score) : tierOverrides.positionSizeAdjustment,
    };
    const result = {
      tier,
      riskLevel:            RISK_LEVEL[tier],
      confidence:           this.computeConfidence(classResult),
      dataPath:             path,
      recommendedStrategies: strategies.recommended,
      cautiousStrategies:    strategies.cautious,
      blockedStrategies:     strategies.blocked,
      paramOverrides,
    };
    if (typeof score === 'number') result.hybridScore = score;
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
  blendHV,
  betaPenalty,
  rankPenalty,
  atrExtremePenalty,
  slMultiplierFromScore,
  positionSizeFromScore,
};
