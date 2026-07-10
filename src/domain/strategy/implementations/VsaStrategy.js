/**
 * VsaStrategy.js — AF Component C (Volume Spread Analysis)
 *
 * Wraps evaluateVSAComponent for AdaptiveFusionUmbrella voting.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateVSAComponent,
  candlesFromIndicators,
  DEFAULTS,
} = require("../af/vsaComponent");

class VsaStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "AF_VSA",
      label: "Volume Spread Analysis (VSA)",
      description:
        "AF Component C: no-demand / no-supply / stopping-volume near swing structure.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, volume = 1.0 } = marketConditions;
    let score = 45;
    if (volume > 1.2) score += 20;
    if (volatility > 1.0 && volatility < 2.5) score += 15;
    return [
      {
        key: "AF_VSA",
        label: this.config.label,
        score: Math.max(0, Math.min(100, score)),
        reason: "volume_conviction_affinity",
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
    const result = this.evaluate(indicators, lastIdx, config);
    if (result.vote === "LONG" || result.vote === "SHORT") return result.vote;
    return null;
  }

  evaluate(indicators, lastIdx, config = {}) {
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateVSAComponent(
      candles,
      null,
      { ...DEFAULTS, ...config.vsa, ...config },
    );
    this._lastSignalMeta = {
      component: "AF_VSA",
      vote: result.vote,
      confidence: result.confidence,
      reason: result.reason,
      meta: result.meta || null,
    };
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
    if (!atr || atr <= 0) return { valid: false, reason: "no_atr" };
    return { valid: true, reason: "ok" };
  }
}

module.exports = VsaStrategy;
