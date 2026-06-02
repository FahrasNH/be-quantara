// ─────────────────────────────────────────────
// indicators.js — Kalkulasi indikator teknikal
// EMA, RSI, ATR, Bollinger Bands, Volume SMA
// Support 3 signal types: RSI_REVERSAL, EMA_MOMENTUM, MULTI_TF
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// INDIKATOR DASAR
// ─────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) return new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  const result = [];
  let prev = null;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    if (i === period - 1) {
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

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(null);

  const result = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

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
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }
  return result;
}

function calcATR(highs, lows, closes, period = 14) {
  const trs = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }

  const result = new Array(period - 1).fill(null);
  let avg = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  result.push(avg);

  for (let i = period; i < trs.length; i++) {
    avg = (avg * (period - 1) + trs[i]) / period;
    result.push(avg);
  }
  return result;
}

/**
 * SMA — Simple Moving Average
 */
function calcSMA(values, period) {
  const result = new Array(period - 1).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0);
    result.push(sum / period);
  }
  return result;
}

/**
 * Bollinger Bands (untuk Strategy B momentum)
 */
function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period);
  const upper = [], lower = [];

  for (let i = 0; i < closes.length; i++) {
    if (sma[i] === null) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const mean  = sma[i];
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / slice.length;
    const std = Math.sqrt(variance);
    upper.push(mean + stdDev * std);
    lower.push(mean - stdDev * std);
  }
  return { middle: sma, upper, lower };
}

/**
 * Volume SMA — deteksi volume spike
 */
function calcVolumeSMA(volumes, period = 20) {
  return calcSMA(volumes, period);
}

// ─────────────────────────────────────────────
// MAIN CALCULATOR
// ─────────────────────────────────────────────

function calcIndicators(candles, config = {}) {
  const {
    emaFast    = 9,
    emaSlow    = 21,
    emaTrend   = 20,
    rsiPeriod  = 14,
    atrPeriod  = 14,
    withBB     = false,
    withVolume = false,
  } = config;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  const result = {
    emaFast:  calcEMA(closes, emaFast),
    emaSlow:  calcEMA(closes, emaSlow),
    emaTrend: calcEMA(closes, emaTrend),
    rsi:      calcRSI(closes, rsiPeriod),
    atr:      calcATR(highs, lows, closes, atrPeriod),
  };

  if (withBB)     result.bb     = calcBollingerBands(closes);
  if (withVolume) result.volSMA = calcVolumeSMA(volumes);

  return result;
}

// ─────────────────────────────────────────────
// SIGNAL DETECTION — 3 STRATEGI
// ─────────────────────────────────────────────

/**
 * STRATEGI A — RSI Reversal (Aggressive Scalping)
 *
 * LONG : RSI baru keluar dari oversold (RSI[-1] < oversold, RSI[0] > oversold) + EMA Fast > EMA Slow
 * SHORT: RSI baru keluar dari overbought (RSI[-1] > overbought, RSI[0] < overbought) + EMA Fast < EMA Slow
 */
function detectSignalA(indicators, i, config = {}) {
  const { rsiOverbought = 70, rsiOversold = 30, useBothSides = false } = config;
  const { emaFast, emaSlow, rsi } = indicators;

  if (i < 2) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i] || !rsi[i-1]) return null;

  const rsiPrev = rsi[i - 1];
  const rsiCurr = rsi[i];
  const emaUp   = emaFast[i] > emaSlow[i];  // Trend bullish

  // LONG: RSI keluar dari oversold zone (reversal naik) + trend bullish
  const rsiExitOversold = rsiPrev < rsiOversold && rsiCurr >= rsiOversold;
  if (rsiExitOversold && emaUp) return "LONG";

  // SHORT: RSI keluar dari overbought zone (reversal turun) + trend bearish
  if (useBothSides) {
    const emaDown = emaFast[i] < emaSlow[i];
    const rsiExitOverbought = rsiPrev > rsiOverbought && rsiCurr <= rsiOverbought;
    if (rsiExitOverbought && emaDown) return "SHORT";
  }

  return null;
}

/**
 * STRATEGI B — EMA Momentum Breakout (Recommended)
 *
 * LONG : EMA fast cross UP slow + RSI < rsiOverbought + RSI trending up (momentum)
 * SHORT: EMA fast cross DOWN slow + RSI > rsiOversold + RSI trending down
 *
 * Perbedaan dengan default: cek MOMENTUM RSI (apakah RSI sedang naik/turun)
 * bukan hanya posisi RSI saat ini.
 */
function detectSignalB(indicators, i, config = {}) {
  const { rsiOverbought = 60, rsiOversold = 40, useBothSides = false } = config;
  const { emaFast, emaSlow, rsi } = indicators;

  if (i < 2) return null;
  if (!emaFast[i] || !emaSlow[i] || !emaFast[i-1] || !emaSlow[i-1]) return null;
  if (!rsi[i] || !rsi[i-1] || !rsi[i-2]) return null;

  const prevFast = emaFast[i - 1], currFast = emaFast[i];
  const prevSlow = emaSlow[i - 1], currSlow = emaSlow[i];
  const rsiCurr  = rsi[i];
  const rsiPrev  = rsi[i - 1];
  const rsiMom   = rsiCurr - rsiPrev;  // RSI momentum (positif = naik)

  // Golden cross: EMA fast naik melewati EMA slow
  const goldenCross = prevFast <= prevSlow && currFast > currSlow;
  // RSI tidak overbought DAN RSI trending up (momentum bullish)
  const longOk = rsiCurr < rsiOverbought && rsiMom > 0;

  if (goldenCross && longOk) return "LONG";

  if (useBothSides) {
    // Death cross: EMA fast turun melewati EMA slow
    const deathCross = prevFast >= prevSlow && currFast < currSlow;
    // RSI tidak oversold DAN RSI trending down (momentum bearish)
    const shortOk = rsiCurr > rsiOversold && rsiMom < 0;
    if (deathCross && shortOk) return "SHORT";
  }

  return null;
}

