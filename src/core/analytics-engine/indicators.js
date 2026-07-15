// ─────────────────────────────────────────────
// indicators.js — Kalkulasi indikator teknikal
//
// Implementasi berdasarkan:
// "Dokumentasi Panduan Strategi Trading"
//   Aggressive Scalping, Day Trading, Swing Trading
//
// Signal types → PDF trade-type presets (strategyDefaults.js):
//   PDF_SCALPING   → AGGRESSIVE_SCALPING (EMA9/21 + RSI zona + volume)
//   PDF_DAYTRADING → DAY_TRADING         (EMA9/21/50 + RSI 50-70 + volume)
//   PDF_SWING      → SWING_TRADING       (EMA21/50/200 + pullback RSI 40-60)
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
  if (values.length < period) return new Array(values.length).fill(null);
  const result = new Array(period - 1).fill(null);
  // Seed: jumlah pertama `period` nilai
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result.push(sum / period);
  // Sliding window O(n): tambah nilai baru, kurangi nilai lama
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
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

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * Returns { macd, signal, histogram }
 */
function calcMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  const emaFast = calcEMA(closes, fastPeriod);
  const emaSlow = calcEMA(closes, slowPeriod);
  const macd = [];

  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] === null || emaSlow[i] === null) {
      macd.push(null);
    } else {
      macd.push(emaFast[i] - emaSlow[i]);
    }
  }

  const signal = calcEMA(macd, signalPeriod);
  const histogram = [];

  for (let i = 0; i < macd.length; i++) {
    if (macd[i] === null || signal[i] === null) {
      histogram.push(null);
    } else {
      histogram.push(macd[i] - signal[i]);
    }
  }

  return { macd, signal, histogram };
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
    withMACD   = true,     // MACD aktif by default (dipakai TREND_MOMENTUM)
    macdFast   = 12,
    macdSlow   = 26,
    macdSignal = 9,
  } = config;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume || 0);
  const opens   = candles.map((c, i) => c.open ?? (i > 0 ? closes[i - 1] : c.close));
  // Session VWAP (TS_VP) needs bar timestamps; without these the whole series
  // collapses into one "session" and Value Area blocks almost all trend entries.
  const timestamps = candles.map(c => c.timestamp ?? c.openTime ?? c.time ?? null);

  const result = {
    emaFast:  calcEMA(closes, emaFast),
    emaSlow:  calcEMA(closes, emaSlow),
    rsi:      calcRSI(closes, rsiPeriod),
    atr:      calcATR(highs, lows, closes, atrPeriod),
    volSMA:   calcVolumeSMA(volumes, 20),  // Selalu hitung volume SMA
    vwap:     calcVWAP(candles),  // O(n) cumulative — precomputed once (Mean Reversion confirmation)
    closes,
    volumes,
    highs,   // S&R sejati pakai high/low, bukan close (BREAKOUT_RETEST Fix #1)
    lows,
    opens,
    timestamps,
  };

  // EMA trend filter (EMA50 untuk Day Trading, EMA200 untuk Swing)
  if (emaTrend && emaTrend > 0) {
    result.emaTrend = calcEMA(closes, emaTrend);
  }

  if (withBB) result.bb = calcBollingerBands(closes);

  // MACD (12/26/9) — momentum indicator (FIX #3: tersedia untuk semua strategi)
  if (withMACD) {
    const macdCalc = calcMACD(closes, macdFast, macdSlow, macdSignal);
    result.macd          = macdCalc.macd;
    result.macdSignal    = macdCalc.signal;
    result.macdHistogram = macdCalc.histogram;
  }

  return result;
}

// ─────────────────────────────────────────────
// RSI PULLBACK PATTERN DETECTOR
// ─────────────────────────────────────────────

