// ─────────────────────────────────────────────
// indicators.js — Kalkulasi indikator teknikal
//
// Implementasi berdasarkan:
// "Dokumentasi Panduan Strategi Trading"
//   Aggressive Scalping, Day Trading, Swing Trading
//
// Signal types:
//   PDF_SCALPING   → Strategi A (EMA9/21 + RSI zona + volume)
//   PDF_DAYTRADING → Strategi B (EMA9/21/50 + RSI 50-70 + volume)
//   PDF_SWING      → Strategi C (EMA21/50/200 + pullback RSI 40-60)
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

function calcSMA(values, period) {
  const result = new Array(period - 1).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const sum = values.slice(i - period + 1, i + 1).reduce((s, v) => s + v, 0);
    result.push(sum / period);
  }
  return result;
}

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
    emaTrend   = 50,
    rsiPeriod  = 14,
    atrPeriod  = 14,
    withBB     = false,
    withVolume = true,     // Volume aktif by default
  } = config;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);

  const result = {
    emaFast:  calcEMA(closes, emaFast),
    emaSlow:  calcEMA(closes, emaSlow),
    rsi:      calcRSI(closes, rsiPeriod),
    atr:      calcATR(highs, lows, closes, atrPeriod),
    volSMA:   calcVolumeSMA(volumes, 20),  // Selalu hitung volume SMA
    closes,
    volumes,
  };

  // EMA trend filter (EMA50 untuk Day Trading, EMA200 untuk Swing)
  if (emaTrend && emaTrend > 0) {
    result.emaTrend = calcEMA(closes, emaTrend);
  }

  if (withBB) result.bb = calcBollingerBands(closes);

  return result;
}

// ─────────────────────────────────────────────
// SIGNAL DETECTION — BERDASARKAN PDF
// ─────────────────────────────────────────────

/**
 * STRATEGI A — Aggressive Scalping (PDF 2.4–2.5)
 *
 * LONG:  EMA9 > EMA21 AND Close > EMA9 AND RSI 50–70 AND Volume naik
 * SHORT: EMA9 < EMA21 AND Close < EMA9 AND RSI 30–50 AND Volume naik
 *
 * Timeframe: 1M–5M
 */
function detectSignalPdfScalping(indicators, i, config = {}) {
  const {
    useBothSides  = false,
    rsiLongMin    = 50,
    rsiLongMax    = 70,
    rsiShortMin   = 30,
    rsiShortMax   = 50,
  } = config;

  const { emaFast, emaSlow, rsi, volSMA, volumes, closes } = indicators;

  if (i < 2) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i]) return null;

  const price   = closes[i];
  const emaF    = emaFast[i];
  const emaS    = emaSlow[i];
  const rsiCurr = rsi[i];
  const vol     = volumes[i];
  const volAvg  = volSMA[i];

  // Volume naik = candle saat ini di atas rata-rata volume (20 candle)
  const volUp = !volAvg || vol > volAvg * 0.9;  // Sedikit toleransi 90%

  // ── LONG: EMA9>EMA21, harga di atas EMA9, RSI 50–70, volume naik ──────────
  if (emaF > emaS && price > emaF && rsiCurr >= rsiLongMin && rsiCurr <= rsiLongMax && volUp) {
    return "LONG";
  }

  // ── SHORT: EMA9<EMA21, harga di bawah EMA9, RSI 30–50, volume naik ────────
  if (useBothSides && emaF < emaS && price < emaF && rsiCurr >= rsiShortMin && rsiCurr <= rsiShortMax && volUp) {
    return "SHORT";
  }

  return null;
}

/**
 * STRATEGI B — Day Trading (PDF 3.4–3.5)
 *
 * LONG:  EMA9 > EMA21 AND Price > EMA50 (trend bullish) AND RSI 50–70 AND Volume naik
 * SHORT: EMA9 < EMA21 AND Price < EMA50 (trend bearish) AND RSI < 50 AND Volume naik
 *
 * Timeframe: 15M–1H
 * Tambahan: tidak entry jika RSI di tengah tanpa momentum (RSI tidak bergerak)
 */
