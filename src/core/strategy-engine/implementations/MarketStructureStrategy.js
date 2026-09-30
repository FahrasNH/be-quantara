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
  const base = { ...DEFAULTS, ...(config.marketStructure || {}), ...config };
  const inferredTradeType = {
    "5m": "Scalping",
    "15m": "Intraday",
    "4h": "Swing",
  }[String(base.entryTf || base.interval || "").toLowerCase()];
  const tradeType = base.tradeType || base.tradeTypeName || inferredTradeType;
  // Live bots usually keep leg settings nested under typeOverrides, while
  // the multi-TF backtest flattens the active leg onto cfg. Resolve both
  // shapes here so DOW's maturity/local-trend/shelving gates stay in parity.
  const src = { ...base, ...(base.typeOverrides?.[tradeType] || {}) };
  return {
    leftLook: src.leftLook,
    rightLook: src.rightLook,
    scanBars: src.scanBars,
    minSwingPairs: src.minSwingPairs,
    entryPullbackPct: src.entryPullbackPct,
    entryAtrMult: src.entryAtrMult,
    requireLevelRetest: src.msRequireLevelRetest ?? src.requireLevelRetest,
    levelTouchAtrMult: src.msLevelTouchAtrMult ?? src.levelTouchAtrMult,
    allowHtfSideways: src.msAllowHtfSideways ?? src.allowHtfSideways,
    htfTrend: src.htfTrend,
    requireStructureIntegrity: src.requireStructureIntegrity,
    enabled: src.msEnabled ?? src.enabled,
    minBarsAfterConfirmation: src.msMinBarsAfterConfirmation ?? src.minBarsAfterConfirmation,
    requireLocalTrendAlignment: src.msRequireLocalTrendAlignment ?? src.requireLocalTrendAlignment,
    localTrendSlopeLookback: src.msLocalTrendSlopeLookback ?? src.localTrendSlopeLookback,
    tradeType,
  };
}

class MarketStructureStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MARKET_STRUCTURE",
      label: "Dow Theory",
      description:
        "TS race participant: Dow Theory HH/HL pullback entries on HTF structure (independent of Trend Following).",
      version: "2.3.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._lastSignalHtfIdx = null;
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejWarmup", label: "2. - Warmup insufficient" },
      { key: "rejStructure", label: "3. - Structure unclassified" },
      { key: "rejPrice", label: "4. - Price invalid" },
      { key: "rejHtfRegime", label: "5. - HTF sideways regime" },
      { key: "rejDisabled", label: "6. - Component disabled" },
      { key: "rejFreshStructure", label: "7. - Structure not mature" },
      { key: "rejLocalTrend", label: "8. - Local trend misaligned" },
      { key: "rejInvalidation", label: "9. - Structure invalidated" },
      { key: "rejDuplicate", label: "10. - Duplicate HTF signal" },
      { key: "rejPullback", label: "11. - Pullback tolerance" },
      { key: "rejBounceReject", label: "12. - HL bounce / LH rejection" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }
  resetAblation() {
    const a = {};
    for (const s of MarketStructureStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }
  getAblation() { return this._ablation; }
  getAblationSchema() { return MarketStructureStrategy.ABLATION_SCHEMA; }

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
    // HTF structure must use HTF volatility. Falling back to the entry-TF ATR
    // is only valid when this strategy is genuinely running without HTF data;
    // using entry-TF ATR at an HTF index distorts the pullback tolerance.
    const atrVal = indicators.atrHTF?.[idx] ?? indicators.atr?.[lastIdx] ?? null;
    const usingHtfStructure = Array.isArray(indicators.highsHTF);
    const entryCloses = indicators.closes || closes;
    const entryOpens = indicators.opens || [];
    const entryTimestamps = indicators.timestamps || [];
    let result = evaluateMarketStructureEntry(highs, lows, closes, idx, {
      ...structureConfigFrom(config),
      atr: atrVal,
      // HTF highs/lows/closes remain the structural source; entry-TF close
      // and open provide the live pullback bounce/rejection confirmation.
      entryCloses: usingHtfStructure ? entryCloses : undefined,
      entryOpens: usingHtfStructure ? entryOpens : undefined,
      entryHighs: usingHtfStructure ? indicators.highs : undefined,
      entryLows: usingHtfStructure ? indicators.lows : undefined,
      entryAtr: usingHtfStructure ? indicators.atr?.[lastIdx] : undefined,
      entryEmaTrend: indicators.emaTrend,
      entryLastIdx: usingHtfStructure ? lastIdx : undefined,
      htfTrend: config.htfTrend,
      timestamps: entryTimestamps,
      ablation: this._ablation,
    });
    // One HTF structure candle may span many entry-TF bars. Once a signal has
    // fired for that closed HTF index, do not emit the same setup again on
    // every bullish/bearish entry candle until structure advances.
    if (result.signal && usingHtfStructure && this._lastSignalHtfIdx === idx) {
      if (this._ablation) {
        if (this._ablation.passed > 0) this._ablation.passed -= 1;
        if (Object.prototype.hasOwnProperty.call(this._ablation, "rejDuplicate")) {
          this._ablation.rejDuplicate += 1;
        }
      }
      result = {
        ...result,
        vote: "NEUTRAL",
        signal: null,
        confidence: 0,
        reason: "duplicate_htf_structure_signal",
      };
    } else if (result.signal && usingHtfStructure) {
      this._lastSignalHtfIdx = idx;
    }
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

  resetSignalState() {
    this._lastSignalHtfIdx = null;
    this._lastSignalMeta = null;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 3, slMultiplier: 1.5, tpMultiplier: 3.0 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.5;
    const tpMult = opts.tpMultiplier ?? 3.0;
    const fallbackSlDist = atr * slMult;
    const useStructureStop = opts.msUseStructureStop === true;
    const structureMeta = opts.structureMeta || opts.entryMeta || null;
    const structuralLevel = signal === "LONG"
      ? structureMeta?.lastSwingLow?.price
      : structureMeta?.lastSwingHigh?.price;
    const structureAtr = Number.isFinite(opts.structureAtr) && opts.structureAtr > 0
      ? opts.structureAtr
      : atr;
    const structureBufferAtr = Math.max(0, Number(opts.msStructureBufferAtr ?? 0.25));
    const structuralStop = signal === "LONG"
      ? structuralLevel - structureAtr * structureBufferAtr
      : structuralLevel + structureAtr * structureBufferAtr;
    const structuralDist = signal === "LONG"
      ? entryPrice - structuralStop
      : structuralStop - entryPrice;
    const minStopAtr = Math.max(0, Number(opts.msMinStopAtr ?? 0));
    const maxStopAtr = Number.isFinite(opts.msMaxStopAtr)
      ? Math.max(minStopAtr, Number(opts.msMaxStopAtr))
      : Infinity;
    const hasStructuralStopCandidate = useStructureStop
      && Number.isFinite(structuralLevel)
      && Number.isFinite(structuralStop)
      && Number.isFinite(structuralDist)
      && structuralDist > 0;

    // Once a structural level is available, do not silently replace an
    // invalidation stop with a tighter entry-ATR stop. That would recreate the
    // exact HTF-vs-entry-TF geometry mismatch this risk path is meant to fix.
    if (
      hasStructuralStopCandidate
      && (structuralDist < atr * minStopAtr || structuralDist > atr * maxStopAtr)
    ) {
      return null;
    }
    const hasValidStructuralStop = hasStructuralStopCandidate;

    // Use the structural invalidation only when it is available and within a
    // bounded ATR envelope. If no structural level is available, retain the
    // legacy ATR geometry for backward-compatible callers.
    const slDist = hasValidStructuralStop ? structuralDist : fallbackSlDist;
    const tpDist = slDist * (tpMult / slMult);
    return {
      stopLoss: hasValidStructuralStop
        ? structuralStop
        : signal === "LONG" ? entryPrice - slDist : entryPrice + slDist,
      takeProfit: signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist,
      slDistance: slDist,
      tpDistance: tpDist,
      riskReward: slDist > 0 ? tpDist / slDist : 0,
      stopSource: hasValidStructuralStop ? "market_structure" : "entry_atr",
      structuralLevel: Number.isFinite(structuralLevel) ? structuralLevel : null,
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