/**
 * Deteksi pola RSI pullback + bounce (3 fase):
 *
 *  LONG  fase 1: RSI sebelumnya tinggi (> pullbackZoneHigh)
 *        fase 2: RSI turun ke zona pullback (pullbackZoneLow–pullbackZoneHigh)
 *        fase 3: RSI kini naik kembali dari zona itu
 *
 *  SHORT fase 1: RSI sebelumnya rendah (< pullbackZoneLow)
 *        fase 2: RSI naik ke zona pullback
 *        fase 3: RSI kini turun kembali dari zona itu
 *
 * @param {number[]} rsi        - Array RSI
 * @param {number}   i          - Index candle saat ini
 * @param {string}   direction  - "LONG" | "SHORT"
 * @param {Object}   opts
 * @param {number}   opts.pullbackZoneLow   - Batas bawah zona pullback (default 50)
 * @param {number}   opts.pullbackZoneHigh  - Batas atas zona pullback (default 62)
 * @param {number}   opts.lookback          - Berapa candle ke belakang untuk cari fase 1-2 (default 6)
 * @param {number}   opts.minBounce         - RSI harus naik minimal sekian dari lembah (default 2)
 */
function detectRsiPullbackBounce(rsi, i, direction, opts = {}) {
  const {
    pullbackZoneLow  = 50,
    pullbackZoneHigh = 62,
    lookback         = 6,
    minBounce        = 1.5,
  } = opts;

  if (i < lookback + 2) return false;

  const rsiNow  = rsi[i];
  const rsiPrev = rsi[i - 1];
  if (!rsiNow || !rsiPrev) return false;

  if (direction === "LONG") {
    // Fase 3: RSI saat ini dalam zona pullback dan SEDANG NAIK
    if (rsiNow < pullbackZoneLow || rsiNow > pullbackZoneHigh) return false;
    if (rsiNow <= rsiPrev) return false; // Harus naik dari candle sebelumnya

    // Cari fase 2: ada titik lembah (RSI minimum lokal) dalam zona pullback
    let valleyRsi = Infinity;
    for (let j = i - 1; j >= Math.max(1, i - lookback); j--) {
      if (!rsi[j]) continue;
      if (rsi[j] >= pullbackZoneLow && rsi[j] <= pullbackZoneHigh) {
        valleyRsi = Math.min(valleyRsi, rsi[j]);
      }
    }

    // RSI harus sudah bounced minimal minBounce point dari lembah
    if (rsiNow < valleyRsi + minBounce) return false;

    // Fase 1: di dalam lookback, ada RSI yang sempat di ATAS zona pullback (> pullbackZoneHigh)
    // artinya momentum bullish yang lalu memang ada sebelum pullback
    for (let j = i - 1; j >= Math.max(1, i - lookback); j--) {
      if (rsi[j] && rsi[j] > pullbackZoneHigh) return true;
    }

    // Fallback: jika tidak ketemu fase 1 tapi momentum jelas naik, tetap valid
    // (untuk scalping dimana RSI belum sempat ke > 62 tapi sudah mulai trending)
    return rsiNow > rsiPrev && rsiPrev > (rsi[i - 2] || 0);
  }

  if (direction === "SHORT") {
    // Zona pullback SHORT: RSI naik ke 38–50, lalu turun lagi
    const shortZoneLow  = 38;
    const shortZoneHigh = 50;

    // Fase 3: RSI saat ini dalam zona pullback SHORT dan SEDANG TURUN
    if (rsiNow < shortZoneLow || rsiNow > shortZoneHigh) return false;
    if (rsiNow >= rsiPrev) return false; // Harus turun dari candle sebelumnya

    // Cari puncak (RSI maximum lokal) dalam zona pullback
    let peakRsi = -Infinity;
    for (let j = i - 1; j >= Math.max(1, i - lookback); j--) {
      if (!rsi[j]) continue;
      if (rsi[j] >= shortZoneLow && rsi[j] <= shortZoneHigh) {
        peakRsi = Math.max(peakRsi, rsi[j]);
      }
    }

    if (rsiNow > peakRsi - minBounce) return false;

    // Fase 1: ada RSI yang sempat di BAWAH zona pullback (< shortZoneLow)
    for (let j = i - 1; j >= Math.max(1, i - lookback); j--) {
      if (rsi[j] && rsi[j] < shortZoneLow) return true;
    }

    return rsiNow < rsiPrev && rsiPrev < (rsi[i - 2] || 100);
  }

  return false;
}

// ─────────────────────────────────────────────
// SIGNAL DETECTION — BERDASARKAN PDF
// ─────────────────────────────────────────────