function detectSignalPdfDayTrading(indicators, i, config = {}) {
  const {
    useBothSides  = false,
    rsiLongMin    = 50,
    rsiLongMax    = 70,
    rsiShortMin   = 30,
    rsiShortMax   = 50,
  } = config;

  const { emaFast, emaSlow, emaTrend, rsi, volSMA, volumes, closes } = indicators;

  if (i < 2) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i] || !rsi[i-1]) return null;

  const price    = closes[i];
  const emaF     = emaFast[i];
  const emaS     = emaSlow[i];
  const ema50    = emaTrend ? emaTrend[i] : null;
  const rsiCurr  = rsi[i];
  const rsiPrev  = rsi[i - 1];
  const vol      = volumes[i];
  const volAvg   = volSMA[i];
  const volUp    = !volAvg || vol > volAvg * 0.9;

  // RSI harus punya momentum (sedang bergerak ke arah yang benar)
  const rsiMomUp   = rsiCurr > rsiPrev;   // RSI naik (bullish momentum)
  const rsiMomDown = rsiCurr < rsiPrev;   // RSI turun (bearish momentum)

  // Filter EMA50: price harus di atas EMA50 untuk long (trend besar bullish)
  const trendBullish = !ema50 || price > ema50;
  const trendBearish = !ema50 || price < ema50;

  // ── LONG ──────────────────────────────────────────────────────────────────
  if (
    emaF > emaS &&           // EMA9 > EMA21 (trend jangka pendek bullish)
    trendBullish &&          // Price di atas EMA50 (trend besar bullish)
    rsiCurr >= rsiLongMin && // RSI di zona momentum bullish
    rsiCurr <= rsiLongMax && // RSI belum overbought
    rsiMomUp &&              // RSI sedang naik (momentum menguat)
    volUp                    // Volume di atas rata-rata
  ) {
    return "LONG";
  }

  // ── SHORT ─────────────────────────────────────────────────────────────────
  if (
    useBothSides &&
    emaF < emaS &&           // EMA9 < EMA21 (trend jangka pendek bearish)
    trendBearish &&          // Price di bawah EMA50 (trend besar bearish)
    rsiCurr >= rsiShortMin &&
    rsiCurr <= rsiShortMax &&// RSI di zona momentum bearish
    rsiMomDown &&            // RSI sedang turun (momentum melemah)
    volUp
  ) {
    return "SHORT";
  }

  return null;
}

/**
 * STRATEGI C — Swing Trading (PDF 4.4–4.5)
 *
 * LONG:
 *   - Price > EMA50 (trend besar bullish)
 *   - Price > EMA200 (konfirmasi tren besar)
 *   - RSI dalam zona sehat 40–60 dan mulai naik (pullback selesai)
 *   - EMA21 > EMA50 (short-term trend bullish)
 *   - Candle konfirmasi bullish (close > open candle sebelumnya)
 *
 * SHORT:
 *   - Price < EMA50 (trend besar bearish)
 *   - Price < EMA200
 *   - RSI dalam zona 40–60 dan mulai turun (pullback ke resistance selesai)
 *   - EMA21 < EMA50
 *   - Candle konfirmasi bearish (close < open candle sebelumnya)
 *
 * Timeframe: 4H–1D
 */
function detectSignalPdfSwing(indicators, i, config = {}) {
  const {
    useBothSides  = false,
    rsiLongMin    = 40,
    rsiLongMax    = 60,
    rsiShortMin   = 40,
    rsiShortMax   = 60,
  } = config;

  const { emaFast, emaSlow, emaTrend, rsi, closes } = indicators;

  if (i < 3) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i] || !rsi[i-1] || !rsi[i-2]) return null;

  const price    = closes[i];
  const pricePrev = closes[i - 1];
  const ema21    = emaFast[i];    // EMA21 untuk Swing
  const ema50    = emaSlow[i];    // EMA50
  const ema200   = emaTrend ? emaTrend[i] : null;
  const rsiCurr  = rsi[i];
  const rsiPrev  = rsi[i - 1];
  const rsiPrev2 = rsi[i - 2];

  // RSI mulai naik dari area pullback (RSI[-2] < RSI[-1] < RSI[0] atau ada reversal)
  const rsiBouncingUp   = rsiCurr > rsiPrev && rsiCurr > rsiPrev2;
  const rsiBouncingDown = rsiCurr < rsiPrev && rsiCurr < rsiPrev2;

  // Candle konfirmasi: penutupan di atas high candle sebelumnya (bullish) atau sebaliknya
  const candleBullish = price > pricePrev;   // Close candle ini lebih tinggi
  const candleBearish = price < pricePrev;

  // Trend filter EMA200
  const aboveEma200 = !ema200 || price > ema200;
  const belowEma200 = !ema200 || price < ema200;

  // ── LONG: Trend besar bullish + RSI pullback ke zona sehat + konfirmasi ───
  if (
    ema21 > ema50 &&          // Short-term bullish (EMA21 > EMA50)
    price > ema50 &&          // Price di atas EMA50 (tren besar bullish)
    aboveEma200 &&            // Konfirmasi EMA200
    rsiCurr >= rsiLongMin &&  // RSI di zona sehat (bukan ekstrem)
    rsiCurr <= rsiLongMax &&
    rsiBouncingUp &&          // RSI mulai naik = pullback selesai
    candleBullish             // Konfirmasi candle bullish
  ) {
    return "LONG";
  }

  // ── SHORT: Trend besar bearish + RSI pullback ke resistance + konfirmasi ──
  if (
    useBothSides &&
    ema21 < ema50 &&          // Short-term bearish (EMA21 < EMA50)
    price < ema50 &&          // Price di bawah EMA50
    belowEma200 &&            // Konfirmasi EMA200
    rsiCurr >= rsiShortMin &&
    rsiCurr <= rsiShortMax &&
    rsiBouncingDown &&        // RSI mulai turun = pullback ke resistance selesai
    candleBearish             // Konfirmasi candle bearish
  ) {
    return "SHORT";
  }

  return null;
}

