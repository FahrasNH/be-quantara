/**
 * htfRegimeFilter.js  (src/domain/htfRegimeFilter.js)
 *
 * ROOT CAUSE FIX (FIX-4):
 *   MEAN_REVERSION akan terus counter-trend jika tidak ada HTF filter.
 *   Di strong bull market → SHORT terus kena SL.
 *   Di strong bear market → LONG terus kena SL.
 *
 * PAIR-TIER-06: Enhanced with triple-EMA check (EMA9 > EMA50 > EMA200).
 *   For VOLATILE pairs, regimeFilterRequired=true means this check MUST pass
 *   before any MR entry. The checkHTFRegime() function checks the full
 *   EMA9 > EMA50 > EMA200 uptrend structure and blocks counter-trend entries.
 *
 * Fungsi ini dipanggil SEBELUM MEAN_REVERSION evaluate entry signal.
 * Jika regime tidak aman → return { allowed: false } → skip entry.
 *
 * Diintegrasikan via MeanReversionStrategy.detectSignal (opsional, fail-open jika
 * htfData tidak tersedia) dan BotEngine yang menyuplai htfData dari candle 1h.
 */

'use strict';

/**
 * Thresholds untuk klasifikasi regime HTF.
 * Bisa dioverride via config jika perlu A/B testing.
 */
const REGIME_CONFIG = {
  // EMA spread > X% dari harga → trend kuat
  strongTrendEmaSpreadPct: 0.008,   // 0.8%
  // RSI > threshold → overbought/oversold confirmation untuk trend
  strongBullRsiMin: 58,
  strongBearRsiMax: 42,
  // ATR multiple > X → volatility terlalu tinggi untuk MR
  maxAtrMultiple: 2.0,
};

/**
 * Klasifikasikan kondisi HTF.
 *
 * @param {Object} htfData
 * @param {number} htfData.emaFast    - EMA9 di HTF (1h/4h)
 * @param {number} htfData.emaSlow    - EMA21 di HTF
 * @param {number} htfData.rsi        - RSI di HTF
 * @param {number} htfData.close      - Last close di HTF
 * @param {number} htfData.atr        - ATR saat ini
 * @param {number} htfData.atrBaseline - ATR rata-rata historis (misal MA20 dari ATR)
 * @returns {'strong_bull' | 'strong_bear' | 'ranging' | 'uncertain'}
 */
function classifyHTFRegime(htfData) {
  const { emaFast, emaSlow, rsi, close } = htfData;

  const spread    = Math.abs(emaFast - emaSlow) / close;
  const isBullish = emaFast > emaSlow;
  const isStrong  = spread > REGIME_CONFIG.strongTrendEmaSpreadPct;

  if (isStrong && isBullish && rsi >= REGIME_CONFIG.strongBullRsiMin) {
    return 'strong_bull';
  }
  if (isStrong && !isBullish && rsi <= REGIME_CONFIG.strongBearRsiMax) {
    return 'strong_bear';
  }
  if (!isStrong) {
    return 'ranging';
  }
  return 'uncertain';
}

/**
 * Filter entry untuk MEAN_REVERSION berdasarkan HTF regime.
 *
 * @param {Object} params
 * @param {'LONG' | 'SHORT'} params.direction  - Arah entry yang akan dieksekusi
 * @param {Object} params.htfData              - Data HTF (lihat classifyHTFRegime)
 * @returns {{ allowed: boolean, reason: string, regime: string }}
 */
function meanReversionRegimeFilter({ direction, htfData }) {
  const { atr, atrBaseline } = htfData;
  const regime = classifyHTFRegime(htfData);

  // ATR terlalu tinggi — volatility spike, spread bisa lebar, SL sulit
  if (atrBaseline && atr / atrBaseline > REGIME_CONFIG.maxAtrMultiple) {
    return {
      allowed: false,
      reason: `ATR ${(atr / atrBaseline).toFixed(2)}x baseline — volatility terlalu tinggi untuk Mean Reversion`,
      regime,
    };
  }

  // SHORT entry di strong bull market — counter-trend berbahaya
  if (direction === 'SHORT' && regime === 'strong_bull') {
    return {
      allowed: false,
      reason: 'HTF strong bull — SHORT MEAN_REVERSION diblokir untuk mencegah counter-trend loss',
      regime,
    };
  }

  // LONG entry di strong bear market — counter-trend berbahaya
  if (direction === 'LONG' && regime === 'strong_bear') {
    return {
      allowed: false,
      reason: 'HTF strong bear — LONG MEAN_REVERSION diblokir untuk mencegah counter-trend loss',
      regime,
    };
  }

  return { allowed: true, reason: 'HTF regime compatible dengan MEAN_REVERSION', regime };
}