/**
 * Aggressive Scalping (AGGRESSIVE_SCALPING · PDF 2.4–2.5)
 *
 * LONG:  EMA9 > EMA21 AND Close > EMA9 AND RSI 50–70 AND Volume naik
 * SHORT: EMA9 < EMA21 AND Close < EMA9 AND RSI 30–50 AND Volume naik
 *
 * Timeframe: 1M–5M
 */
function detectSignalPdfScalping(indicators, i, config = {}) {
  const {
    useBothSides     = false,
    rsiLongMin       = 50,
    rsiLongMax       = 70,
    rsiShortMin      = 30,
    rsiShortMax      = 50,
    volSmaMultiplier = 1.0,   // dari strategies.js — Strategy A default 1.0
  } = config;

  const { emaFast, emaSlow, rsi, volSMA, volumes, closes } = indicators;

  if (i < 8) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i]) return null;

  const price   = closes[i];
  const emaF    = emaFast[i];
  const emaS    = emaSlow[i];
  const rsiCurr = rsi[i];
  const vol     = volumes[i];
  const volAvg  = volSMA[i];
  const volUp   = !volAvg || vol > volAvg * volSmaMultiplier;

  // RSI pullback pattern:
  //   LONG  → RSI pullback ke 50-60 lalu naik lagi (dari zona bullish > 60)
  //   SHORT → RSI pullback ke 40-50 lalu turun lagi (dari zona bearish < 40)
  const rsiPullbackLong  = detectRsiPullbackBounce(rsi, i, "LONG", {
    pullbackZoneLow: rsiLongMin, pullbackZoneHigh: 63, lookback: 5, minBounce: 1.5,
  });
  // Skip kalkulasi SHORT jika useBothSides=false (hemat CPU)
  const rsiPullbackShort = useBothSides
    ? detectRsiPullbackBounce(rsi, i, "SHORT", { lookback: 5, minBounce: 1.5 })
    : false;

  // ── LONG ──────────────────────────────────────────────────────────────────
  // EMA9>EMA21 (trend) + price>EMA9 (harga di atas trend) + RSI pullback zone
  // + RSI tidak ekstrem overbought + volume naik
  if (
    emaF > emaS &&                   // Trend EMA bullish
    price > emaF &&                  // Harga di atas EMA fast (konfirmasi)
    rsiCurr >= rsiLongMin &&         // RSI minimal 50
    rsiCurr <= rsiLongMax &&         // RSI tidak overbought ekstrem
    rsiPullbackLong &&               // Pola pullback RSI ke 50-60 lalu naik
    volUp                            // Volume mendukung
  ) {
    return "LONG";
  }

  // ── SHORT ─────────────────────────────────────────────────────────────────
  if (
    useBothSides &&
    emaF < emaS &&
    price < emaF &&
    rsiCurr >= rsiShortMin &&
    rsiCurr <= rsiShortMax &&
    rsiPullbackShort &&
    volUp
  ) {
    return "SHORT";
  }

  return null;
}

/**
 * Day Trading (DAY_TRADING · PDF 3.4–3.5)
 *
 * LONG:  EMA9 > EMA21 AND Price > EMA50 (trend bullish) AND RSI 50–70 AND Volume naik
 * SHORT: EMA9 < EMA21 AND Price < EMA50 (trend bearish) AND RSI < 50 AND Volume naik
 *
 * Timeframe: 15M–1H
 * Tambahan: tidak entry jika RSI di tengah tanpa momentum (RSI tidak bergerak)
 */
