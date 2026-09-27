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
      { key: "rejScalpingShelved", label: "2. - Scalping shelved (fee-bound)" },
      { key: "rejMinBars", label: "3. - Insufficient bars" },
      { key: "rejVolume", label: "4. - Volume zero/missing" },
      { key: "rejRelVol", label: "5. - Rel-volume vs SMA gate" },
      { key: "rejAtr", label: "6. - ATR unavailable" },
      { key: "rejSwingProximity", label: "7. - Swing proximity gate" },
      { key: "rejClassify", label: "8. - Spread/CLV classify fail" },
      { key: "rejPattern", label: "9. - No VSA pattern" },
      { key: "rejSequenceNoTest", label: "9a. - Sequence has no VSA test" },
      { key: "rejSequenceNoClimax", label: "9b. - Sequence has no prior climax" },
      { key: "rejBySession", label: "10. - Session filter (no-trade window)" },
      { key: "rejHtfShortBullish", label: "11. - Intraday HTF SHORT×BULLISH block" },
      { key: "rejHtfStoppingCounter", label: "12. - Intraday HTF stopping-volume counter" },
      { key: "rejHtfLongBearishPenalty", label: "13. - Intraday HTF LONG×BEARISH penalty" },
      { key: "rejHtfSideways", label: "14. - Intraday HTF sideways block" },
      { key: "rejDailyChop", label: "15. - Intraday daily CHOP block" },
      { key: "rejMinConfidenceIntraday", label: "16. - Intraday score below floor" },
      { key: "rejMaxConfidenceIntraday", label: "17. - Intraday score above ceiling" },
      { key: "rejSwingShort", label: "18. - Swing LONG-only gate" },
      { key: "rejSwingHtfCounter", label: "19. - Swing HTF counter-trend gate" },
      { key: "rejMinConfidence", label: "20. - Swing graded conf floor" },
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
      { ...DEFAULTS, ...config.vsa, ...config, indicators, ablation: this._ablation },
    );
    const nested = result.meta || {};
    const spreadType = nested.spreadType || {};
    const sequenceTest = nested.test || {};
    const testSpreadType = sequenceTest.spreadType || {};
    const reason = String(result.reason || "");
    let patternType = null;
    if (reason.includes("stopping_volume")) patternType = "STOPPING_VOLUME";
    else if (reason.includes("no_demand")) patternType = "NO_DEMAND";
    else if (reason.includes("no_supply")) patternType = "NO_SUPPLY";
    const nearSwing = nested.nearSwing || {};
    // Sprint 15: flat vsa* ML fields
    const vsaFields = {
      vsaPatternType: patternType,
      vsaSpread: nested.vsaSpread ?? spreadType.spread ?? testSpreadType.spread ?? null,
      vsaVolume: nested.vsaVolume ?? nested.volume ?? sequenceTest.candle?.volume ?? null,
      vsaAvgSpread: nested.vsaAvgSpread ?? spreadType.avgSpread ?? testSpreadType.avgSpread ?? null,
      vsaAvgVolume: nested.vsaAvgVolume ?? nested.avgVolume ?? nested.volSMA ?? sequenceTest.avgVolume ?? null,
      vsaSwingProximity: nested.vsaTestSwingDistance
        ?? nearSwing.distancePct ?? nearSwing.proximity ?? sequenceTest.nearSwing?.distance ?? null,
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