// ─── PAIR-TIER-06: Triple-EMA regime check ────────────────────────────────────

/**
 * Triple-EMA uptrend/downtrend check for VOLATILE pairs.
 * A "confirmed uptrend" requires EMA9 > EMA50 > EMA200 (all aligned).
 * A "confirmed downtrend" requires EMA9 < EMA50 < EMA200.
 * Anything else is "mixed" (choppy — still dangerous for MR).
 *
 * @param {Object} htfData
 * @param {number} htfData.ema9    - EMA 9-period
 * @param {number} htfData.ema50   - EMA 50-period
 * @param {number} htfData.ema200  - EMA 200-period
 * @param {number} htfData.close   - Last close price
 * @returns {{ trend: 'uptrend'|'downtrend'|'mixed', aligned: boolean }}
 */
function checkTripleEMAAlignment(htfData) {
  const { ema9, ema50, ema200 } = htfData;
  if (!ema9 || !ema50 || !ema200) {
    return { trend: 'mixed', aligned: false };
  }
  if (ema9 > ema50 && ema50 > ema200) return { trend: 'uptrend',   aligned: true };
  if (ema9 < ema50 && ema50 < ema200) return { trend: 'downtrend', aligned: true };
  return { trend: 'mixed', aligned: false };
}

/**
 * HTF regime check for PAIR-TIER-06.
 * Used when pairClass.paramOverrides.regimeFilterRequired === true (VOLATILE pairs).
 *
 * MR LONG entries are only allowed in downtrend/mixed (mean reversion bounce).
 * MR SHORT entries are only allowed in uptrend/mixed.
 * If alignment is confirmed and direction is WITH the trend → block (chasing).
 *
 * @param {Object} params
 * @param {'LONG'|'SHORT'} params.direction
 * @param {Object} params.htfData         - Must include ema9, ema50, ema200
 * @param {boolean} [params.required=false] - If true, block on missing EMA data
 * @returns {{ allowed: boolean, reason: string, trend: string }}
 */
function checkHTFRegime({ direction, htfData, required = false }) {
  const { trend, aligned } = checkTripleEMAAlignment(htfData);

  // Missing data: if required (VOLATILE) → fail-closed; otherwise fail-open
  if (!htfData.ema9 || !htfData.ema50 || !htfData.ema200) {
    if (required) {
      return { allowed: false, reason: 'EMA50/EMA200 data unavailable — VOLATILE pair requires HTF regime check', trend: 'unknown' };
    }
    return { allowed: true, reason: 'HTF triple-EMA data unavailable — fail-open (non-required)', trend: 'unknown' };
  }

  // Confirmed uptrend: block MR LONG (trend-following, not mean-reverting)
  // MR SHORT is ok (fading overbought top in uptrend = classic MR)
  if (aligned && trend === 'uptrend' && direction === 'LONG') {
    return {
      allowed: false,
      reason: 'HTF uptrend confirmed (EMA9>EMA50>EMA200) — LONG MEAN_REVERSION blocks trend-chasing entries',
      trend,
    };
  }

  // Confirmed downtrend: block MR SHORT (trend-following, not mean-reverting)
  // MR LONG is ok (fading oversold bottom in downtrend = classic MR bounce)
  if (aligned && trend === 'downtrend' && direction === 'SHORT') {
    return {
      allowed: false,
      reason: 'HTF downtrend confirmed (EMA9<EMA50<EMA200) — SHORT MEAN_REVERSION blocks trend-chasing entries',
      trend,
    };
  }

  return { allowed: true, reason: `HTF regime ${trend} — MR ${direction} entry permitted`, trend };
}

module.exports = { meanReversionRegimeFilter, classifyHTFRegime, checkHTFRegime, checkTripleEMAAlignment, REGIME_CONFIG };