function detectSignalPdfDayTrading(indicators, i, config = {}) {
  const {
    useBothSides     = false,
    rsiLongMin       = 50,
    rsiLongMax       = 70,
    rsiShortMin      = 30,
    rsiShortMax      = 50,
    volSmaMultiplier = 1.0,   // dari strategies.js — Strategy B default 1.0
  } = config;

  const { emaFast, emaSlow, emaTrend, rsi, volSMA, volumes, closes } = indicators;

  if (i < 8) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i] || !rsi[i-1]) return null;

  const price    = closes[i];
  const emaF     = emaFast[i];
  const emaS     = emaSlow[i];
  const ema50    = emaTrend ? emaTrend[i] : null;
  const rsiCurr  = rsi[i];
  const vol      = volumes[i];
  const volAvg   = volSMA[i];
  const volUp    = !volAvg || vol > volAvg * volSmaMultiplier;

  // Harga di atas/bawah EMA trend (EMA50)
  const trendBullish = !ema50 || price > ema50;
  const trendBearish = !ema50 || price < ema50;

  // RSI pullback pattern (zona lebih ketat untuk day trading):
  //   LONG  → RSI pullback ke zona 50-65, lalu naik lagi (dari > 65)
  //   SHORT → RSI pullback ke zona 35-50, lalu turun lagi (dari < 35)
  const rsiPullbackLong  = detectRsiPullbackBounce(rsi, i, "LONG", {
    pullbackZoneLow: rsiLongMin, pullbackZoneHigh: 65, lookback: 6, minBounce: 2,
  });
  // Skip kalkulasi SHORT jika useBothSides=false (hemat CPU)
  const rsiPullbackShort = useBothSides
    ? detectRsiPullbackBounce(rsi, i, "SHORT", { lookback: 6, minBounce: 2 })
    : false;

  // ── LONG ──────────────────────────────────────────────────────────────────
  // EMA9>EMA21 + price di atas EMA50 + RSI pullback ke 50-65 lalu naik
  // + RSI tidak overbought ekstrem (> 70) + volume mendukung
  if (
    emaF > emaS &&           // EMA9 > EMA21 (trend jangka pendek bullish)
    trendBullish &&          // Harga di atas EMA50 (trend besar bullish)
    rsiCurr >= rsiLongMin && // RSI tidak oversold (minimal 50)
    rsiCurr <= rsiLongMax && // RSI tidak overbought ekstrem
    rsiPullbackLong &&       // Pola pullback RSI ke 50-65 lalu naik lagi
    volUp                    // Volume mendukung
  ) {
    return "LONG";
  }

  // ── SHORT ─────────────────────────────────────────────────────────────────
  // EMA9<EMA21 + price di bawah EMA50 + RSI pullback ke 35-50 lalu turun
  // + RSI tidak oversold ekstrem (< 30) + volume mendukung
  if (
    useBothSides &&
    emaF < emaS &&           // EMA9 < EMA21 (trend jangka pendek bearish)
    trendBearish &&          // Harga di bawah EMA50
    rsiCurr >= rsiShortMin &&// RSI tidak oversold ekstrem
    rsiCurr <= rsiShortMax &&// RSI masih di zona bearish (< 50)
    rsiPullbackShort &&      // Pola pullback RSI ke 35-50 lalu turun lagi
    volUp
  ) {
    return "SHORT";
  }

  return null;
}

