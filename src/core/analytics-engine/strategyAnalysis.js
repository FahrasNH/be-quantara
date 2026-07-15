/**
 * strategyAnalysis.js  (core/analytics-engine)
 *
 *   FE memanggil GET /bots/:symbol/strategy-analysis tapi endpoint ini
 *   tidak ada di BE (gap dari §5 ARCHITECTURE.md). Fix: tambahkan handler + route.
 *
 * Modul ini murni fungsi analisis (tanpa I/O) sehingga mudah di-unit-test.
 * Pengambilan data market dilakukan oleh handler route (lihat bots-afs.js).
 *
 * Analisis mengembalikan kondisi market saat ini beserta rekomendasi strategi
 * yang paling cocok, berdasarkan:
 *   - HTF EMA direction
 *   - RSI regime
 *   - ATR volatility
 *   - Volume relative to average
 */

'use strict';

const { normalizeStrategyKey } = require('../../config/strategyKeyNormalizer');

/**
 * Analisis kondisi market dan rekomendasikan strategi terbaik.
 *
 * @param {Object} marketData  - { symbol, ema9, ema21, rsi, atr, atrBaseline,
 *                                 volume, avgVolume, htfTrend, lastClose, bbUpper, bbLower }
 * @param {string} currentStrategy
 * @returns {Object} analysis result
 */
function analyzeStrategyFit(marketData, currentStrategy) {
  const {
    ema9, ema21, rsi, atr, atrBaseline,
    volume, avgVolume, htfTrend,
    lastClose, bbUpper, bbLower,
  } = marketData;

  const signals = [];
  const scores  = {
    AF_SMC:  0,
    TS_TF:   0,
    MD_MR:   0,
    BS_BR:   0,
  };

  // === Market regime detection ===
  const emaBullish    = ema9 > ema21;
  const emaStrong     = Math.abs(ema9 - ema21) / ema21 > 0.003; // spread > 0.3%
  const rsiOverbought = rsi > 70;
  const rsiOversold   = rsi < 30;
  const rsiNeutral    = rsi >= 45 && rsi <= 55;
  const highVolume    = volume > avgVolume * 1.2;
  const lowVolume     = volume < avgVolume * 0.8;
  const highATR       = atr > atrBaseline * 1.5;
  const ranging       = !emaStrong; // RSI extreme di EMA-flat market = ideal MR setup

  // === AF_SMC score ===
  // Bekerja baik di mixed/uncertain conditions — voting system menyaringnya
  scores.AF_SMC += rsiNeutral  ? 10 : 0;
  scores.AF_SMC += !highATR    ? 8  : 0;
  scores.AF_SMC += highVolume  ? 5  : 0;
  scores.AF_SMC += emaStrong   ? 7  : 0;

  // === TS_TF score ===
  // Perlu trend kuat + volume support
  if (emaBullish && emaStrong && highVolume && !rsiOverbought) {
    scores.TS_TF += 25;
    signals.push({ type: 'bullish_momentum', confidence: 'high' });
  }
  if (!emaBullish && emaStrong && highVolume && !rsiOversold) {
    scores.TS_TF += 20;
    signals.push({ type: 'bearish_momentum', confidence: 'high' });
  }
  scores.TS_TF += lowVolume ? -15 : 0; // volume lemah = penalty besar

  // === MD_MR score ===
  // Perlu ranging market + BB extreme touch
  if (ranging && bbLower && lastClose <= bbLower * 1.01 && rsiOversold) {
    scores.MD_MR += 30;
    signals.push({ type: 'oversold_bb_touch', confidence: 'high' });
  }
  if (ranging && bbUpper && lastClose >= bbUpper * 0.995 && rsiOverbought) {
    scores.MD_MR += 30;
    signals.push({ type: 'overbought_bb_touch', confidence: 'high' });
  }
  scores.MD_MR += ranging ? 15 : -10;
  // Penalti jika trend HTF terlalu kuat — MR berbahaya di strong trend
  if (htfTrend === 'strong_bull' || htfTrend === 'strong_bear') {
    scores.MD_MR -= 20;
    signals.push({ type: 'htf_trend_warning', detail: `MD_MR tidak direkomendasikan saat HTF ${htfTrend}` });
  }

  // === BS_BR score ===
  // Cocok saat konsolidasi / volatilitas sedang-tinggi + volume breakout
  scores.BS_BR += ranging ? 20 : 0;
  scores.BS_BR += highVolume ? 10 : 0;
  scores.BS_BR += highATR ? 8 : 0;

  // === Tentukan rekomendasi ===
  const eligible = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a);

  const recommended = eligible[0]?.[0] ?? 'AF_SMC'; // AF sebagai default safe
  const confidence  = eligible[0]?.[1] > 20 ? 'high' : eligible[0]?.[1] > 10 ? 'medium' : 'low';

  const regime = ranging ? 'ranging'
    : emaStrong && emaBullish ? 'trending_bull'
    : emaStrong && !emaBullish ? 'trending_bear'
    : 'uncertain';

  const current = normalizeStrategyKey(String(currentStrategy || '').toUpperCase());

  return {
    ok: true,
    symbol: marketData.symbol,
    timestamp: new Date().toISOString(),
    marketRegime: regime,
    htfTrend: htfTrend ?? 'unknown',
    indicators: {
      emaBullish, emaStrong, rsi: Math.round(rsi),
      rsiState: rsiOverbought ? 'overbought' : rsiOversold ? 'oversold' : 'neutral',
      atrMultiple: atrBaseline ? +(atr / atrBaseline).toFixed(2) : null,
      volumeRelative: avgVolume ? +(volume / avgVolume).toFixed(2) : null,
    },
    signals,
    strategyScores: Object.fromEntries(
      Object.entries(scores).map(([k, v]) => [k, Math.max(v, -999)])
    ),
    recommended,
    confidence,
    currentStrategy: current,
    switchRecommended: recommended !== current && confidence === 'high',
    blockedStrategies: [],
  };
}

module.exports = { analyzeStrategyFit };
