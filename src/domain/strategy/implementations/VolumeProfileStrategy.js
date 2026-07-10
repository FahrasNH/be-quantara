/**
 * VolumeProfileStrategy.js — TS Component C (VWAP + Value Area precision)
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateVolumeProfileComponent,
  evaluateVolumeProfilePrecision,
  DEFAULTS,
} = require("../ts/volumeProfileComponent");

class VolumeProfileStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "TS_VP",
      label: "Volume Profile + VWAP",
      description:
        "TS Component C: session VWAP + Value Area entry precision for Trend Following pullbacks.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volume = 1.0 } = marketConditions;
    let score = 50;
    if (volume >= 1.0) score += 20;
    return [{
      key: "TS_VP",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "liquidity_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateVolumeProfileComponent(indicators, lastIdx, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_VP", ...result };
    return result.vote === "LONG" || result.vote === "SHORT" ? result.vote : null;
  }

  evaluate(indicators, lastIdx, config = {}) {
    const result = evaluateVolumeProfileComponent(indicators, lastIdx, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_VP", ...result };
    return result;
  }

  evaluatePrecision(indicators, lastIdx, direction, config = {}) {
    const result = evaluateVolumeProfilePrecision(indicators, lastIdx, direction, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_VP", ...result };
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 3, slMultiplier: 1.5, tpMultiplier: 3.0 };
  }

  getTimeframeConfig() {
    return { interval: "5m", higherTf: "4h", checkInterval: 60_000 };
  }

  validateEntry(price, atr, volume) {
    if (!volume || volume === 0) return { valid: false, reason: "missing_volume" };
    return { valid: true, reason: "ok" };
  }
}

module.exports = VolumeProfileStrategy;