/**
 * Swing Trading (SWING_TRADING · PDF 4.4–4.5)
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
    useBothSides     = false,
    rsiLongMin       = 40,
    rsiLongMax       = 60,
    rsiShortMin      = 40,
    rsiShortMax      = 60,
    volSmaMultiplier = 0.8,   // dari strategies.js — Strategy C default 0.8
  } = config;

  const { emaFast, emaSlow, emaTrend, rsi, closes, volumes, volSMA } = indicators;

  if (i < 3) return null;
  if (!emaFast[i] || !emaSlow[i] || !rsi[i] || !rsi[i-1] || !rsi[i-2]) return null;

  const price     = closes[i];
  const pricePrev = closes[i - 1];
  const ema21     = emaFast[i];   // EMA21 untuk Swing
  const ema50     = emaSlow[i];   // EMA50
  const ema200    = emaTrend ? emaTrend[i] : null;
  const rsiCurr   = rsi[i];

  // Volume filter (0.8× SMA — lebih longgar dari A/B karena swing TF panjang)
  const vol    = volumes ? volumes[i] : null;
  const volAvg = volSMA  ? volSMA[i]  : null;
  const volUp  = !volAvg || !vol || vol > volAvg * volSmaMultiplier;

  // Trend filter EMA200
  const aboveEma200 = !ema200 || price > ema200;
  const belowEma200 = !ema200 || price < ema200;

  // Candle konfirmasi bullish/bearish
  const candleBullish = price > pricePrev;
  const candleBearish = price < pricePrev;

  // RSI pullback pattern (zona swing 40–60):
  //   LONG  → RSI pullback ke zona 40-58, lalu naik kembali (momentum resume)
  //   SHORT → RSI pullback ke zona 42-60, lalu turun kembali
  const rsiPullbackLong  = detectRsiPullbackBounce(rsi, i, "LONG", {
    pullbackZoneLow: rsiLongMin,   // 40
    pullbackZoneHigh: 58,
    lookback: 8,
    minBounce: 1.5,
  });
  // Skip kalkulasi SHORT jika useBothSides=false (hemat CPU)
  const rsiPullbackShort = useBothSides
    ? detectRsiPullbackBounce(rsi, i, "SHORT", { lookback: 8, minBounce: 1.5 })
    : false;

  // ── LONG: Trend besar bullish + RSI pullback ke 40-58 lalu naik + candle confirm ──
  if (
    ema21 > ema50 &&          // EMA21 > EMA50: trend menengah bullish
    price > ema50 &&          // Harga di atas EMA50 (trend besar bullish)
    aboveEma200 &&            // Harga di atas EMA200 (konfirmasi tren panjang)
    rsiCurr >= rsiLongMin &&  // RSI tidak oversold ekstrem
    rsiCurr <= rsiLongMax &&  // RSI tidak overbought (< 60)
    rsiPullbackLong &&        // Pola pullback RSI ke zona sehat lalu naik
    candleBullish &&          // Candle konfirmasi bullish
    volUp                     // Volume ≥ 0.8× SMA (konfirmasi momentum)
  ) {
    return "LONG";
  }

  // ── SHORT: Trend besar bearish + RSI pullback ke 42-60 lalu turun + candle confirm ──
  if (
    useBothSides &&
    ema21 < ema50 &&          // EMA21 < EMA50: trend menengah bearish
    price < ema50 &&          // Harga di bawah EMA50
    belowEma200 &&            // Harga di bawah EMA200
    rsiCurr >= rsiShortMin && // RSI tidak oversold ekstrem
    rsiCurr <= rsiShortMax && // RSI tidak overbought (pullback ke zona bearish)
    rsiPullbackShort &&       // Pola pullback RSI ke zona resistansi lalu turun
    candleBearish &&          // Candle konfirmasi bearish
    volUp                     // Volume ≥ 0.8× SMA (konfirmasi momentum)
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

// ─────────────────────────────────────────────
// SIDEWAYS RANGE + BREAKOUT DETECTOR
// ─────────────────────────────────────────────

/**
 * Hitung range konsolidasi dari N candle HTF terakhir yang sudah closed.
 *
 * @param {Array}  htfCandles
 * @param {number} lookback — jumlah candle untuk hitung range (default 20)
 * @returns {{ high, low, mid, range }} | null
 */
function calcSidewaysRange(htfCandles, lookback = 20) {
  if (!htfCandles || htfCandles.length < lookback + 2) return null;
  // Gunakan candle yang sudah closed (kecualikan candle live saat ini)
  const confirmed = htfCandles.slice(-lookback - 1, -1);
  const high = Math.max(...confirmed.map(c => c.high));
  const low  = Math.min(...confirmed.map(c => c.low));
  return { high, low, mid: (high + low) / 2, range: high - low };
}

/**
 * Deteksi breakout valid dari range sideways.
 * Dipakai oleh Strat B (entry langsung) dan Strat C (konfirmasi sebelum retest).
 *
 * Kondisi LONG breakout:
 *   candle HTF close > rangeHigh + buffer
 *   AND EMA fast > EMA slow (HTF aligned bullish)
 *   AND RSI > 52 (momentum bullish)
 *   AND volume > volSMA × volMultiplier
 *
 * @param {Array}  htfCandles
 * @param {Object} config
 *   rangeLookback   — jumlah candle untuk range (default 20)
 *   volMultiplier   — volume minimum breakout vs SMA (default 1.2)
 *   bufferAtrMult   — buffer tepi range = ATR × nilai ini (default 0.3)
 *   htfEmaFast/Slow — EMA HTF untuk konfirmasi arah
 *   rsiBreakoutMin  — RSI minimum untuk LONG breakout (default 52)
 *   rsiBreakoutMax  — RSI maximum untuk SHORT breakout (default 48)
 *
 * @returns {{ signal, rangeHigh, rangeLow, rangeEdge, buffer, atr }} | null
 */
