/**
 * StatisticalArbitrageStrategy.js — STATISTICAL_ARBITRAGE (Statistical Arbitrage v1)
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
      name: "STATISTICAL_ARBITRAGE",
      label: "Statistical Arbitrage",
      description:
        "MD race participant: Statistical Arbitrage v1 — z-score mean reversion " +
        "vs rolling mean / optional BTC residual (PDF cointegration/pairs — roadmap).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejWarmup", label: "2. - Warmup/lookback insufficient" },
      { key: "rejResidualZ", label: "3. - Residual-z (benchmark) gate" },
      { key: "rejRollingZ", label: "4. - Rolling-z unavailable" },
      { key: "rejVwapBlend", label: "5. - VWAP blend gate" },
      { key: "rejEntryZ", label: "6. - |z| below entryZ" },
      { key: "rejConfidence", label: "7. - Confidence floor" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of StatisticalArbitrageStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() {
    return this._ablation;
  }

  getAblationSchema() {
    return StatisticalArbitrageStrategy.ABLATION_SCHEMA;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { trend_strength = 0.5 } = marketConditions;
    let score = 50;
    if (trend_strength < 0.35) score += 20;
    return [{
      key: "STATISTICAL_ARBITRAGE",
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
      ablation: this._ablation,
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
      component: "STATISTICAL_ARBITRAGE",
      winningComponent: result.signal ? "STATISTICAL_ARBITRAGE" : null,
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
