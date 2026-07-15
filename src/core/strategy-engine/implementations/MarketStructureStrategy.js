/**
 * MarketStructureStrategy.js — TS Component B (Dow Theory HH/HL)
 *
 * Sprint 12: independent race participant with full entry logic.
 * Gate helpers retained for tsCombinationMode:"gate" rollback.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateMarketStructureComponent,
  evaluateMarketStructureGate,
  evaluateMarketStructureEntry,
  DEFAULTS,
} = require("../ts/marketStructureEntry");

function structureConfigFrom(config = {}) {
  const src = { ...DEFAULTS, ...(config.marketStructure || {}), ...config };
  return {
    leftLook: src.leftLook,
    rightLook: src.rightLook,
    scanBars: src.scanBars,
    minSwingPairs: src.minSwingPairs,
    entryPullbackPct: src.entryPullbackPct,
    entryAtrMult: src.entryAtrMult,
  };
}

class MarketStructureStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MARKET_STRUCTURE",
      label: "Dow Theory",
      description:
        "TS race participant: Dow Theory HH/HL pullback entries on HTF structure (independent of Trend Following).",
      version: "2.0.0",
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
      key: "MARKET_STRUCTURE",
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

  /**
   * Race-mode entry signal (edge-triggered pullback to HL/LH).
   */
  detectSignal(indicators, lastIdx, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const closes = indicators.closesHTF || indicators.closes || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const atrVal = indicators.atrHTF?.[idx] ?? indicators.atr?.[lastIdx] ?? null;
    const result = evaluateMarketStructureEntry(highs, lows, closes, idx, {
      ...structureConfigFrom(config),
      atr: atrVal,
      opens: indicators.opensHTF || indicators.opens || [],
    });
    const nested = result.meta || {};
    const lastSH = nested.lastSwingHigh;
    const lastSL = nested.lastSwingLow;
    const atrSafe = atrVal != null && Number.isFinite(atrVal) && atrVal > 0 ? atrVal : null;
    const dist = nested.dist != null ? nested.dist : null;
    // Sprint 15: flat ms* ML fields
    const msFields = {
      msSwingHighPrice: lastSH?.price ?? null,
      msSwingLowPrice: lastSL?.price ?? null,
      msPullbackDepthAtr: dist != null && atrSafe ? dist / atrSafe : null,
      msHhPattern: (nested.hh ?? 0) >= 1 || nested.structure === "uptrend",
      msLlPattern: (nested.ll ?? 0) >= 1 || nested.structure === "downtrend",
      msPullbackConfirmed: Boolean(result.signal),
    };
    this._lastSignalMeta = {
      component: "MARKET_STRUCTURE",
      winningComponent: result.signal ? "MARKET_STRUCTURE" : null,
      strategyLabel: "Dow Theory",
      atr: atrSafe,
      ...result,
      ...msFields,
    };
    return result.signal || null;
  }

  evaluate(indicators, lastIdx, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const result = evaluateMarketStructureComponent(highs, lows, idx, structureConfigFrom(config));
    this._lastSignalMeta = { component: "MARKET_STRUCTURE", ...result };
    return result;
  }

  evaluateGate(indicators, lastIdx, direction, config = {}) {
    const highs = indicators.highsHTF || indicators.highs || [];
    const lows = indicators.lowsHTF || indicators.lows || [];
    const idx = Number.isInteger(config.htfIdx) ? config.htfIdx : lastIdx;
    const result = evaluateMarketStructureGate(highs, lows, idx, direction, structureConfigFrom(config));
    this._lastSignalMeta = { component: "MARKET_STRUCTURE", ...result };
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 3, slMultiplier: 1.5, tpMultiplier: 3.0 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.5;
    const tpMult = opts.tpMultiplier ?? 3.0;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;
    return {
      stopLoss: signal === "LONG" ? entryPrice - slDist : entryPrice + slDist,
      takeProfit: signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist,
      slDistance: slDist,
      tpDistance: tpDist,
      riskReward: tpMult / slMult,
    };
  }

  getTimeframeConfig() {
    return { interval: "5m", higherTf: "4h", checkInterval: 60_000 };
  }

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = MarketStructureStrategy;