function detectSidewaysBreakout(htfCandles, config = {}) {
  const {
    rangeLookback  = 20,
    volMultiplier  = 1.2,
    bufferAtrMult  = 0.3,
    htfEmaFast     = 9,
    htfEmaSlow     = 21,
    rsiBreakoutMin = 52,
    rsiBreakoutMax = 48,
  } = config;

  if (!htfCandles || htfCandles.length < rangeLookback + 5) return null;

  const range = calcSidewaysRange(htfCandles, rangeLookback);
  if (!range) return null;

  const idx        = htfCandles.length - 2;   // candle terakhir yang sudah closed
  const lastCandle = htfCandles[idx];
  const closePrice = lastCandle.close;
  const volume     = lastCandle.volume || 0;

  const highs  = htfCandles.map(c => c.high);
  const lows   = htfCandles.map(c => c.low);
  const closes = htfCandles.map(c => c.close);
  const vols   = htfCandles.map(c => c.volume || 0);

  // ATR untuk buffer tepi range
  const atrArr = calcATR(highs, lows, closes, 14);
  const atrNow = atrArr[idx];
  const buffer = atrNow ? atrNow * bufferAtrMult : range.range * 0.05;

  // EMA alignment di HTF
  const emaFArr = calcEMA(closes, htfEmaFast);
  const emaSArr = calcEMA(closes, htfEmaSlow);
  const ef      = emaFArr[idx];
  const es      = emaSArr[idx];
  if (!ef || !es) return null;

  // RSI momentum
  const rsiArr = calcRSI(closes, 14);
  const rsiNow = rsiArr[idx];
  if (!rsiNow) return null;

  // Volume konfirmasi (lebih ketat dari entry trend biasa)
  const volSMAArr = calcVolumeSMA(vols, 20);
  const volAvg    = volSMAArr[idx];
  const volOk     = !volAvg || volume > volAvg * volMultiplier;

  // ── LONG breakout: close di atas rangeHigh + buffer ────────────────────────
  if (
    closePrice > range.high + buffer &&
    ef > es &&
    rsiNow > rsiBreakoutMin &&
    volOk
  ) {
    return {
      signal:    "LONG",
      rangeHigh: range.high,
      rangeLow:  range.low,
      rangeEdge: range.high,  // anchor SL untuk LONG
      buffer,
      atr:       atrNow,
    };
  }

  // ── SHORT breakout: close di bawah rangeLow - buffer ───────────────────────
  if (
    closePrice < range.low - buffer &&
    ef < es &&
    rsiNow < rsiBreakoutMax &&
    volOk
  ) {
    return {
      signal:    "SHORT",
      rangeHigh: range.high,
      rangeLow:  range.low,
      rangeEdge: range.low,   // anchor SL untuk SHORT
      buffer,
      atr:       atrNow,
    };
  }

  return null;
}

// ─────────────────────────────────────────────

/**
 * Router utama: pilih detector berdasarkan signalType
 */
// Singleton agar BotEngine bisa mengambil metadata setelah signal
let _adaptiveFusionInstance = null;
let _trendFollowingInstance = null;
let _meanReversionInstance = null;
let _breakoutRetestInstance = null;
function getAdaptiveFusionInstance() {
  if (!_adaptiveFusionInstance) {
    // Sprint 8: use umbrella (SMC + Wyckoff + VSA) so detectSignal runs 3-component voting
    const { strategyRegistry } = require("../strategy-engine");
    _adaptiveFusionInstance = strategyRegistry.get("AF_SMC");
    if (!_adaptiveFusionInstance) {
      const AdaptiveFusionUmbrella = require("../strategy-engine/umbrellas/AdaptiveFusionUmbrella");
      _adaptiveFusionInstance = new AdaptiveFusionUmbrella();
    }
  }
  return _adaptiveFusionInstance;
}

