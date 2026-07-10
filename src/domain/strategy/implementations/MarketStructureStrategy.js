/**
 * MarketStructureStrategy.js — TS Component B (Dow Theory HH/HL gate)
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateMarketStructureComponent,
  evaluateMarketStructureGate,
  DEFAULTS,
} = require("../ts/marketStructureComponent");

class MarketStructureStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "TS_MS",
      label: "Market Structure (Dow Theory)",
      description:
        "TS Component B: causal HH/HL structure gate on HTF before Trend Following entries.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { trend_strength = 0.5 } = marketConditions;
    let score = 55;
    if (trend_strength > 0.55) score += 20;
    if (trend_strength < 0.25) score -= 15;
    return [{
      key: "TS_MS",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "structure_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const result = evaluateMarketStructureComponent(highs, lows, idx, {
      ...DEFAULTS,
      ...config.marketStructure,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_MS", ...result };
    return result.vote === "LONG" || result.vote === "SHORT" ? result.vote : null;
  }

  evaluate(indicators, lastIdx, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const result = evaluateMarketStructureComponent(highs, lows, idx, {
      ...DEFAULTS,
      ...config.marketStructure,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_MS", ...result };
    return result;
  }

  evaluateGate(indicators, lastIdx, direction, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const result = evaluateMarketStructureGate(highs, lows, idx, direction, {
      ...DEFAULTS,
      ...config.marketStructure,
      ...config,
    });
    this._lastSignalMeta = { component: "TS_MS", ...result };
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

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = MarketStructureStrategy;