// ─────────────────────────────────────────────
// HTF TREND DETECTOR
// ─────────────────────────────────────────────

/**
 * Deteksi arah tren dari Higher Timeframe candles.
 *
 * Returns:
 *   "BULLISH"  → hanya cari LONG
 *   "BEARISH"  → hanya cari SHORT
 *   "SIDEWAYS" → no trade
 *
 * Logic:
 *   1. Hitung EMA fast/slow dari HTF candles
 *   2. Jika spread EMA < sidewaysThresholdPct% → SIDEWAYS
 *   3. EMA fast > EMA slow + price > EMA fast → BULLISH
 *   4. EMA fast < EMA slow + price < EMA fast → BEARISH
 *   5. Otherwise → SIDEWAYS (konflik sinyal)
 *
 * @param {Array}  htfCandles - Candle array dari HTF (15m/1H/1D)
 * @param {Object} config
 * @param {number} config.htfEmaFast            - EMA fast HTF (default 9)
 * @param {number} config.htfEmaSlow            - EMA slow HTF (default 21)
 * @param {number} config.sidewaysThresholdPct  - % spread min untuk dianggap trending (default 0.2)
 */
function detectHTFTrend(htfCandles, config = {}) {
  const {
    htfEmaFast           = 9,
    htfEmaSlow           = 21,
    sidewaysThresholdPct = 0.2,
  } = config;

  if (!htfCandles || htfCandles.length < htfEmaSlow + 5) return "SIDEWAYS";

  const closes = htfCandles.map(c => c.close);
  const emaF   = calcEMA(closes, htfEmaFast);
  const emaS   = calcEMA(closes, htfEmaSlow);

  // Ambil 2 candle terakhir yang closed (hindari candle live/saat ini)
  const idx   = htfCandles.length - 2;
  const ef    = emaF[idx];
  const es    = emaS[idx];
  const price = closes[idx];

  if (!ef || !es) return "SIDEWAYS";

  // Spread EMA relatif terhadap harga (dalam %)
  const spreadPct = Math.abs(ef - es) / price * 100;

  if (spreadPct < sidewaysThresholdPct) return "SIDEWAYS";

  if (ef > es && price > ef) return "BULLISH";
  if (ef < es && price < ef) return "BEARISH";

  // EMA sudah terbentuk tapi harga masih di antara — sideways
  return "SIDEWAYS";
}

/**
 * Router utama: pilih detector berdasarkan signalType
 */
function detectSignal(indicators, i, config = {}, higherTfIndicators = null) {
  const signalType = config.signalType || "PDF_DAYTRADING";

  switch (signalType) {
    case "PDF_SCALPING":    return detectSignalPdfScalping(indicators, i, config);
    case "PDF_DAYTRADING":  return detectSignalPdfDayTrading(indicators, i, config);
    case "PDF_SWING":       return detectSignalPdfSwing(indicators, i, config);

    // Legacy support (backward compat jika ada data lama)
    case "RSI_REVERSAL":    return detectSignalLegacy(indicators, i, { ...config, mode: "rsi_reversal" });
    case "EMA_MOMENTUM":    return detectSignalLegacy(indicators, i, config);
    case "MULTI_TF":        return detectSignalLegacy(indicators, i, config);
    default:                return detectSignalLegacy(indicators, i, config);
  }
}

/**
 * Legacy fallback — EMA crossover + RSI posisi
 * Dipertahankan untuk kompatibilitas data historis
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
  detectHTFTrend,
  detectSignalPdfScalping,
  detectSignalPdfDayTrading,
  detectSignalPdfSwing,
  detectSignalLegacy,
  calcPositionSize,
};