/**
 * Expose metadata sinyal ADAPTIVE_FUSION terakhir (component, scores, dll)
 * agar BotEngine bisa pilih SL/TP yang tepat per komponen.
 */
function getAdaptiveFusionMeta() {
  return _adaptiveFusionInstance ? _adaptiveFusionInstance.getLastSignalMeta() : null;
}

/**
 * Singleton getter untuk TREND_FOLLOWING / Trend Surge umbrella
 * (TS_TF race bag: Trend Following + Dow Theory + Auction Market Theory —
 * same instance as backtest registry; Sprint 12 race-to-confirm).
 */
function getTrendFollowingInstance() {
  if (!_trendFollowingInstance) {
    const { strategyRegistry } = require("../strategy-engine");
    _trendFollowingInstance = strategyRegistry.get("TS_TF");
    if (!_trendFollowingInstance) {
      const TrendSurgeUmbrella = require("../strategy-engine/umbrellas/TrendSurgeUmbrella");
      _trendFollowingInstance = new TrendSurgeUmbrella();
    }
  }
  return _trendFollowingInstance;
}

/**
 * Singleton getter untuk MEAN_REVERSION strategy
 */
function getMeanReversionInstance() {
  if (!_meanReversionInstance) {
    const MeanReversionStrategy = require("../strategy-engine/implementations/MeanReversionStrategy");
    _meanReversionInstance = new MeanReversionStrategy();
  }
  return _meanReversionInstance;
}

function getBreakoutRetestInstance() {
  if (!_breakoutRetestInstance) {
    const BreakoutTradingStrategy = require("../strategy-engine/implementations/BreakoutTradingStrategy");
    _breakoutRetestInstance = new BreakoutTradingStrategy();
  }
  return _breakoutRetestInstance;
}

/** Last BS_BR / BREAKOUT_RETEST signal meta (for structure SL / enrichment). */
function getBreakoutRetestMeta() {
  return _breakoutRetestInstance ? _breakoutRetestInstance.getLastSignalMeta() : null;
}

function detectSignal(indicators, i, config = {}, higherTfIndicators = null) {
  const signalType = config.signalType || "PDF_DAYTRADING";

  switch (signalType) {
    case "PDF_SCALPING":    return detectSignalPdfScalping(indicators, i, config);
    case "PDF_DAYTRADING":  return detectSignalPdfDayTrading(indicators, i, config);
    case "PDF_SWING":       return detectSignalPdfSwing(indicators, i, config);

    // ADAPTIVE_FUSION — multi-component voting dengan ranking filter
    case "ADAPTIVE_FUSION": {
      const afs = getAdaptiveFusionInstance();
      return afs.detectSignal(indicators, i, config);
    }

    // TREND_FOLLOWING — Multi-TF trend following with Donchian + ADX (FORGE tier)
    case "TREND_FOLLOWING":
    case "TS_TF": {
      const tf = getTrendFollowingInstance();
      return tf.detectSignal(indicators, i, config);
    }

    // MEAN_REVERSION / MD_MR — layered BB+RSI → ADX gate → OB/FVG (MINT tier)
    case "MEAN_REVERSION":
    case "MD_MR":
    case "MR": {
      const mr = getMeanReversionInstance();
      return mr.detectSignal(indicators, i, config);
    }

    // BREAKOUT_RETEST — level breakout + retest confirmation (VAULT tier)
    case "BREAKOUT_RETEST": {
      const br = getBreakoutRetestInstance();
      return br.detectSignal(indicators, i, config);
    }

    // Legacy support
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

/**
 * Donchian Channel — highest high / lowest low over the last `period` bars.
 * Dipakai strategi Trend Following: breakout channel = konfirmasi lanjutan tren.
 * upper[i]/lower[i] mencakup bar i; untuk deteksi breakout tanpa lookahead,
 * bandingkan close bar-i dengan channel dari bar (i-1).
 * @returns {{ upper: (number|null)[], lower: (number|null)[], mid: (number|null)[] }}
 */
function calcDonchian(highs, lows, period = 20) {
  const n = highs.length;
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  const mid   = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j]  < lo) lo = lows[j];
    }
    upper[i] = hi;
    lower[i] = lo;
    mid[i]   = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

