/**
 * TrendFollowingStrategy.js — TREND_FOLLOWING thin orchestrator
 *
 * Entry logic lives in ts/trendFollowingEntry.js (Sprint 15 structure refactor).
 */

const StrategyBase = require("../base/StrategyBase");
const { evaluateAtrEntryGate } = require("../../risk-engine/entryRiskGates");
const {
  DEFAULTS: ENTRY_DEFAULTS,
  freshTrendState,
  detectHTFTrend,
  isDonchianBroken,
  checkLongEntry,
  checkShortEntry,
  evaluateTrendFollowingEntry,
} = require("../ts/trendFollowingEntry");
const { enrichMetaWithGradedScore } = require("../scoring/ComponentScoringEngine");

class TrendFollowingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "TREND_FOLLOWING",
      label: "Trend Following Strategy",
      description:
        "Multi-timeframe trend following using EMA/SMA, Donchian Channel, ADX, and ATR. " +
        "Confirms trend strength, enters on breakout with pullback retest. " +
        "Medium-term holding, strong risk-reward. Best for FORGE tier (Rp15-30M).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      ...ENTRY_DEFAULTS,
      htfInterval: "1h",
      mtfInterval: "15m",
      entryInterval: "5m",
      emaTrendFast: 9,
      emaTrendMid: 21,
      emaTrendSlow: 50,
      smaTrendFast: 9,
      smaTrendMid: 21,
      adxPeriod: 14,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiOverbought: 70,
      volSMAPeriod: 20,
      riskPerTrade: 0.015,
      slMultiplier: 1.5,
      tpMultiplier: 3.0,
      leverage: 2.0,
      maxTradesPerDay: 3,
      minCapital: 15000000,
      trailingStopAtrMultiplier: 1.0,
      tpMode: "partial",
      maxBarsHeld: 100,
      breakEvenActivationPct: 0.25,
      partialProfitPct: 0.5,
    };

    this._openTrades = [];
    this._trendState = freshTrendState();
    this._lastEntryChecklist = null;
    this._donchianCache = new WeakMap();
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejWarmup", label: "2. - Warmup insufficient" },
      { key: "rejIndicators", label: "3. - Indicators unavailable" },
      { key: "rejHtfTrend", label: "4. - HTF trend gate" },
      { key: "rejBreakout", label: "5. - No Donchian breakout" },
      { key: "rejChecklist", label: "6. - Entry checklist (ADX/EMA/RSI/vol)" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }
  resetAblation() {
    const a = {};
    for (const s of TrendFollowingStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }
  getAblation() { return this._ablation; }
  getAblationSchema() { return TrendFollowingStrategy.ABLATION_SCHEMA; }

  resetTrendState() {
    this._trendState = freshTrendState();
    this._lastEntryChecklist = null;
  }

  detectHTFTrend(htfClosesLast, emaFastHTF, emaMidHTF, emaSlowHTF, adxHTF, adxMinOverride) {
    return detectHTFTrend(htfClosesLast, emaFastHTF, emaMidHTF, emaSlowHTF, adxHTF, adxMinOverride, this.config);
  }

  isDonchianBroken(closesEntry, donchianUpper, donchianLower, direction) {
    return isDonchianBroken(closesEntry, donchianUpper, donchianLower, direction);
  }

  checkLongEntry(...args) {
    return checkLongEntry(...args, this.config);
  }

  checkShortEntry(...args) {
    return checkShortEntry(...args, this.config);
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateTrendFollowingEntry({
      indicators,
      lastIdx,
      config: { ...this.config, ...config },
      trendState: this._trendState,
      donchianCache: this._donchianCache,
      defaults: ENTRY_DEFAULTS,
      ablation: this._ablation,
    });
    this._trendState = result.trendState;
    this._lastEntryChecklist = result.entryChecklist;
    return result.signal;
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? this.config.slMultiplier;
    const tpMult = opts.tpMultiplier ?? this.config.tpMultiplier;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;

    let stopLoss, takeProfit;

    if (signal === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      slMultiplier: slMult,
      tpMultiplier: tpMult,
    };
  }

  calculatePositionSize(balance, entryPrice, stopLossPrice, riskPercentage = null, leverage = null) {
    const riskPct = riskPercentage ?? this.config.riskPerTrade;
    const lev = leverage ?? this.config.leverage;

    if (!balance || balance <= 0 || !entryPrice || entryPrice <= 0) return 0;

    const riskAmount = balance * riskPct;
    const slDistance = Math.abs(entryPrice - stopLossPrice);
    if (slDistance === 0) return 0;

    const baseQty = riskAmount / slDistance;
    const leveragedQty = baseQty * lev;

    const maxNotional = balance * lev;
    const notional = leveragedQty * entryPrice;
    if (notional > maxNotional) {
      return parseFloat((maxNotional / entryPrice).toFixed(8));
    }

    return parseFloat(leveragedQty.toFixed(8));
  }

  applyBreakevenStop(trade, currentPrice) {
    const tpDist = Math.abs(trade.takeProfit - trade.entryPrice);
    const activation = tpDist * this.config.breakEvenActivationPct;

    if (trade.direction === "LONG") {
      if (currentPrice >= trade.entryPrice + activation && trade.stopLoss < trade.entryPrice) {
        trade.stopLoss = trade.entryPrice;
        trade.breakEvenActive = true;
      }
    } else if (trade.direction === "SHORT") {
      if (currentPrice <= trade.entryPrice - activation && trade.stopLoss > trade.entryPrice) {
        trade.stopLoss = trade.entryPrice;
        trade.breakEvenActive = true;
      }
    }
  }

  updateTrailingStop(trade, currentPrice, atr) {
    const tpDist = atr * this.config.tpMultiplier;
    const halfTPDist = tpDist * 0.5;

    if (trade.direction === "LONG") {
      const halfTP = trade.entryPrice + halfTPDist;
      if (currentPrice >= halfTP) {
        const trailDist = atr * this.config.trailingStopAtrMultiplier;
        const newSL = currentPrice - trailDist;
        if (newSL > trade.stopLoss) {
          trade.stopLoss = newSL;
          trade.trailingStopActive = true;
        }
      }
    } else if (trade.direction === "SHORT") {
      const halfTP = trade.entryPrice - halfTPDist;
      if (currentPrice <= halfTP) {
        const trailDist = atr * this.config.trailingStopAtrMultiplier;
        const newSL = currentPrice + trailDist;
        if (newSL < trade.stopLoss) {
          trade.stopLoss = newSL;
          trade.trailingStopActive = true;
        }
      }
    }
  }

  checkExit(trade, candle, barsHeld = 0) {
    const { high, low, close } = candle;

    if (trade.direction === "LONG" && low <= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }
    if (trade.direction === "SHORT" && high >= trade.stopLoss) {
      return { exit: true, reason: "SL", price: trade.stopLoss };
    }

    if (trade.direction === "LONG" && high >= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }
    if (trade.direction === "SHORT" && low <= trade.takeProfit) {
      return { exit: true, reason: "TP", price: trade.takeProfit };
    }

    if (barsHeld >= this.config.maxBarsHeld) {
      return { exit: true, reason: "TIMEOUT", price: close };
    }

    return { exit: false, reason: null, price: null };
  }

  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 8) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 8%)` };
    }

    const trendMin = this.config.adxMinStrength ?? 25;
    if (trendStrength < trendMin) {
      return { valid: false, reason: `No clear trend (ADX ${trendStrength.toFixed(1)} < ${trendMin})` };
    }

    return { valid: true, reason: "Market suitable for trend following" };
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    if (trendStrength >= 30) score += 30;
    else if (trendStrength >= 20) score += 15;
    else score -= 25;

    if (volatility >= 0.5 && volatility <= 6) score += 20;
    else if (volatility > 6) score -= 15;

    return this.clamp(score, 0, 100);
  }

  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.03,
      maxDailyLossPct: 0.06,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 15,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  getTimeframeConfig() {
    return {
      interval: this.config.entryInterval,
      higherTf: this.config.mtfInterval,
      checkInterval: 300000,
    };
  }

  getLastSignalMeta() {
    const checklist = this._lastEntryChecklist || {};
    const adxMinStrength = checklist.adxMinStrength ?? this.config.adxMinStrength ?? 25;
    const donchianPeriod = checklist.donchianPeriod ?? this.config.donchianPeriod ?? 20;
    const adx = this._trendState.htfAdxStrength || 0;
    const volRatio = checklist.volRatio ?? null;

    let confidence = 50;
    if (adx >= adxMinStrength + 15) confidence += 18;
    else if (adx >= adxMinStrength + 5) confidence += 12;
    else if (adx >= adxMinStrength) confidence += 8;
    if (this._trendState.donchianBroken) confidence += 8;
    if (this._trendState.htfTrendConfirmed) confidence += 6;
    if (volRatio != null) {
      if (volRatio >= 1.5) confidence += 10;
      else if (volRatio >= 1.0) confidence += 5;
    }
    const bars = this._trendState.barsInTrend || 0;
    if (bars >= 8 && bars <= 40) confidence += 6;
    else if (bars > 40) confidence += 2;
    confidence = Math.max(40, Math.min(95, Math.round(confidence)));

    const tfFields = {
      tfAdxStrength: this._trendState.htfAdxStrength ?? null,
      tfDonchianPeriod: donchianPeriod ?? null,
      tfBarsInTrend: this._trendState.barsInTrend ?? null,
      tfVolRatio: volRatio ?? null,
      tfHtfTrendConfirmed: Boolean(this._trendState.htfTrendConfirmed),
      tfEmaCrossover: Boolean(checklist.ema9Retest ?? false),
    };

    return enrichMetaWithGradedScore({
      component: "TREND_FOLLOWING",
      winningComponent: "TREND_FOLLOWING",
      strategyLabel: "Trend Following",
      marketCond: this._trendState.htfTrendConfirmed ? "STRONG_TREND" : "NORMAL",
      direction: this._trendState.htfTrendDirection,
      htfTrendConfirmed: this._trendState.htfTrendConfirmed,
      adxStrength: this._trendState.htfAdxStrength,
      donchianBroken: this._trendState.donchianBroken,
      barsInTrend: this._trendState.barsInTrend,
      componentConfidence: confidence,
      confidence: confidence / 100,
      entryChecklist: {
        htfTrendAligned: checklist.htfTrendAligned ?? this._trendState.htfTrendConfirmed,
        adxPassed: checklist.adxPassed ?? (this._trendState.htfAdxStrength >= adxMinStrength),
        donchianBroken: checklist.donchianBroken ?? this._trendState.donchianBroken,
        ema9Retest: checklist.ema9Retest ?? false,
        volumeConfirmed: checklist.volumeConfirmed ?? false,
        volRatio,
        adxMinStrength,
        donchianPeriod,
      },
      adxMinStrength,
      donchianPeriod,
      ...tfFields,
    }, "TREND_FOLLOWING");
  }

  validateEntry(price, atr, volume, volSMA, config = {}) {
    if (!price || !atr) return { valid: true, reason: "Data lengkap" };
    const atrGate = evaluateAtrEntryGate({
      atr,
      price,
      atrBaseline: config._atrBaseline ?? config.atrBaseline ?? null,
      atrMinMult: config.atrMinMult ?? 0.25,
      atrMaxMult: config.atrMaxMult ?? 5.0,
      atrGateRelative: config.atrGateRelative === true,
      atrRelMin: config.atrRelMin ?? 0.6,
      atrRelMax: config.atrRelMax ?? 3.0,
    });
    if (!atrGate.valid) return { valid: false, reason: atrGate.reason };
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (volRatio < 0.7) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× below threshold` };
    }
    return { valid: true, reason: "Entry OK" };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = TrendFollowingStrategy;
