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

/**
 * Hitung metrik hybrid untuk PairClassifier (v2.3 — PAIR_VOLATILITY.md §"Tambahan
 * Hybrid Metric"). Dipakai untuk menaikkan/menurunkan tier dasar (market-cap) saat
 * volatilitas nyata tinggi atau likuiditas tipis:
 *   - atrPct30d : ATR(14) pada candle HARIAN (lookback ~30 hari) sebagai % harga.
 *                 PairClassifier menaikkan tier 1 level bila > 4.5%.
 *   - volume24h : estimasi quote-volume (USD) 24 jam = base-volume × close pada
 *                 candle harian terakhir.
 *   - lowLiquidity / minVolume24h : flag likuiditas tipis → paksa VOLATILE.
 *
 * Reuse fetchCandlesWithCache + calcATR (sama dgn getMarketSnapshot) — tidak ada
 * fetch baru selain candle harian (di-cache). Mengembalikan null bila data tak
 * tersedia → classify() jatuh ke tier dasar (backward-compatible, tanpa bump).
 *
 * @param {Object} client - exchange client dengan getCandles
 * @param {string} symbol
 * @param {Object} [opts]
 * @param {number} [opts.atrPeriod=14]
 * @param {number} [opts.dailyLimit=35]   - jumlah candle harian (≈30 hari + warmup ATR)
 * @param {number} [opts.minBars=20]      - minimum candle agar metrik dianggap valid
 * @param {number} [opts.minVolume24h=2_000_000] - threshold likuiditas (USD/24j)
 * @param {string} [opts.exchange='bitget']
 * @returns {Promise<{atrPct30d?:number, volume24h:number, minVolume24h:number, lowLiquidity:boolean}|null>}
 */
async function getPairTierMetrics(client, symbol, opts = {}) {
  const {
    atrPeriod = 14,
    dailyLimit = 35,
    minBars = 20,
    // Threshold likuiditas default: $2.000.000 quote-volume per 24 jam. Di bawah
    // ini order book umumnya tipis (spread lebar, slippage tinggi) → paksa VOLATILE
    // sebagai fail-safe. Nilai konservatif & dapat di-tune (lihat catatan rilis).
    minVolume24h = 2_000_000,
    exchange = 'bitget',
  } = opts;

  if (!client?.getCandles) return null;

  let daily;
  try {
    daily = await fetchCandlesWithCache(client, {
      exchange, symbol, interval: '1d', limit: dailyLimit,
      cacheTtlSeconds: HTF_CACHE_TTL, minBars,
    });
  } catch {
    return null;
  }
  if (!daily || daily.length < minBars) return null;

  const closes = daily.map(c => c.close);
  const highs  = daily.map(c => c.high);
  const lows   = daily.map(c => c.low);
  const vols   = daily.map(c => c.volume || 0);

  const lastClose = closes[closes.length - 1];
  if (!(lastClose > 0)) return null;

  const atr = lastVal(calcATR(highs, lows, closes, atrPeriod));
  const atrPct30d = atr != null ? (atr / lastClose) * 100 : null;

  // Quote-volume (USD) 24 jam ≈ base-volume × harga close candle harian terakhir.
  const baseVol24h = vols[vols.length - 1] ?? 0;
  const volume24h  = baseVol24h * lastClose;

  // Fail-OPEN saat volume tak terbaca (0): jangan paksa VOLATILE tanpa data.
  const lowLiquidity = minVolume24h > 0 && volume24h > 0 && volume24h < minVolume24h;

  return {
    atrPct30d: atrPct30d != null ? parseFloat(atrPct30d.toFixed(3)) : undefined,
    volume24h,
    minVolume24h,
    lowLiquidity,
  };
}

module.exports = { getMarketSnapshot, getPairTierMetrics };