/**
 * ADX (Average Directional Index) — Wilder. Ukur KEKUATAN tren (bukan arah).
 * ADX tinggi (>25) = tren kuat; rendah (<20) = sideways. Trend Following hanya
 * entry saat ADX di atas threshold. Mengembalikan { adx, plusDI, minusDI }.
 * @returns {{ adx: (number|null)[], plusDI: (number|null)[], minusDI: (number|null)[] }}
 */
function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const adx    = new Array(n).fill(null);
  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  if (n < period * 2) return { adx, plusDI, minusDI };

  const tr = new Array(n).fill(0);
  const plusDM  = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up   = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i]  = (up > down && up > 0)   ? up   : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
  }

  // Wilder smoothing seeded at index `period`
  let trS = 0, plusS = 0, minusS = 0;
  for (let i = 1; i <= period; i++) { trS += tr[i]; plusS += plusDM[i]; minusS += minusDM[i]; }

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    if (i > period) {
      trS    = trS    - trS / period    + tr[i];
      plusS  = plusS  - plusS / period  + plusDM[i];
      minusS = minusS - minusS / period + minusDM[i];
    }
    const pDI = trS === 0 ? 0 : (100 * plusS / trS);
    const mDI = trS === 0 ? 0 : (100 * minusS / trS);
    plusDI[i]  = pDI;
    minusDI[i] = mDI;
    const diSum = pDI + mDI;
    dx[i] = diSum === 0 ? 0 : (100 * Math.abs(pDI - mDI) / diSum);
  }

  // ADX = Wilder-smoothed DX, seeded as average of first `period` DX values
  const firstDxIdx = period;
  const adxSeedEnd = firstDxIdx + period - 1;
  if (adxSeedEnd < n) {
    let sum = 0;
    for (let i = firstDxIdx; i <= adxSeedEnd; i++) sum += dx[i] ?? 0;
    adx[adxSeedEnd] = sum / period;
    for (let i = adxSeedEnd + 1; i < n; i++) {
      adx[i] = ((adx[i - 1] * (period - 1)) + (dx[i] ?? 0)) / period;
    }
  }
  return { adx, plusDI, minusDI };
}

/**
 * Hitung VWAP (Volume Weighted Average Price).
 * VWAP = Cumulative(TP × Volume) / Cumulative(Volume)
 * dimana TP = (High + Low + Close) / 3
 */
function calcVWAP(candles) {
  const vwap = new Array(candles.length).fill(null);
  const WINDOW = 200; // FIX-MR-01: rolling window = live fetch limit for parity

  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - WINDOW + 1);
    let cumPV = 0, cumVol = 0;
    for (let j = start; j <= i; j++) {
      const { high, low, close, volume } = candles[j];
      const typicalPrice = (high + low + close) / 3;
      cumPV += typicalPrice * volume;
      cumVol += volume;
    }
    vwap[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return vwap;
}

/**
 * Hitung z-score (standard deviation dari mean).
 * z = (value - mean) / std_dev
 * Berguna untuk mean reversion: z > 2 oversold, z < -2 overbought.
 */
function calcZScore(values, period = 20) {
  const zscores = new Array(values.length).fill(null);

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;

    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / period;
    const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
    const std = Math.sqrt(variance);

    zscores[i] = std > 0 ? (values[i] - mean) / std : 0;
  }
  return zscores;
}

module.exports = {
  calcEMA,
  calcRSI,
  calcATR,
  calcSMA,
  calcDonchian,
  calcADX,
  calcVWAP,
  calcZScore,
  calcBollingerBands,
  calcMACD,
  calcVolumeSMA,
  calcIndicators,
  detectSignal,
  detectHTFTrend,
  detectRsiPullbackBounce,
  detectSignalPdfScalping,
  detectSignalPdfDayTrading,
  detectSignalPdfSwing,
  detectSignalLegacy,
  getAdaptiveFusionMeta,
  getBreakoutRetestMeta,
  getBreakoutRetestInstance,
  getTrendFollowingInstance,
  getMeanReversionInstance,
  calcPositionSize,
  calcSidewaysRange,
  detectSidewaysBreakout,
};
