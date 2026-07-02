/**
 * MeanReversionStrategy.js — Mean Drift (MD_MR): Dual-Component Mean Reversion
 *
 * Philosophy: "Trade price extremes — fast for scalping, sustained for intraday"
 *
 * Komponenten (tiered by market microstructure):
 *   A (Scalping):  5m entry, RSI<28/RSI>72, BB(20, 1.5σ), hold 5-15min, TP 1.2-1.8% (1:2.5 RR)
 *   B (Intraday): 15m entry, RSI<32/RSI>68, BB(20, 2.0σ), hold 30-90min, TP 2.5-4.0% (1:2 RR)
 *
 * Both components use:
 *   - Dual-gate logic: BB touch + RSI agreement + VWAP confirmation
 *   - No HTF regime (single TF entry for faster reaction)
 *   - Vol SMA gate (reject dead markets)
 *   - RR-optimized stops: tight for scalps, wider for intraday swings
 */

const StrategyBase = require("../base/StrategyBase");
// Indicators (RSI/ATR/BB/VWAP) are precomputed once by calcIndicators and read
// per-bar from the `indicators` arg; this strategy uses its own BB helper for
// the dual-σ bands, so no direct indicators import is needed here.

class MeanReversionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MEAN_REVERSION",
      label: "Mean Reversion (Mean Drift - MD_MR)",
      description:
        "Dual-component mean reversion strategy. " +
        "Component A (Scalping): 5m entry, RSI<28, BB(1.5σ), hold 5-15min. " +
        "Component B (Intraday): 15m entry, RSI<32, BB(2.0σ), hold 30-90min. " +
        "Optimal for MINT tier (Rp10-15M+). RR 1:2.5 (A), 1:2 (B).",
      version: "2.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      // ═══ SHARED SETTINGS ═════════════════════════════════════════════════
      rsiPeriod: 14,
      bbPeriod: 20,
      volSMAPeriod: 20,
      minVolRatio: 0.7,
      atrMult: 1.4,
      leverage: 1.0,
      riskPerTrade: 0.008,    // 0.8% per trade (split 0.4% A + 0.4% B)

      // ═══ COMPONENT A: SCALPING (5m) ════════════════════════════════════
      bbStdDevA: 1.5,         // Tight bands for fast mean reversion touch
      rsiOversoldA: 28,       // LONG entry threshold
      rsiOverboughtA: 72,     // SHORT entry threshold
      tpMultiplierA: 2.5,     // TP = 2.5× SL → 1:2.5 RR
      holdMinutesA: 15,       // Exit after 15 min if not profitable
      trailingStopAtrMultA: 0.3,

      // ═══ COMPONENT B: INTRADAY (15m) ════════════════════════════════════
      bbStdDevB: 2.0,         // Looser bands for 30-90min swing
      rsiOversoldB: 32,       // LONG entry threshold
      rsiOverboughtB: 68,     // SHORT entry threshold
      tpMultiplierB: 2.0,     // TP = 2.0× SL → 1:2 RR
      holdMinutesB: 90,       // Hold up to 90 min for full swing
      trailingStopAtrMultB: 0,// No trailing for intraday (let profit run)

      // Position management
      maxTradesPerDay: 5,     // More for dual component
      minVotes: 1,            // Single component can enter
      maxConcurrentTrades: 3, // Up to 3 positions (1 per entry + 1 carry)
    };

    this._lastBBLevels = null;
  }

  /**
   * Calculate Bollinger Bands
   * Returns: { middle, upper, lower, bandwidth, std }
   */
  calculateBollingerBands(closes, period = 20, stdDev = 2.0) {
    if (!closes || closes.length < period) return null;

    const lookback = closes.slice(-period);
    const mean = lookback.reduce((a, b) => a + b, 0) / period;

    const variance = lookback.reduce((sum, val) => {
      return sum + Math.pow(val - mean, 2);
    }, 0) / period;

    const std = Math.sqrt(variance);
    const bandwidth = std * stdDev;

    return {
      middle: mean,
      upper: mean + bandwidth,
      lower: mean - bandwidth,
      bandwidth: bandwidth,
      std: std,
    };
  }

  /**
   * Main signal detection — dual-component mean reversion (Scalping A / Intraday B).
   */
  detectSignal(indicators, lastIdx, config = {}) {
    // Need ≥50 bars for stable indicators (20-period BB + 14-period RSI)
    if (lastIdx < 50) return null;

    const closes = (indicators.closes || []).slice(0, lastIdx + 1);
    if (closes.length <= lastIdx) return null;

    const rsiValues = indicators.rsi || [];
    const volumes = (indicators.volumes || []).slice(0, lastIdx + 1);
    const atr = indicators.atr?.[lastIdx];
    const volSMA = indicators.volSMA?.[lastIdx];

    // Fail closed if indicators incomplete
    if (!atr || !rsiValues[lastIdx] || !volSMA || volSMA <= 0) return null;

    const rsiNow = rsiValues[lastIdx];
    const close = closes[lastIdx];
    const volRatio = volumes[lastIdx] / volSMA;

    // Volume gate — reject dead markets
    if (volRatio < this.config.minVolRatio) return null;

    // Calculate BB for both components
    const bbA = this.calculateBollingerBands(closes, this.config.bbPeriod, this.config.bbStdDevA);
    const bbB = this.calculateBollingerBands(closes, this.config.bbPeriod, this.config.bbStdDevB);

    if (!bbA || !bbB) return null;

    // VWAP for confirmation — read the precomputed O(n) array from calcIndicators.
    // (Recomputing calcVWAP(slice) per bar was O(n²) AND, when indicators.candles
    //  was absent, fell back to `close` → gate `close < close` blocked ALL signals.)
    const vwap = indicators.vwap?.[lastIdx] ?? close;

    this._lastBBLevels = { bbA, bbB, vwap };

    // ═══ COMPONENT A: SCALPING (5m) ═══════════════════════════════════════
    const isCompALong =
      rsiNow < this.config.rsiOversoldA &&
      close < bbA.lower &&
      close < vwap;

    const isCompAShort =
      rsiNow > this.config.rsiOverboughtA &&
      close > bbA.upper &&
      close > vwap;

    // ═══ COMPONENT B: INTRADAY (15m) ═══════════════════════════════════════
    const isCompBLong =
      rsiNow < this.config.rsiOversoldB &&
      close < bbB.lower &&
      close < vwap;

    const isCompBShort =
      rsiNow > this.config.rsiOverboughtB &&
      close > bbB.upper &&
      close > vwap;

    // ═══ RESOLVE SIGNAL + STORE META ══════════════════════════════════════
    // Contract parity with BotEngine + RealStrategyBacktestService: detectSignal
    // returns a STRING ("LONG"/"SHORT"/null); component/context is exposed via
    // getLastSignalMeta() and consumed by calculateRiskConfig(...,component,...).
    let signal = null, component = null, confidence = 0, reason = null;
    if (isCompALong)       { signal = "LONG";  component = "Scalping"; confidence = 65; reason = `Scalping: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldA}, BB(1.5σ) touch, below VWAP`; }
    else if (isCompAShort) { signal = "SHORT"; component = "Scalping"; confidence = 65; reason = `Scalping: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtA}, BB(1.5σ) touch, above VWAP`; }
    else if (isCompBLong)  { signal = "LONG";  component = "Intraday"; confidence = 60; reason = `Intraday: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldB}, BB(2.0σ) touch, below VWAP`; }
    else if (isCompBShort) { signal = "SHORT"; component = "Intraday"; confidence = 60; reason = `Intraday: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtB}, BB(2.0σ) touch, above VWAP`; }

    if (!signal) { this._lastSignalMeta = null; return null; }

    this._lastSignalMeta = { component, componentConfidence: confidence, marketCond: "MEAN_REVERT", reason };
    return signal;
  }

  /** Component/context of the most recent detectSignal (real-engine + live parity). */
  getLastSignalMeta() {
    return this._lastSignalMeta || null;
  }

  /**
   * Calculate SL/TP based on component and ATR
   * Component A (Scalping): SL 1.4×ATR, TP 3.5×ATR (1:2.5 RR)
   * Component B (Intraday): SL 1.4×ATR, TP 2.8×ATR (1:2.0 RR)
   */
  calculateRiskConfig(entryPrice, atr, signal, component = null, _opts = {}) {
    // `component` is the string tag from getLastSignalMeta() ("Scalping"/"Intraday").
    // Accepts legacy object-signal for backward compat.
    const comp = component || (typeof signal === "object" ? signal.component : null) || "Intraday";
    const isComponentA = comp === "Scalping" || comp === "A";
    const side = typeof signal === "object" ? signal.signal : signal;

    const slDist = atr * this.config.atrMult;  // 1.4×ATR for both components
    // tpMultiplier IS the reward:risk ratio → TP distance = SL distance × RR.
    // (A=2.5 → 1:2.5, B=2.0 → 1:2.0). Computing off slDist keeps RR exact.
    const tpMultiplier = isComponentA ? this.config.tpMultiplierA : this.config.tpMultiplierB;
    const tpDist = slDist * tpMultiplier;

    let stopLoss, takeProfit;
    if (side === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {  // SHORT
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      component: isComponentA ? "Scalping" : "Intraday",
      holdMinutes: isComponentA ? this.config.holdMinutesA : this.config.holdMinutesB,
      trailingStopMult: isComponentA ? this.config.trailingStopAtrMultA : this.config.trailingStopAtrMultB,
    };
  }

  /**
   * Validate market condition
   * Mean reversion works best in choppy/sideways (weak trend)
   */
  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 6) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 6%)` };
    }

    if (trendStrength > 0.7) {
      return { valid: false, reason: `Market too trending (strength ${trendStrength.toFixed(2)} > 0.7), use trend strategy` };
    }

    if (trendStrength < 0.2) {
      return { valid: true, reason: "Choppy market - IDEAL for mean reversion" };
    }

    return { valid: true, reason: "Market suitable for mean reversion" };
  }

  /**
   * Rank strategy by market conditions
   */
  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    // Mean reversion LOVES choppy/weak trend markets
    if (trendStrength < 0.3) score += 30;
    else if (trendStrength < 0.5) score += 15;
    else if (trendStrength > 0.7) score -= 30;

    // Moderate volatility good (not too tight, not too wild)
    if (volatility >= 1.0 && volatility <= 4.0) score += 20;
    else if (volatility > 5) score -= 15;
    else if (volatility < 0.5) score -= 15;

    return this.clamp(score, 0, 100);
  }

  /**
   * Risk configuration
   */
  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.02,
      maxDailyLossPct: 0.05,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 15,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  /**
   * Timeframe configuration — Single TF, no HTF regime
   * Component A runs on 5m, Component B runs on 15m
   */
  getTimeframeConfig() {
    return {
      interval: "5m",  // Run on 5m for faster A component response
      higherTf: null,  // NO HTF regime — both components operate on single TF
      checkInterval: 300000,  // Check every 5 minutes for both components
      components: [
        { id: "A", interval: "5m", holdMinutes: 15 },
        { id: "B", interval: "15m", holdMinutes: 90 },
      ],
    };
  }

  /**
   * Validasi kondisi entry terakhir sebelum eksekusi (gate engine).
   * Mean reversion beroperasi di pasar ranging/volatilitas sedang — ambang ATR
   * lebih longgar di sisi bawah, volume tidak harus tinggi. Konfirmasi arah utama
   * sudah ditangani detectSignal (Bollinger + RSI + confirmation bars).
   */
  validateEntry(price, atr, volume, volSMA) {
    if (!price || !atr) return { valid: true, reason: "Data tidak lengkap — lewati gate" };
    const atrPct   = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (atrPct < 0.15 || atrPct > 4.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% di luar rentang sehat (0.15–4.0%)` };
    }
    if (volRatio < 0.5) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× di bawah ambang (0.5×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = MeanReversionStrategy;
