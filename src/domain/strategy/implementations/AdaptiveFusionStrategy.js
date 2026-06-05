/**
 * ─────────────────────────────────────────────
 * AdaptiveFusionStrategy.js — Market-Aware Multi-Strategy System
 *
 * Combines 3 sub-strategies (Scalping, Day Trading, Swing Trading)
 * and adapts strategy selection based on market conditions.
 * ─────────────────────────────────────────────
 */

const StrategyBase = require("../base/StrategyBase");

class AdaptiveFusionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "ADAPTIVE_FUSION",
      label: "Adaptive Fusion Strategy",
      description:
        "Market-aware system combining 3 sub-strategies: " +
        "Aggressive Scalping (A), Day Trading (B), Swing Trading (C). " +
        "Automatically selects best strategy based on market conditions.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });

    // Sub-strategy configurations
    this.SUB_STRATEGIES = {
      A: {
        name: "PDF_SCALPING",
        label: "Aggressive Scalping",
        htf: "15m",
        entryTf: "1m",
        emaFast: 9,
        emaSlow: 21,
        rsi: 7,
        atrMultiplier: 0.5,
        riskPerTrade: 0.01,
        maxTradesPerDay: 20,
        minCapital: 50,
      },
      B: {
        name: "PDF_DAYTRADING",
        label: "Day Trading",
        htf: "1h",
        entryTf: "15m",
        emaFast: 9,
        emaSlow: 21,
        emaLong: 50,
        rsi: 14,
        atrMultiplier: 1.0,
        riskPerTrade: 0.015,
        maxTradesPerDay: 8,
        minCapital: 20,
      },
      C: {
        name: "PDF_SWING",
        label: "Swing Trading",
        htf: "1d",
        entryTf: "4h",
        emaFast: 21,
        emaSlow: 50,
        emaLong: 200,
        rsi: 14,
        atrMultiplier: 1.5,
        riskPerTrade: 0.015,
        maxTradesPerDay: 3,
        minCapital: 20,
      },
    };
  }

  /**
   * Rank all sub-strategies based on market conditions
   * Returns array of { key, score, canActivate }
   */
  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.1 } = marketConditions;

    const rankings = [];

    // ── Component C (Swing) ────────────────────────────────────
    let scoreC = 50;
    if (trend_strength > 0.6) scoreC += 40; // Strong trend = swing works
    if (volatility <= 2.0) scoreC += 20; // Moderate volatility good
    if (volatility > 3.5) scoreC -= 15; // Too volatile = bad
    rankings.push({
      key: "C",
      label: this.SUB_STRATEGIES.C.label,
      score: this.clamp(scoreC, 0, 100),
      reason: trend_strength > 0.6 ? "Strong trend" : "Balanced conditions",
    });

    // ── Component B (Day Trading) ────────────────────────────────
    let scoreB = 70; // B is default/balanced
    if (trend_strength > 0.7) scoreB -= 15; // Too strong = day trading struggles
    if (trend_strength < 0.2) scoreB -= 10; // Too weak = need scalping/swing
    if (volatility >= 1.5 && volatility <= 2.5) scoreB += 15; // Perfect zone
    rankings.push({
      key: "B",
      label: this.SUB_STRATEGIES.B.label,
      score: this.clamp(scoreB, 0, 100),
      reason: "Balanced strategy (default)",
    });

    // ── Component A (Scalping) ───────────────────────────────────
    let scoreA = 40;
    if (volatility > 2.5) scoreA += 40; // High volatility = scalping thrives
    if (trend_strength < 0.3) scoreA += 20; // Choppy market = scalping good
    if (volatility <= 1.0) scoreA -= 30; // Dead market = scalping fails
    rankings.push({
      key: "A",
      label: this.SUB_STRATEGIES.A.label,
      score: this.clamp(scoreA, 0, 100),
      reason: volatility > 2.5 ? "High volatility" : "Choppy market",
    });

    // Sort by score descending
    return rankings.sort((a, b) => b.score - a.score);
  }

  /**
   * Check if strategy can activate given balance and market conditions
   */
  canActivate(balance, htfTrend, volatility) {
    // Minimum capital check: $20 for B/C, $50 for A
    if (balance < 20) {
      return {
        allowed: false,
        reason: `Insufficient capital: need min $20, have $${balance}`,
      };
    }

    // Adaptive Fusion works in any trend, all components can operate
    return { allowed: true, reason: "Adaptive Fusion Strategy can activate" };
  }

  /**
   * Detect entry signal from all 3 components
   * Uses conflict resolution to decide final signal
   */
  detectSignal(indicators, lastIdx, config = {}) {
    if (lastIdx < 30) return null;

    const balance = config.balance || 500;

    // Get indicator values
    const rsi = indicators.rsi?.[lastIdx];
    const atr = indicators.atr?.[lastIdx];
    const closes = indicators.closes || [];
    const emaFast = indicators.emaFast?.[lastIdx];
    const emaSlow = indicators.emaSlow?.[lastIdx];

    if (!rsi || !atr || closes.length < 3) return null;

    const signals = {};

    // ── Scan Component A (Scalping) ────────────────────────────────
    if (balance >= this.SUB_STRATEGIES.A.minCapital) {
      const signalA = this._detectSignalA(rsi, emaFast, emaSlow, closes);
      signals.A = signalA;
    }

    // ── Scan Component B (Day Trading) ────────────────────────────
    if (balance >= this.SUB_STRATEGIES.B.minCapital) {
      const signalB = this._detectSignalB(rsi, emaFast, emaSlow, closes);
      signals.B = signalB;
    }

    // ── Scan Component C (Swing Trading) ───────────────────────────
    if (balance >= this.SUB_STRATEGIES.C.minCapital) {
      const signalC = this._detectSignalC(rsi, emaFast, emaSlow, closes);
      signals.C = signalC;
    }

    // ── Conflict Resolution ────────────────────────────────────────
    return this._resolveSignalConflict(signals);
  }

  /**
   * Component A (Scalping) signal detection
   * RSI-based, 1m timeframe
   */
  _detectSignalA(rsi, emaFast, emaSlow, closes) {
    if (rsi == null) return null;

    // LONG: RSI < 30 (oversold) + Price above fast EMA
    if (rsi < 30 && emaFast > emaSlow) {
      return "LONG";
    }

    // SHORT: RSI > 70 (overbought) + Price below fast EMA
    if (rsi > 70 && emaFast < emaSlow) {
      return "SHORT";
    }

    return null;
  }

  /**
   * Component B (Day Trading) signal detection
   * EMA-crossover based, 15m timeframe
   */
  _detectSignalB(rsi, emaFast, emaSlow, closes) {
    if (emaFast == null || emaSlow == null) return null;

    const price = closes[closes.length - 1];
    const pricePrev = closes[closes.length - 2];

    // LONG: Price crosses above slow EMA + RSI > 50
    if (pricePrev <= emaSlow && price > emaSlow && rsi > 50) {
      return "LONG";
    }

    // SHORT: Price crosses below slow EMA + RSI < 50
    if (pricePrev >= emaSlow && price < emaSlow && rsi < 50) {
      return "SHORT";
    }

    return null;
  }

  /**
   * Component C (Swing Trading) signal detection
   * Higher timeframe trend, 4h/1d
   */
  _detectSignalC(rsi, emaFast, emaSlow, closes) {
    if (emaFast == null || emaSlow == null) return null;

    const price = closes[closes.length - 1];

    // LONG: Price above slow EMA + fast EMA above slow EMA (uptrend)
    if (price > emaSlow && emaFast > emaSlow && rsi > 40) {
      return "LONG";
    }

    // SHORT: Price below slow EMA + fast EMA below slow EMA (downtrend)
    if (price < emaSlow && emaFast < emaSlow && rsi < 60) {
      return "SHORT";
    }

    return null;
  }

  /**
   * Resolve signal conflicts from 3 components
   * Rules:
   * - All 3 agree: EXECUTE (highest confidence)
   * - 2/3 agree: EXECUTE majority (high confidence)
   * - 1 agrees: SKIP (safety first)
   */
  _resolveSignalConflict(signals) {
    const signalArray = Object.values(signals).filter((s) => s !== null);

    if (signalArray.length === 0) return null;

    // Count LONG and SHORT votes
    const longVotes = signalArray.filter((s) => s === "LONG").length;
    const shortVotes = signalArray.filter((s) => s === "SHORT").length;

    // All agree on same direction
    if (longVotes === signalArray.length) {
      return "LONG";
    }
    if (shortVotes === signalArray.length) {
      return "SHORT";
    }

    // Majority vote (2/3)
    if (longVotes >= 2) {
      return "LONG";
    }
    if (shortVotes >= 2) {
      return "SHORT";
    }

    // No consensus = skip trade (safety first)
    return null;
  }

  /**
   * Get risk configuration
   */
  getRiskConfig() {
    return {
      riskPerTrade: 0.015, // 1.5% default
      maxRiskPerTrade: 0.02, // Never more than 2%
      maxDailyLossPct: 0.05, // Stop if lose 5% in a day
      maxTradesPerDay: 10, // Average across strategies
      cooldownAfterLoss: 3, // 3 min after loss
      maxConsecLoss: 4, // Stop if 4 consecutive losses
      leverage: 2,
    };
  }

  /**
   * Get timeframe configuration
   */
  getTimeframeConfig() {
    return {
      interval: "15m", // Check every 15 min
      higherTf: "1h", // Use 1h for confirmation
      checkInterval: 900000, // 15 minutes in milliseconds
    };
  }

  /**
   * Validate entry conditions
   */
  validateEntry(price, atr, volume, volSMA) {
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;

    // ATR should be in healthy range
    const validAtr = atrPct >= 0.3 && atrPct <= 4.0;
    const validVol = volRatio >= 0.7;

    if (!validAtr) {
      return {
        valid: false,
        reason: `ATR ${atrPct.toFixed(2)}% outside healthy range`,
      };
    }

    if (!validVol) {
      return {
        valid: false,
        reason: `Volume ${volRatio.toFixed(2)}x below SMA threshold`,
      };
    }

    return { valid: true, reason: "Entry conditions met" };
  }

  /**
   * Get all sub-strategy configurations
   */
  getSubStrategies() {
    return this.SUB_STRATEGIES;
  }

  /**
   * Get specific sub-strategy config
   */
  getSubStrategyConfig(key) {
    return this.SUB_STRATEGIES[key] || null;
  }
}

module.exports = AdaptiveFusionStrategy;