/**
 * STRATEGI C — Multi-Timeframe Pro
 *
 * Membutuhkan 2 set candles: higherTfCandles (15m) dan candles (5m)
 *
 * LONG : 15m bullish (close > EMA20) + 5m EMA fast cross UP slow + RSI < rsiOverbought
 * SHORT: 15m bearish (close < EMA20) + 5m EMA fast cross DOWN slow + RSI > rsiOversold
 *
 * @param {Object} indicators - Dari 5m candles
 * @param {number} i - index 5m candle
 * @param {Object} config
 * @param {Object|null} higherTfIndicators - Dari 15m candles (opsional)
 */
function detectSignalC(indicators, i, config = {}, higherTfIndicators = null) {
  const { rsiOverbought = 60, rsiOversold = 40, useBothSides = false } = config;
  const { emaFast, emaSlow, rsi } = indicators;

  if (i < 2) return null;
  if (!emaFast[i] || !emaSlow[i] || !emaFast[i-1] || !emaSlow[i-1]) return null;
  if (!rsi[i]) return null;

  const prevFast = emaFast[i - 1], currFast = emaFast[i];
  const prevSlow = emaSlow[i - 1], currSlow = emaSlow[i];
  const rsiCurr  = rsi[i];

  // ── 15m Trend Filter ──────────────────────────────
  let higherTfBullish = true;   // Default: allow semua jika tidak ada 15m data
  let higherTfBearish = true;

  if (higherTfIndicators) {
    const { emaTrend: ema15, closes: closes15 } = higherTfIndicators;
    const lastIdx15 = ema15 ? ema15.length - 2 : -1;

    if (lastIdx15 >= 0 && ema15[lastIdx15] && closes15) {
      const price15  = closes15[lastIdx15];
      const trend15  = ema15[lastIdx15];
      higherTfBullish = price15 > trend15;  // 15m bullish: price di atas EMA20
      higherTfBearish = price15 < trend15;  // 15m bearish: price di bawah EMA20
    }
  }

  // ── Entry Signal (5m) ─────────────────────────────
  const goldenCross = prevFast <= prevSlow && currFast > currSlow;
  const longOk      = rsiCurr < rsiOverbought;

  // LONG hanya jika 15m bullish (atau tidak ada 15m data)
  if (goldenCross && longOk && higherTfBullish) return "LONG";

  if (useBothSides) {
    const deathCross = prevFast >= prevSlow && currFast < currSlow;
    const shortOk    = rsiCurr > rsiOversold;
    // SHORT hanya jika 15m bearish
    if (deathCross && shortOk && higherTfBearish) return "SHORT";
  }

  return null;
}

/**
 * Deteksi sinyal berdasarkan strategi yang dipilih
 * @param {Object} indicators
 * @param {number} i
 * @param {Object} config - Harus include signalType dan strategy params
 * @param {Object|null} higherTfIndicators - Untuk Strategi C
 */
function detectSignal(indicators, i, config = {}, higherTfIndicators = null) {
  const signalType = config.signalType || "EMA_CROSSOVER";

  switch (signalType) {
    case "RSI_REVERSAL":  return detectSignalA(indicators, i, config);
    case "EMA_MOMENTUM":  return detectSignalB(indicators, i, config);
    case "MULTI_TF":      return detectSignalC(indicators, i, config, higherTfIndicators);
    default:              return detectSignalLegacy(indicators, i, config);
  }
}

/**
 * Legacy signal detection (strategi lama, fallback)
 * EMA crossover + RSI posisi
 */
function detectSignalLegacy(indicators, i, config = {}) {
  const { rsiOverbought = 70, rsiOversold = 30, useBothSides = false } = config;
  const { emaFast, emaSlow, rsi } = indicators;

  if (i < 1) return null;
  if (!emaFast[i] || !emaSlow[i] || !emaFast[i-1] || !emaSlow[i-1]) return null;

  const prevFast = emaFast[i - 1], currFast = emaFast[i];
  const prevSlow = emaSlow[i - 1], currSlow = emaSlow[i];
  const curRSI   = rsi[i];

  const goldenCross = prevFast <= prevSlow && currFast > currSlow;
  const longOk      = curRSI !== null && curRSI < rsiOverbought;
  if (goldenCross && longOk) return "LONG";

  if (useBothSides) {
    const deathCross = prevFast >= prevSlow && currFast < currSlow;
    const shortOk    = curRSI !== null && curRSI > rsiOversold;
    if (deathCross && shortOk) return "SHORT";
  }

  return null;
}

/**
 * Hitung ukuran posisi berdasarkan risk
 */
function calcPositionSize(capital, riskPct, entryPrice, stopLossPrice) {
  const riskAmount = capital * riskPct;
  const slDistance = Math.abs(entryPrice - stopLossPrice);
  if (slDistance === 0) return 0;
  const size = riskAmount / slDistance;
  return Math.floor(size * 1000) / 1000;
}

module.exports = {
  calcEMA,
  calcRSI,
  calcATR,
  calcSMA,
  calcBollingerBands,
  calcVolumeSMA,
  calcIndicators,
  detectSignal,
  detectSignalA,
  detectSignalB,
  detectSignalC,
  detectSignalLegacy,
  calcPositionSize,
};
