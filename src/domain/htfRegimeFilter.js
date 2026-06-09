/**
 * htfRegimeFilter.js  (src/domain/htfRegimeFilter.js)
 *
 * ROOT CAUSE FIX (FIX-4):
 *   MEAN_REVERSION akan terus counter-trend jika tidak ada HTF filter.
 *   Di strong bull market → SHORT terus kena SL.
 *   Di strong bear market → LONG terus kena SL.
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

module.exports = { meanReversionRegimeFilter, classifyHTFRegime, REGIME_CONFIG };
