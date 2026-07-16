/**
 * VsaStrategy.js — AF racer C (Volume Spread Analysis)
 *
 * Independent race participant under AdaptiveFusionUmbrella (Sprint 12).
 * Also usable as vote Component C when afCombinationMode:"vote".
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateVSAComponent,
  candlesFromIndicators,
  DEFAULTS,
} = require("../af/vsaEntry");

class VsaStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "VOLUME_SPREAD_ANALYSIS",
      label: "Volume Spread Analysis (VSA)",
      description:
        "AF Component C: no-demand / no-supply / stopping-volume near swing structure.",
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
      { key: "rejMinBars", label: "2. - Insufficient bars" },
      { key: "rejVolume", label: "3. - Volume zero/missing" },
      { key: "rejRelVol", label: "4. - Rel-volume vs SMA gate" },
      { key: "rejAtr", label: "5. - ATR unavailable" },
      { key: "rejSwingProximity", label: "6. - Swing proximity gate" },
      { key: "rejClassify", label: "7. - Spread/CLV classify fail" },
      { key: "rejPattern", label: "8. - No VSA pattern" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of VsaStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() { return this._ablation; }

  getAblationSchema() { return VsaStrategy.ABLATION_SCHEMA; }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, volume = 1.0 } = marketConditions;
    let score = 45;
    if (volume > 1.2) score += 20;
    if (volatility > 1.0 && volatility < 2.5) score += 15;
    return [
      {
        key: "VOLUME_SPREAD_ANALYSIS",
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
      { ...DEFAULTS, ...config.vsa, ...config, ablation: this._ablation },
    );
    const nested = result.meta || {};
    const spreadType = nested.spreadType || {};
    const reason = String(result.reason || "");
    let patternType = null;
    if (reason.includes("stopping_volume")) patternType = "STOPPING_VOLUME";
    else if (reason.includes("no_demand")) patternType = "NO_DEMAND";
    else if (reason.includes("no_supply")) patternType = "NO_SUPPLY";
    const nearSwing = nested.nearSwing || {};
    // Sprint 15: flat vsa* ML fields
    const vsaFields = {
      vsaPatternType: patternType,
      vsaSpread: spreadType.spread ?? null,
      vsaVolume: nested.volume ?? null,
      vsaAvgSpread: spreadType.avgSpread ?? null,
      vsaAvgVolume: nested.avgVolume ?? nested.volSMA ?? null,
      vsaSwingProximity: nearSwing.distancePct ?? nearSwing.proximity ?? null,
      vsaReversal: patternType === "STOPPING_VOLUME" || reason.includes("stopping_volume"),
    };
    this._lastSignalMeta = {
      component: "VOLUME_SPREAD_ANALYSIS",
      winningComponent: (result.vote === "LONG" || result.vote === "SHORT") ? "VOLUME_SPREAD_ANALYSIS" : null,
      strategyLabel: "Volume Spread Analysis (VSA)",
      vote: result.vote,
      confidence: result.confidence,
      reason: result.reason,
      meta: result.meta || null,
      ...vsaFields,
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
