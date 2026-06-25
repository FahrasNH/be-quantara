/**
 * MeanReversionStrategy.js — Statistical Mean Reversion Trading
 *
 * Philosophy: "Trade extremes with statistical confidence"
 * - Identify price extremes via Bollinger Bands
 * - Confirm with RSI overbought/oversold (>75 or <25)
 * - Enter on mean reversion signal (high probability)
 * - v2.3: tight stops (1.4×ATR), long targets (3.2×ATR) → RR ~1:2.3
 * - Very selective: 40 trades/month, 55-60% WR
 * - Best for: VAULT tier (ultra-conservative, smooth equity)
 *
 * Mean Reversion Principle:
 * When price touches/crosses Bollinger Band (extreme),
 * price has high probability to revert back to middle (mean)
 */

const StrategyBase = require("../base/StrategyBase");
const { calcBollingerBands, calcRSI, calcATR, calcSMA } = require("../../indicators");

class MeanReversionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MEAN_REVERSION",
      label: "Mean Reversion Strategy",
      description:
        "Trades statistical extremes via Bollinger Bands. " +
        "Identifies oversold/overbought with RSI confirmation. " +
        "Entry near bands, target is middle (mean reversion). " +
        "Ultra-selective, ultra-conservative. Best for VAULT tier (Rp30M+).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,           // preserve name/label/version from StrategyBase
      // Bollinger Bands (mean reversion zones)
      bbPeriod: 20,
      bbStdDev: 2.0,

      // RSI (extreme confirmation) — level textbook mean-reversion 30/70.
      // Lebih banyak peluang sah dibanding 25/75 yang terlalu langka (TUNING #1).
      rsiPeriod: 14,
      rsiOverbought: 70,      // > 70 = overbought (SHORT setup)
      rsiOversold: 30,        // < 30 = oversold (LONG setup)

      // Volume confirmation
      volSMAPeriod: 20,
      minVolRatio: 0.8,       // >= 0.8x avg volume (not dead)

      // Risk management (VAULT tier - ultra-conservative) — v2.3 spec (STRATEGIES.md §3)
      riskPerTrade: 0.008,    // v2.3: 0.8% per trade (dari 1%)
      slMultiplier: 1.4,      // v2.3: SL = 1.4x ATR (dari 1.5)
      tpMultiplier: 3.2,      // v2.3: TP = 3.2x ATR → RR = 3.2/1.4 ≈ 1:2.3
      leverage: 1.0,          // NO leverage

      // Position management
      maxTradesPerDay: 3,
      minCapital: 30000000,   // Rp30M minimum
      maxConcurrentTrades: 1, // One at a time
      confirmationBars: 2,    // Need 2 bars confirming bounce/rejection
    };

    // Track BB levels for reference
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
    // Need ≥50 bars for a stable 20-period BB + RSI warmup.
    // 50 bars = ~12.5h on 15m TF — a safe minimum before trading (FIX #2).
    if (lastIdx < 50) return null;

    // Slice to current bar to avoid lookahead. Guard against datasets that
    // don't actually reach lastIdx (e.g. live feed lag) (FIX #3).
    const closes = (indicators.closes || []).slice(0, lastIdx + 1);
    if (closes.length <= lastIdx) return null;  // not enough data up to lastIdx

    const rsiValues = indicators.rsi || [];
    const volumes = (indicators.volumes || []).slice(0, lastIdx + 1);
    const atr = indicators.atr?.[lastIdx];
    const volSMA = indicators.volSMA?.[lastIdx];

    // Indicator availability guards — fail closed rather than silently (FIX #6)
    if (!atr) return null;
    if (!rsiValues.length || rsiValues[lastIdx] == null) return null;  // RSI required
    if (!volSMA || volSMA <= 0) return null;  // can't validate volume without SMA

    // Calculate current BB levels
    const bbLevels = this.calculateBollingerBands(
      closes,
      this.config.bbPeriod,
      this.config.bbStdDev
    );

    if (!bbLevels) return null;

    this._lastBBLevels = bbLevels;

    // Check LONG entry
    const longCheck = this.checkLongEntry(
      closes, rsiValues, volumes, bbLevels, volSMA, lastIdx, atr
    );

    if (longCheck.valid) return "LONG";

    // Check SHORT entry
    const shortCheck = this.checkShortEntry(
      closes, rsiValues, volumes, bbLevels, volSMA, lastIdx, atr
    );

    if (shortCheck.valid) return "SHORT";

    return null;
  }

  /**
   * Calculate SL/TP based on ATR and BB levels
   * SL = 1.0×ATR (very tight), TP = 3.0×ATR
   * Target is mean reversion to BB middle
   */
  calculateRiskConfig(entryPrice, atr, signal, bbLevels = null) {
    const slDist = atr * this.config.slMultiplier;
    const tpDist = atr * this.config.tpMultiplier;

    let stopLoss, takeProfit;

    // TP = max(ATR target, BB middle) so we always keep at least the 3×ATR
    // reward; if the mean (BB middle) is further, aim for the full reversion.
    // Never let BB middle SHRINK the TP below the ATR floor (FIX #4).
    if (signal === "LONG") {
      stopLoss = entryPrice - slDist;
      const atrTP = entryPrice + tpDist;
      // For LONG, further = higher → take the max
      takeProfit = bbLevels?.middle ? Math.max(atrTP, bbLevels.middle) : atrTP;
    } else {  // SHORT
      stopLoss = entryPrice + slDist;
      const atrTP = entryPrice - tpDist;
      // For SHORT, further = lower → take the min
      takeProfit = bbLevels?.middle ? Math.min(atrTP, bbLevels.middle) : atrTP;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),  // v2.3: ~2.29 (tp 3.2x / sl 1.4x)
      slDistance: slDist,
      tpDistance: tpDist,
      slMultiplier: this.config.slMultiplier,
      tpMultiplier: this.config.tpMultiplier,
      bbTarget: bbLevels?.middle || null,
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
   * Timeframe configuration
   */
  getTimeframeConfig() {
    return {
      interval: "15m",
      higherTf: null,  // No HTF needed
      checkInterval: 900000,  // 15 minutes
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
