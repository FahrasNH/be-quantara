/**
 * MarketSnapshotService.js  (src/server/services/MarketSnapshotService.js)
 *
 * Membangun snapshot indikator market untuk konsumsi analyzeStrategyFit (FIX-2).
 * Menggantikan referensi `getMarketSnapshot` dari Implementation Guide (yang
 * mengasumsikan marketService existing — di repo Quantara belum ada).
 *
 * Tidak menyimpan state: menerima exchange client (sharedClient) lalu menghitung
 * EMA/RSI/ATR/Bollinger/Volume dari candle LTF, dan regime dari candle HTF.
 */

'use strict';

const {
  calcEMA, calcRSI, calcATR, calcSMA, calcBollingerBands, calcVolumeSMA,
} = require('../../domain/indicators');
const { classifyHTFRegime } = require('../../domain/htfRegimeFilter');
const { fetchCandlesWithCache, LTF_CACHE_TTL, HTF_CACHE_TTL } = require('../../infrastructure/exchange/candleFetch');

/** Ambil elemen terakhir yang non-null dari array indikator. */
function lastVal(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

/**
 * @param {Object} client - exchange client dengan getCandles(symbol, interval, limit)
 * @param {string} symbol
 * @param {Object} [opts]
 * @returns {Promise<Object|null>} marketData untuk analyzeStrategyFit, atau null bila gagal
 */
async function getMarketSnapshot(client, symbol, opts = {}) {
  const {
    emaFast = 9, emaSlow = 21,
    rsiPeriod = 14, atrPeriod = 14,
    bbPeriod = 20, bbStdDev = 2,
    ltfInterval = '15m', htfInterval = '1h',
    ltfLimit = 120, htfLimit = 60,
    exchange = 'bitget',
  } = opts;

  if (!client?.getCandles) return null;

  // ── LTF candles → indikator entry ──────────────────────────────────────────
  let candles;
  try {
    candles = await fetchCandlesWithCache(client, {
      exchange, symbol, interval: ltfInterval, limit: ltfLimit,
      cacheTtlSeconds: LTF_CACHE_TTL, minBars: emaSlow + 5,
    });
  } catch {
    return null;
  }
  if (!candles || candles.length < emaSlow + 5) return null;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  const ema9  = lastVal(calcEMA(closes, emaFast));
  const ema21 = lastVal(calcEMA(closes, emaSlow));
  const rsi   = lastVal(calcRSI(closes, rsiPeriod));

  const atrArr      = calcATR(highs, lows, closes, atrPeriod);
  const atr         = lastVal(atrArr);
  // Baseline ATR = SMA-20 dari deret ATR (proxy volatilitas historis)
  const atrBaseline = lastVal(calcSMA(atrArr.map(v => (v == null ? 0 : v)), 20)) || atr;

  const bb       = calcBollingerBands(closes, bbPeriod, bbStdDev);
  const bbUpper  = lastVal(bb.upper);
  const bbLower  = lastVal(bb.lower);

  const volume    = volumes[volumes.length - 1] ?? 0;
  const avgVolume = lastVal(calcVolumeSMA(volumes, 20)) || volume || 1;

  // ── HTF candles → regime (strong_bull / strong_bear / ranging / uncertain) ──
  let htfTrend = 'unknown';
  try {
    const htfCandles = await fetchCandlesWithCache(client, {
      exchange, symbol, interval: htfInterval, limit: htfLimit,
      cacheTtlSeconds: HTF_CACHE_TTL, minBars: emaSlow + 5,
    });
    if (htfCandles && htfCandles.length >= emaSlow + 5) {
      const hCloses = htfCandles.map(c => c.close);
      const hHighs  = htfCandles.map(c => c.high);
      const hLows   = htfCandles.map(c => c.low);
      htfTrend = classifyHTFRegime({
        emaFast: lastVal(calcEMA(hCloses, emaFast)),
        emaSlow: lastVal(calcEMA(hCloses, emaSlow)),
        rsi:     lastVal(calcRSI(hCloses, rsiPeriod)),
        close:   hCloses[hCloses.length - 1],
        atr:     lastVal(calcATR(hHighs, hLows, hCloses, atrPeriod)),
        atrBaseline: null,
      });
    }
  } catch {
    htfTrend = 'unknown'; // gagal fetch HTF → biarkan analisis berjalan tanpa regime
  }

  return {
    ema9, ema21, rsi, atr, atrBaseline,
    volume, avgVolume, htfTrend,
    lastClose: closes[closes.length - 1],
    bbUpper, bbLower,
  };
}

module.exports = { getMarketSnapshot };
