const { calcRSI, calcBollingerBands, calcVWAP, calcZScore } = require("../indicators.js");

/**
 * Mean Reversion Strategy — 2 Komponen (Scalping + Intraday)
 *
 * Konsep: Harga kembali ke moving average (mean reversion)
 * Indikator: BB, RSI, VWAP, z-score
 *
 * Komponen:
 *   A (Scalping): 5m entry, RSI < 28, BB(20, 1.5σ), hold 5-15m, TP 1.2-1.8% (1:2.5 RR)
 *   B (Intraday): 15m entry, RSI < 32, BB(20, 2.0σ), hold 30-90m, TP 2.5-4.0% (1:2 RR)
 */
class MeanReversionStrategy {
  constructor() {
    this.name = "Mean Reversion";
    this.shortName = "MR";
    this.components = [
      { id: "A", name: "Scalping", timeframe: "5m" },
      { id: "B", name: "Intraday", timeframe: "15m" },
    ];
  }

  /**
   * detectSignal(candles, config)
   * @param {Array} candles — OHLCV dari TF dominan (bukan HTF)
   * @param {Object} config
   * @returns {{ signal: 'LONG'|'SHORT'|null, component: 'A'|'B', confidence: number, reason: string }}
   */
  detectSignal(candles, config = {}) {
    const {
      bbPeriod = 20,
      bbStdDevA = 1.5,  // Scalping
      bbStdDevB = 2.0,  // Intraday
      rsiPeriod = 14,
      rsiOversoldA = 28,  // Scalping
      rsiOversoldB = 32,  // Intraday
      rsiOverboughtA = 72,  // Scalping
      rsiOverboughtB = 68,  // Intraday
      minVolumeVolatility = true,
    } = config;

    if (!candles || candles.length < Math.max(bbPeriod + 1, rsiPeriod + 1)) {
      return { signal: null, component: null, confidence: 0, reason: "Data insufficient" };
    }

    const closes = candles.map(c => c.close);
    const n = closes.length - 1;

    // Hitung indikator
    const rsi = calcRSI(closes, rsiPeriod);
    const bbA = calcBollingerBands(closes, bbPeriod, bbStdDevA);
    const bbB = calcBollingerBands(closes, bbPeriod, bbStdDevB);
    const vwap = calcVWAP(candles);

    const rsiNow = rsi[n];
    const close = closes[n];
    const vwapNow = vwap[n];

    if (!rsiNow || !vwapNow) {
      return { signal: null, component: null, confidence: 0, reason: "Indicators not ready" };
    }

    // ─── COMPONENT A: SCALPING (5m) ───
    const bbALower = bbA.lower[n];
    const bbAUpper = bbA.upper[n];

    const isComponentALong =
      rsiNow < rsiOversoldA &&
      close < bbALower &&
      close < vwapNow;

    const isComponentAShort =
      rsiNow > rsiOverboughtA &&
      close > bbAUpper &&
      close > vwapNow;

    // ─── COMPONENT B: INTRADAY (15m) ───
    const bbBLower = bbB.lower[n];
    const bbBUpper = bbB.upper[n];

    const isComponentBLong =
      rsiNow < rsiOversoldB &&
      close < bbBLower &&
      close < vwapNow;

    const isComponentBShort =
      rsiNow > rsiOverboughtB &&
      close > bbBUpper &&
      close > vwapNow;

    // ─── SELECT SIGNAL ───
    // Prioritize Component A (Scalping) untuk fast revert, fallback to B
    if (isComponentALong) {
      return {
        signal: "LONG",
        component: "A",
        confidence: 65,
        reason: `Scalping: RSI ${rsiNow.toFixed(1)} < ${rsiOversoldA}, price touch BB-lower, below VWAP`,
      };
    }
    if (isComponentAShort) {
      return {
        signal: "SHORT",
        component: "A",
        confidence: 65,
        reason: `Scalping: RSI ${rsiNow.toFixed(1)} > ${rsiOverboughtA}, price touch BB-upper, above VWAP`,
      };
    }

    if (isComponentBLong) {
      return {
        signal: "LONG",
        component: "B",
        confidence: 60,
        reason: `Intraday: RSI ${rsiNow.toFixed(1)} < ${rsiOversoldB}, price touch BB-lower, below VWAP`,
      };
    }
    if (isComponentBShort) {
      return {
        signal: "SHORT",
        component: "B",
        confidence: 60,
        reason: `Intraday: RSI ${rsiNow.toFixed(1)} > ${rsiOverboughtB}, price touch BB-upper, above VWAP`,
      };
    }

    return { signal: null, component: null, confidence: 0, reason: "No mean reversion signal" };
  }

  /**
   * getRiskConfig(candles, signal, config)
   * Return { sl, tp, holdMinutes }
   */
  getRiskConfig(candles, signal, config = {}) {
    const {
      atrMult = 1.4,
      riskPerTrade = 0.008,
    } = config;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);

    const n = closes.length - 1;
    const close = closes[n];
    const high = highs[n];
    const low = lows[n];

    // ATR-based stop loss
    const tr = Math.max(high - low, Math.abs(high - closes[n - 1]), Math.abs(low - closes[n - 1]));
    const sl = Math.abs(tr) * atrMult;

    // TP depends on component
    if (signal.component === "A") {
      // Scalping: 1.2-1.8% profit, 1:2.5 RR
      const tp = sl * 2.5;
      return {
        sl,
        tp,
        holdMinutes: 15,  // Exit after 15min if not profitable
        partialTp: 1.0,
        trailingStopAtrMult: 0.3,
      };
    } else {
      // Intraday: 2.5-4.0% profit, 1:2 RR
      const tp = sl * 2.0;
      return {
        sl,
        tp,
        holdMinutes: 90,  // Hold up to 90min
        partialTp: null,  // No partial TP for intraday
        trailingStop: false,  // No trailing, let profit run
      };
    }
  }
}

module.exports = MeanReversionStrategy;
