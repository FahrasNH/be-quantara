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
const { calcBollingerBands, calcRSI, calcATR, calcSMA, calcVWAP, calcZScore } = require("../../indicators");

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
   * Check if 2+ bars confirm LONG recovery (oversold bounce)
   * Confirmation bar[1]: small body (indecision near bottom)
   * Confirmation bar[0]: close > bar[1].close (recovery confirmed)
   */
  hasConfirmationBars(closes, rsiValues, direction, fromIdx) {
    if (!closes || closes.length <= fromIdx) return false;

    const bar1 = { close: closes[fromIdx - 1] };
    const bar0 = { close: closes[fromIdx] };

    if (direction === "LONG") {
      // LONG confirmation: current close > previous close (recovery)
      return bar0.close > bar1.close;
    } else {
      // SHORT confirmation: current close < previous close (rejection)
      return bar0.close < bar1.close;
    }
  }

  /**
   * Validate volume is normal (not panic spike, not dead)
   */
  validateVolume(volumes, volSMA, rsiCurrent, direction) {
    if (!volumes || volumes.length === 0) return false;

    const currentVol = volumes[volumes.length - 1];

    if (volSMA <= 0) return false;

    const volRatio = currentVol / volSMA;

    // Need at least minimum ratio
    if (volRatio < this.config.minVolRatio) return false;

    // For LONG: RSI is low (oversold) but volume should be normal, not extreme panic
    // For SHORT: RSI is high (overbought) but volume should be normal, not extreme euphoria
    // Extreme = > 2.0x SMA for extreme moves
    if (volRatio > 2.0) {
      // During recovery/rejection, too much volume is suspicious
      if (direction === "LONG" && rsiCurrent < 30) return false;  // Panic selling still
      if (direction === "SHORT" && rsiCurrent > 70) return false; // Euphoria buying still
    }

    return true;
  }

  /**
   * Check LONG entry (oversold bounce)
   * All conditions must be true
   */
  checkLongEntry(
    closes,
    rsiValues,
    volumes,
    bbLevels,
    volSMA,
    lastIdx,
    atr
  ) {
    if (!closes || !bbLevels || closes.length < lastIdx + 1) {
      return { valid: false, reason: "Insufficient data" };
    }

    const closeCurr = closes[lastIdx];
    const closePrev = lastIdx > 0 ? closes[lastIdx - 1] : null;
    const rsiCurr = rsiValues?.[lastIdx];

    // 1. PRICE EXTREME: harus DEKAT band bawah (sinyal reversion kuat).
    // Zona masuk = [lower, lower + 0.5×bandwidth] saja — separuh bawah.
    // Entry yang jauh dari band (mendekati middle) reversion-edge-nya lemah →
    // tolak agar win-rate tidak terdilusi (TUNING #2).
    if (closeCurr < bbLevels.lower) {
      return { valid: false, reason: `Price ${closeCurr.toFixed(2)} still below BB lower ${bbLevels.lower.toFixed(2)}` };
    }
    const bounceZoneTop = bbLevels.lower + bbLevels.bandwidth * 0.5;
    if (closeCurr > bounceZoneTop) {
      return { valid: false, reason: `Price ${closeCurr.toFixed(2)} terlalu jauh dari band bawah (zona masuk ≤ ${bounceZoneTop.toFixed(2)})` };
    }

    // 2. RSI CONFIRMATION: oversold but recovering
    if (!rsiCurr || rsiCurr >= this.config.rsiOversold) {
      return { valid: false, reason: `RSI ${rsiCurr?.toFixed(1) || "null"} not oversold (<${this.config.rsiOversold})` };
    }

    // RSI very extreme (< 20) might be panic still
    if (rsiCurr < 15) {
      return { valid: false, reason: `RSI ${rsiCurr.toFixed(1)} too extreme (< 15), panic selling` };
    }

    // 3. VOLUME CONFIRMATION
    if (!this.validateVolume(volumes, volSMA, rsiCurr, "LONG")) {
      return { valid: false, reason: "Volume not in normal range" };
    }

    // 4. CONFIRMATION BARS
    if (!this.hasConfirmationBars(closes, rsiValues, "LONG", lastIdx)) {
      return { valid: false, reason: "Missing confirmation bar (close > previous)" };
    }

    return { valid: true, reason: "All LONG conditions met - oversold bounce" };
  }

  /**
   * Check SHORT entry (overbought rejection)
   * Mirror of checkLongEntry for downside
   */
  checkShortEntry(
    closes,
    rsiValues,
    volumes,
    bbLevels,
    volSMA,
    lastIdx,
    atr
  ) {
    if (!closes || !bbLevels || closes.length < lastIdx + 1) {
      return { valid: false, reason: "Insufficient data" };
    }

    const closeCurr = closes[lastIdx];
    const closePrev = lastIdx > 0 ? closes[lastIdx - 1] : null;
    const rsiCurr = rsiValues?.[lastIdx];

    // 1. PRICE EXTREME: harus DEKAT band atas (sinyal rejection kuat).
    // Zona masuk = [upper - 0.5×bandwidth, upper] saja — separuh atas.
    // Simetris dgn LONG: tolak entry yang jauh dari band (edge lemah) (TUNING #2).
    if (closeCurr > bbLevels.upper) {
      return { valid: false, reason: `Price ${closeCurr.toFixed(2)} still above BB upper ${bbLevels.upper.toFixed(2)}` };
    }
    const rejectionZoneBot = bbLevels.upper - bbLevels.bandwidth * 0.5;
    if (closeCurr < rejectionZoneBot) {
      return { valid: false, reason: `Price ${closeCurr.toFixed(2)} terlalu jauh dari band atas (zona masuk ≥ ${rejectionZoneBot.toFixed(2)})` };
    }

    // 2. RSI CONFIRMATION: overbought but rejecting
    if (!rsiCurr || rsiCurr <= this.config.rsiOverbought) {
      return { valid: false, reason: `RSI ${rsiCurr?.toFixed(1) || "null"} not overbought (>${this.config.rsiOverbought})` };
    }

    // RSI very extreme (> 85) might be euphoria still
    if (rsiCurr > 85) {
      return { valid: false, reason: `RSI ${rsiCurr.toFixed(1)} too extreme (> 85), euphoria buying` };
    }

    // 3. VOLUME CONFIRMATION
    if (!this.validateVolume(volumes, volSMA, rsiCurr, "SHORT")) {
      return { valid: false, reason: "Volume not in normal range" };
    }

    // 4. CONFIRMATION BARS
    if (!this.hasConfirmationBars(closes, rsiValues, "SHORT", lastIdx)) {
      return { valid: false, reason: "Missing confirmation bar (close < previous)" };
    }

    return { valid: true, reason: "All SHORT conditions met - overbought rejection" };
  }

  /**
   * Main signal detection (mean reversion)
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

    // VWAP for confirmation
    const vwapValues = calcVWAP(indicators.candles?.slice?.(0, lastIdx + 1) || []);
    const vwap = vwapValues[lastIdx] || close;

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

    // ═══ RETURN SIGNAL WITH COMPONENT METADATA ═════════════════════════════
    if (isCompALong) {
      return {
        signal: "LONG",
        component: "A",
        confidence: 65,
        reason: `Scalping: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldA}, BB(1.5σ) touch, below VWAP`,
      };
    }
    if (isCompAShort) {
      return {
        signal: "SHORT",
        component: "A",
        confidence: 65,
        reason: `Scalping: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtA}, BB(1.5σ) touch, above VWAP`,
      };
    }

    if (isCompBLong) {
      return {
        signal: "LONG",
        component: "B",
        confidence: 60,
        reason: `Intraday: RSI ${rsiNow.toFixed(1)} < ${this.config.rsiOversoldB}, BB(2.0σ) touch, below VWAP`,
      };
    }
    if (isCompBShort) {
      return {
        signal: "SHORT",
        component: "B",
        confidence: 60,
        reason: `Intraday: RSI ${rsiNow.toFixed(1)} > ${this.config.rsiOverboughtB}, BB(2.0σ) touch, above VWAP`,
      };
    }

    return null;
  }

  /**
   * Calculate SL/TP based on component and ATR
   * Component A (Scalping): SL 1.4×ATR, TP 3.5×ATR (1:2.5 RR)
   * Component B (Intraday): SL 1.4×ATR, TP 2.8×ATR (1:2.0 RR)
   */
  calculateRiskConfig(entryPrice, atr, signal, bbLevels = null) {
    const component = typeof signal === 'object' ? signal.component : 'B';
    const isComponentA = component === 'A';

    const slDist = atr * this.config.atrMult;  // 1.4× for both
    const tpMultiplier = isComponentA ? this.config.tpMultiplierA : this.config.tpMultiplierB;
    const tpDist = atr * tpMultiplier;

    let stopLoss, takeProfit;

    if (signal.signal === "LONG" || signal === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {  // SHORT
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    const bbMiddle = isComponentA ? bbLevels?.bbA?.middle : bbLevels?.bbB?.middle;
    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      component: component,
      holdMinutes: isComponentA ? this.config.holdMinutesA : this.config.holdMinutesB,
      trailingStopMult: isComponentA ? this.config.trailingStopAtrMultA : this.config.trailingStopAtrMultB,
      bbTarget: bbMiddle || null,
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
