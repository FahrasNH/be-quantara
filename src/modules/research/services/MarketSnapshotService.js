/**
 * MarketSnapshotService.js  (src/server/services/MarketSnapshotService.js)
 *
 * Menggantikan referensi `getMarketSnapshot` dari Implementation Guide (yang
 * mengasumsikan marketService existing — di repo Quantara belum ada).
 *
 * Tidak menyimpan state: menerima exchange client (sharedClient) lalu menghitung
 * EMA/RSI/ATR/Bollinger/Volume dari candle LTF, dan regime dari candle HTF.
 */

'use strict';

const {
  calcEMA, calcRSI, calcATR, calcSMA, calcBollingerBands, calcVolumeSMA,
} = require('../../../core/analytics-engine/indicators');
const { classifyHTFRegime } = require('../../../core/signal-engine/htfRegimeFilter');
const { fetchCandlesWithCache, LTF_CACHE_TTL, HTF_CACHE_TTL } = require('../../../infrastructure/exchange/candleFetch');

/** Ambil elemen terakhir yang non-null dari array indikator. */
function lastVal(arr) {
  if (!Array.isArray(arr)) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

/**
 * HV 30 hari annualized (%): std dev log-return harian × √365 × 100.
 * @param {number[]} closes
 * @returns {number|null}
 */
function calcHV30(closes) {
  if (!Array.isArray(closes) || closes.length < 31) return null;
  const slice = closes.slice(-31);
  const returns = [];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i - 1] > 0 && slice[i] > 0) {
      returns.push(Math.log(slice[i] / slice[i - 1]));
    }
  }
  if (returns.length < 20) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return parseFloat((Math.sqrt(variance) * Math.sqrt(365) * 100).toFixed(3));
}

/**
 * Beta coin vs BTC dari log-return harian (lookback 30 hari).
 * @param {number[]} coinCloses
 * @param {number[]} btcCloses
 * @returns {number|null}
 */
function calcBetaToBTC(coinCloses, btcCloses) {
  if (!Array.isArray(coinCloses) || !Array.isArray(btcCloses)) return null;
  const n = Math.min(31, coinCloses.length, btcCloses.length);
  if (n < 21) return null;
  const cSlice = coinCloses.slice(-n);
  const bSlice = btcCloses.slice(-n);
  const cRet = [];
  const bRet = [];
  for (let i = 1; i < n; i++) {
    if (cSlice[i - 1] > 0 && cSlice[i] > 0 && bSlice[i - 1] > 0 && bSlice[i] > 0) {
      cRet.push(Math.log(cSlice[i] / cSlice[i - 1]));
      bRet.push(Math.log(bSlice[i] / bSlice[i - 1]));
    }
  }
  if (cRet.length < 15) return null;
  const bMean = bRet.reduce((a, v) => a + v, 0) / bRet.length;
  const cMean = cRet.reduce((a, v) => a + v, 0) / cRet.length;
  let cov = 0;
  let bVar = 0;
  for (let i = 0; i < cRet.length; i++) {
    const bd = bRet[i] - bMean;
    cov += (cRet[i] - cMean) * bd;
    bVar += bd * bd;
  }
  if (bVar <= 0) return null;
  return parseFloat((cov / bVar).toFixed(3));
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
 * Hitung metrik hybrid untuk PairClassifier (v2.0 — PAIR_VOLATILITY.md §2).
 * Menyuplai input calculateHybridVolatilityScore:
 *   - hv30, atrPercent14, liquidityRatio, marketCapRank, betaToBTC
 * Legacy fields (atrPct30d, lowLiquidity) tetap ada untuk backward-compat.
 *
 * @param {Object} client - exchange client dengan getCandles
 * @param {string} symbol
 * @param {Object} [opts]
 * @returns {Promise<Object|null>}
 */
async function getPairTierMetrics(client, symbol, opts = {}) {
  const {
    atrPeriod = 14,
    dailyLimit = 35,
    minBars = 20,
    // AF-FIX-LIQUIDITY (Sprint 7, 2026-07-02): 2M was too low for perpetual futures
    // (thin book / wide spread risk); raised to $20M per sprint success criteria.
    minVolume24h = 20_000_000,
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
  const atrPercent14 = atr != null ? parseFloat(((atr / lastClose) * 100).toFixed(3)) : null;
  const hv30 = calcHV30(closes);

  const baseVol24h = vols[vols.length - 1] ?? 0;
  const volumeFromCandles = baseVol24h * lastClose;

  // Market cap + volume dari CoinGecko (lebih akurat untuk liquidityRatio).
  const { getMarketData } = require('../../../infrastructure/market/coinGeckoClient');
  const { pairClassifier } = require('../../../infrastructure/classification/PairClassifier');
  const marketData = await getMarketData(symbol).catch(() => null);
  const marketCap = marketData?.marketCap ?? null;
  const volume24h = marketData?.volume24h ?? volumeFromCandles;
  const liquidityRatio = (marketCap > 0 && volume24h > 0)
    ? parseFloat((volume24h / marketCap).toFixed(6))
    : null;
  const marketCapRank = pairClassifier.getMarketCapRank(symbol);

  // Beta vs BTC — butuh candle harian BTC paralel.
  let betaToBTC = null;
  try {
    const btcDaily = await fetchCandlesWithCache(client, {
      exchange, symbol: 'BTCUSDT', interval: '1d', limit: dailyLimit,
      cacheTtlSeconds: HTF_CACHE_TTL, minBars,
    });
    if (btcDaily?.length >= minBars) {
      betaToBTC = calcBetaToBTC(closes, btcDaily.map(c => c.close));
    }
  } catch {
    betaToBTC = null;
  }

  const lowLiquidity = minVolume24h > 0 && volume24h > 0 && volume24h < minVolume24h;

  return {
    hv30:           hv30 ?? undefined,
    atrPercent14:   atrPercent14 ?? undefined,
    atrPct30d:      atrPercent14 ?? undefined,
    liquidityRatio: liquidityRatio ?? undefined,
    marketCap:      marketCap ?? undefined,
    marketCapRank:  marketCapRank ?? undefined,
    betaToBTC:      betaToBTC ?? undefined,
    volume24h,
    minVolume24h,
    lowLiquidity,
  };
}

module.exports = { getMarketSnapshot, getPairTierMetrics };
