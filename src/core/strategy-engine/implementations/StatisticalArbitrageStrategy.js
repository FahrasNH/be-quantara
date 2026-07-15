/**
 * StatisticalArbitrageStrategy.js — MD_SA (Statistical Arbitrage v1)
 * MEAN_DRIFT race participant #2.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateStatisticalArbitrageEntry,
  DEFAULTS,
} = require("../md/statisticalArbitrageEntry");

class StatisticalArbitrageStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MD_SA",
      label: "Statistical Arbitrage",
      description:
        "MD race participant: Statistical Arbitrage v1 — z-score mean reversion " +
        "vs rolling mean / optional BTC residual (PDF cointegration/pairs — roadmap).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { trend_strength = 0.5 } = marketConditions;
    let score = 50;
    if (trend_strength < 0.35) score += 20;
    return [{
      key: "MD_SA",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "sa_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateStatisticalArbitrageEntry({
      closes: indicators.closes || [],
      vwap: indicators.vwap,
      benchmarkCloses: indicators.benchmarkCloses || indicators.btcCloses || null,
      lastIdx,
      config: { ...DEFAULTS, ...this.config, ...config },
    });
    const z = result.zScore;
    let bandTouch = "NONE";
    if (z != null) {
      if (z >= 2) bandTouch = "UPPER";
      else if (z <= -2) bandTouch = "LOWER";
    }
    // Sprint 15: flat sa* ML fields
    const saFields = {
      saZScore: z ?? null,
      saMaValue: result.mean ?? null,
      saStdDev: result.std ?? null,
      saUpperBand: result.upperBand ?? null,
      saLowerBand: result.lowerBand ?? null,
      saBandTouch: bandTouch,
      saMeanRevertBars: null, // populated post-exit when available; entry-time N/A
    };
    this._lastSignalMeta = {
      component: "MD_SA",
      winningComponent: result.signal ? "MD_SA" : null,
      strategyLabel: "Statistical Arbitrage",
      componentConfidence: result.signal ? Math.round(result.confidence * 100) : 0,
      confidence: result.confidence,
      reason: result.reason,
      zScore: result.zScore,
      saMode: result.mode,
      mean: result.mean,
      std: result.std,
      ...saFields,
    };
    return result.signal || null;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.01, maxTradesPerDay: 5, slMultiplier: 1.5, tpMultiplier: 2.0 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.5;
    const tpMult = opts.tpMultiplier ?? 2.0;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;
    const side = typeof signal === "object" ? signal.signal : signal;
    return {
      stopLoss: side === "LONG" ? entryPrice - slDist : entryPrice + slDist,
      takeProfit: side === "LONG" ? entryPrice + tpDist : entryPrice - tpDist,
      slDistance: slDist,
      tpDistance: tpDist,
      riskReward: tpMult / slMult,
    };
  }

  getTimeframeConfig() {
    return { interval: "5m", higherTf: "1h", checkInterval: 60_000 };
  }

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = StatisticalArbitrageStrategy;
