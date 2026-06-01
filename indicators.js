// ─────────────────────────────────────────────
// indicators.js — Kalkulasi indikator teknikal
// EMA, RSI, ATR — semua dihitung manual
// tanpa library eksternal
// ─────────────────────────────────────────────

/**
 * EMA — Exponential Moving Average
 * @param {number[]} values - Array harga close
 * @param {number} period
 * @returns {number[]} array EMA (null untuk index awal)
 */
function calcEMA(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    if (i === period - 1) {
      // Seed: SMA dari period pertama
      const seed = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
      result.push(seed);
      prev = seed;
      continue;
    }
    const ema = values[i] * k + prev * (1 - k);
    result.push(ema);
    prev = ema;
  }
  return result;
}

/**
 * RSI — Relative Strength Index
 * @param {number[]} closes
 * @param {number} period - default 14
 * @returns {number[]}
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);

  const result = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs0));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = Math.max(diff, 0);
    const loss = Math.max(-diff, 0);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

/**
 * ATR — Average True Range
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} period - default 14
 * @returns {number[]}
 */
function calcATR(highs, lows, closes, period = 14) {
  const trs = [highs[0] - lows[0]];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }

  const result = new Array(period - 1).fill(null);

  // Seed: SMA(TR, period)
  let avg = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(avg);

  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]) / period;
    result.push(avg);
  }
  return result;
}

/**
 * Hitung semua indikator dari array candles
 * @param {Array} candles - [{open, high, low, close, volume}]
 * @param {Object} config - {emaFast, emaSlow, rsiPeriod, atrPeriod}
 * @returns {Object} {emaFast, emaSlow, rsi, atr} arrays
 */
function calcIndicators(candles, config = {}) {
  const {
    emaFast = 9,
    emaSlow = 21,
    rsiPeriod = 14,
    atrPeriod = 14,
  } = config;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);

  return {
    emaFast: calcEMA(closes, emaFast),
    emaSlow: calcEMA(closes, emaSlow),
    rsi:     calcRSI(closes, rsiPeriod),
    atr:     calcATR(highs, lows, closes, atrPeriod),
  };
}

/**
 * Deteksi sinyal EMA crossover
 * @param {Object} indicators - output calcIndicators
 * @param {number} i - index candle saat ini
 * @param {Object} config
 * @returns {"LONG" | "SHORT" | null}
 */
function detectSignal(indicators, i, config = {}) {
  const { rsiOverbought = 70, rsiOversold = 30, useBothSides = false } = config;

  const { emaFast, emaSlow, rsi } = indicators;

  // Butuh minimal 2 candle untuk deteksi crossover
  if (i < 1) return null;
  if (emaFast[i] === null || emaSlow[i] === null) return null;
  if (emaFast[i-1] === null || emaSlow[i-1] === null) return null;

  const prevFast = emaFast[i - 1], currFast = emaFast[i];
  const prevSlow = emaSlow[i - 1], currSlow = emaSlow[i];
  const curRSI   = rsi[i];

  // LONG: EMA fast cross UP slow + RSI tidak overbought
  const goldenCross = prevFast <= prevSlow && currFast > currSlow;
  const longOk      = curRSI !== null && curRSI < rsiOverbought;

  if (goldenCross && longOk) return "LONG";

  // SHORT: EMA fast cross DOWN slow + RSI tidak oversold
  if (useBothSides) {
    const deathCross = prevFast >= prevSlow && currFast < currSlow;
    const shortOk    = curRSI !== null && curRSI > rsiOversold;
    if (deathCross && shortOk) return "SHORT";
  }

  return null;
}

/**
 * Hitung ukuran posisi berdasarkan risk
 * @param {number} capital - Modal tersedia
 * @param {number} riskPct - 0.02 = 2%
 * @param {number} entryPrice
 * @param {number} stopLossPrice
 * @returns {number} size dalam base currency
 */
function calcPositionSize(capital, riskPct, entryPrice, stopLossPrice) {
  const riskAmount = capital * riskPct;
  const slDistance = Math.abs(entryPrice - stopLossPrice);
  if (slDistance === 0) return 0;
  const size = riskAmount / slDistance;
  return Math.floor(size * 1000) / 1000; // 3 decimal places
}

module.exports = {
  calcEMA,
  calcRSI,
  calcATR,
  calcIndicators,
  detectSignal,
  calcPositionSize,
};
