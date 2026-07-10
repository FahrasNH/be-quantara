/**
 * WyckoffStrategy.js — AF Component B (Spring / Upthrust)
 *
 * Wraps evaluateWyckoffComponent for AdaptiveFusionUmbrella voting.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateWyckoffComponent,
  candlesFromIndicators,
  DEFAULTS,
} = require("../af/wyckoffComponent");

class WyckoffStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "AF_WYCKOFF",
      label: "Wyckoff Method (Spring/Upthrust)",
      description:
        "AF Component B: trading-range spring/upthrust detection with volume confirmation.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._lastSignalIdx = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.3 } = marketConditions;
    // Wyckoff thrives in ranging / moderate-vol markets
    let score = 50;
    if (trend_strength < 0.25) score += 25;
    if (volatility >= 0.8 && volatility <= 2.0) score += 15;
    if (trend_strength > 0.6) score -= 20;
    return [
      {
        key: "AF_WYCKOFF",
        label: this.config.label,
        score: Math.max(0, Math.min(100, score)),
        reason: "range_phase_affinity",
      },
    ];
  }

  canActivate(balance, htfTrend, volatility) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      { ...DEFAULTS, ...config.wyckoff, ...config },
      { lastSignalIdx: this._lastSignalIdx },
    );

    this._lastSignalMeta = {
      component: "AF_WYCKOFF",
      vote: result.vote,
      confidence: result.confidence,
      reason: result.reason,
      meta: result.meta || null,
    };

    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
      return result.vote;
    }
    return null;
  }

  /**
   * Full evaluation with NEUTRAL (for umbrella vote breakdown).
   */
  evaluate(indicators, lastIdx, config = {}) {
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      { ...DEFAULTS, ...config.wyckoff, ...config },
      { lastSignalIdx: this._lastSignalIdx },
    );
    this._lastSignalMeta = {
      component: "AF_WYCKOFF",
      ...result,
    };
    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
    }
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return {
      riskPerTrade: 0.01,
      maxTradesPerDay: 4,
      slMultiplier: 1.2,
      tpMultiplier: 2.4,
    };
  }

  getTimeframeConfig() {
    return { interval: "15m", higherTf: "1h", checkInterval: 60_000 };
  }

  validateEntry(price, atr, volume, volSMA) {
    if (!volume || volume === 0) return { valid: false, reason: "missing_volume" };
    if (volSMA && volume < 0.5 * volSMA) return { valid: false, reason: "low_volume" };
    if (!atr || atr <= 0) return { valid: false, reason: "no_atr" };
    return { valid: true, reason: "ok" };
  }
}

module.exports = WyckoffStrategy;
