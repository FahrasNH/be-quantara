/**
 * RegimeClassifierEngine.js — Sprint 2 / RC-1
 *
 * Production-grade regime classifier that synthesises EMA alignment, ADX trend
 * strength, ATR volatility percentile, and volume momentum into a composite
 * regime label used throughout the analytics pipeline.
 *
 * Primary regimes  : trend_up | trend_down | ranging
 * Modifiers        : expansion | compression | high_vol | low_vol
 * Composite output : e.g. "trend_up+expansion", "ranging+low_vol"
 * Multi-TF         : HTF (4h/1d) + MTF (1h) + LTF (15m) per symbol
 *
 * Design:
 *  - sync classify() — deterministic, no I/O
 *  - In-memory Map cache, 1-hour TTL per `${symbol}:${timeframe}` key
 *  - All inputs are scalar numbers (already extracted by callers)
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const PRIMARY = Object.freeze({
  TREND_UP:   "trend_up",
  TREND_DOWN: "trend_down",
  RANGING:    "ranging",
});

const MODIFIER = Object.freeze({
  EXPANSION:   "expansion",
  COMPRESSION: "compression",
  HIGH_VOL:    "high_vol",
  LOW_VOL:     "low_vol",
});

// ─────────────────────────────────────────────────────────────────────────────
// RegimeClassifierEngine
// ─────────────────────────────────────────────────────────────────────────────

class RegimeClassifierEngine {
  constructor() {
    // Map<cacheKey, { result, expiresAt }>
    this._cache = new Map();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Classify a single timeframe.
   *
   * @param {object} indicators
   *   {
   *     ema9  : number,  // last valid EMA9
   *     ema21 : number,  // last valid EMA21
   *     ema50 : number,  // last valid EMA50
   *     adx   : number,  // last valid ADX (optional)
   *     atr   : number,  // current ATR value
   *     atrAvg: number,  // rolling 20-period ATR average
   *     volume: number,  // current bar volume
   *     volAvg: number,  // 20-period volume SMA
   *   }
   * @param {string} symbol     — e.g. "BTCUSDT"
   * @param {string} timeframe  — e.g. "4h", "1h", "15m"
   * @returns {{ primary, modifier, composite, confidence }}
   */
  classify(indicators, symbol, timeframe) {
    const cacheKey = `${symbol}:${timeframe}`;
    const cached = this.getCache(symbol, timeframe);
    if (cached) return cached;

    const result = this._classify(indicators);

    // Store in cache
    this._cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return result;
  }

  /**
   * Classify across three timeframes and derive a dominant regime.
   *
   * @param {object} htfIndicators — HTF (4h/1d) indicators
   * @param {object} mtfIndicators — MTF (1h) indicators
   * @param {object} ltfIndicators — LTF (15m) indicators
   * @param {string} symbol
   * @returns {{ htf, mtf, ltf, dominant }}
   */
  classifyMultiTF(htfIndicators, mtfIndicators, ltfIndicators, symbol) {
    const htf = this.classify(htfIndicators, symbol, "4h");
    const mtf = this.classify(mtfIndicators, symbol, "1h");
    const ltf = this.classify(ltfIndicators, symbol, "15m");

    const dominant = this._deriveDominant(htf, mtf, ltf);

    return { htf, mtf, ltf, dominant };
  }

  /**
   * Invalidate all cache entries for a symbol.
   * @param {string} symbol
   */
  invalidateCache(symbol) {
    for (const key of this._cache.keys()) {
      if (key.startsWith(`${symbol}:`)) {
        this._cache.delete(key);
      }
    }
  }

  /**
   * Return cached result or null (also evicts if expired).
   * @param {string} symbol
   * @param {string} timeframe
   * @returns {object|null}
   */
  getCache(symbol, timeframe) {
    const cacheKey = `${symbol}:${timeframe}`;
    const entry = this._cache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(cacheKey);
      return null;
    }
    return entry.result;
  }

  // ── Internal classification ────────────────────────────────────────────────

  _classify(indicators = {}) {
    const {
      ema9  = null,
      ema21 = null,
      ema50 = null,
      adx   = null,
      atr   = null,
      atrAvg = null,
      volume = null,
      volAvg = null,
    } = indicators;

    // ── Primary regime: EMA alignment ───────────────────────────────────────
    let primary = PRIMARY.RANGING;
    let emaScore = 0; // 0 = neutral, +2 = strong up, -2 = strong down

    const hasEmas = ema9 != null && ema21 != null && ema50 != null
      && isFinite(ema9) && isFinite(ema21) && isFinite(ema50);

    if (hasEmas) {
      if (ema9 > ema21 && ema21 > ema50) {
        primary  = PRIMARY.TREND_UP;
        emaScore = 2;
      } else if (ema9 < ema21 && ema21 < ema50) {
        primary  = PRIMARY.TREND_DOWN;
        emaScore = -2;
      } else {
        primary  = PRIMARY.RANGING;
        emaScore = 0;
      }
    }

    // ── ADX confirmation / override ──────────────────────────────────────────
    let adxScore = 0; // +1 confirms trend, -1 suggests ranging
    const hasAdx = adx != null && isFinite(adx) && adx >= 0;

    if (hasAdx) {
      if (adx >= 25) {
        // Strong trend — confirms EMA direction (or upgrades ranging if EMA ambiguous)
        adxScore = 1;
        if (primary === PRIMARY.RANGING && ema9 != null && ema21 != null) {
          // Weak EMA structure but strong ADX → keep ranging but note strength
          adxScore = 0;
        }
      } else if (adx < 20) {
        // Ranging confirmation — may override a weak EMA trend
        adxScore = -1;
        if (primary !== PRIMARY.RANGING && hasEmas) {
          const emaDiff = Math.abs(ema9 - ema50) / (ema50 || 1);
          if (emaDiff < 0.005) {
            // EMA spread < 0.5% AND ADX < 20 → range
            primary  = PRIMARY.RANGING;
            emaScore = 0;
          }
        }
      }
    }

    // ── Modifier: ATR percentile (volatility regime) ─────────────────────────
    let modifier = null;
    let atrScore = 0;

    const hasAtr = atr != null && isFinite(atr) && atr >= 0
      && atrAvg != null && isFinite(atrAvg) && atrAvg > 0;

    if (hasAtr) {
      const atrRatio = atr / atrAvg;
      if (atrRatio >= 1.2) {
        modifier = MODIFIER.EXPANSION;
        atrScore = 2;
      } else if (atrRatio <= 0.8) {
        modifier = MODIFIER.COMPRESSION;
        atrScore = -2;
      }
    }

    // ── Volume reinforcement ─────────────────────────────────────────────────
    let volScore = 0;
    const hasVol = volume != null && isFinite(volume) && volume >= 0
      && volAvg != null && isFinite(volAvg) && volAvg > 0;

    if (hasVol) {
      const volRatio = volume / volAvg;
      if (volRatio >= 1.3) {
        volScore = 1;
        // Reinforce expansion → high_vol; or override compression→expansion if volume spike
        if (modifier === MODIFIER.EXPANSION || modifier === null) {
          modifier = MODIFIER.HIGH_VOL;
        }
      } else if (volRatio < 0.7) {
        volScore = -1;
        // Reinforce compression → low_vol
        if (modifier === MODIFIER.COMPRESSION || modifier === null) {
          modifier = MODIFIER.LOW_VOL;
        }
      }
    }

    // ── Composite label ──────────────────────────────────────────────────────
    const composite = modifier ? `${primary}+${modifier}` : primary;

    // ── Confidence score (0–100) ─────────────────────────────────────────────
    // Based on indicator agreement: EMA (0–2) + ADX (0–1) + ATR (0–2) + Vol (0–1)
    // Max raw = 6, map to 0–100
    const rawConfidence = Math.abs(emaScore) + Math.abs(adxScore) + Math.abs(atrScore) + Math.abs(volScore);
    // Weight: EMA and ADX must agree for high confidence
    let confidence;
    if (primary !== PRIMARY.RANGING && adxScore === 1) {
      // Strong directional trend + ADX confirmation = bonus
      confidence = Math.min(100, Math.round((rawConfidence / 6) * 85 + 15));
    } else if (primary === PRIMARY.RANGING && adxScore === -1) {
      confidence = Math.min(100, Math.round((rawConfidence / 6) * 80 + 10));
    } else {
      confidence = Math.min(100, Math.round((rawConfidence / 6) * 70));
    }

    // Penalise if no data
    if (!hasEmas && !hasAdx) confidence = Math.max(0, confidence - 30);

    // Clamp
    confidence = Math.max(0, Math.min(100, confidence));

    return { primary, modifier, composite, confidence };
  }

  /**
   * Derive dominant regime from three TF results.
   * HTF carries the most weight; LTF is confirmed by MTF.
   *
   * @returns {{ primary, modifier, composite, confidence }}
   */
  _deriveDominant(htf, mtf, ltf) {
    // If HTF and MTF agree → that is dominant (LTF fine-tunes modifier only)
    if (htf.primary === mtf.primary) {
      // Use HTF modifier unless LTF adds high_vol signal
      const mod = ltf.modifier === MODIFIER.HIGH_VOL ? MODIFIER.HIGH_VOL : (htf.modifier ?? mtf.modifier ?? null);
      const composite = mod ? `${htf.primary}+${mod}` : htf.primary;
      const confidence = Math.round((htf.confidence * 0.5 + mtf.confidence * 0.35 + ltf.confidence * 0.15));
      return { primary: htf.primary, modifier: mod, composite, confidence: Math.min(100, confidence) };
    }

    // If MTF and LTF agree (HTF is diverging) → short-term regime is emerging
    if (mtf.primary === ltf.primary) {
      const mod = mtf.modifier ?? ltf.modifier ?? null;
      const composite = mod ? `${mtf.primary}+${mod}` : mtf.primary;
      const confidence = Math.round((mtf.confidence * 0.6 + ltf.confidence * 0.4) * 0.75);
      return { primary: mtf.primary, modifier: mod, composite, confidence: Math.min(100, confidence) };
    }

    // Conflicting across all TFs — fall back to HTF with low confidence
    const mod = htf.modifier ?? null;
    const composite = mod ? `${htf.primary}+${mod}` : htf.primary;
    const confidence = Math.round(htf.confidence * 0.4);
    return { primary: htf.primary, modifier: mod, composite, confidence: Math.max(0, Math.min(100, confidence)) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton export (shared across the process for cache efficiency)
// ─────────────────────────────────────────────────────────────────────────────

const _singleton = new RegimeClassifierEngine();

module.exports = _singleton;
module.exports.RegimeClassifierEngine = RegimeClassifierEngine;
module.exports.PRIMARY  = PRIMARY;
module.exports.MODIFIER = MODIFIER;
