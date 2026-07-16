/**
 * BreakoutTradingStrategy.js — BREAKOUT_RETEST thin orchestrator
 *
 * Entry logic lives in bs/breakoutTradingEntry.js (Sprint 15 structure refactor).
 * Persisted strategy key stays "BREAKOUT_RETEST" / umbrella "BREAKOUT_RETEST".
 */

const StrategyBase = require("../base/StrategyBase");
const { evaluateAtrEntryGate } = require("../../risk-engine/entryRiskGates");
const {
  DEFAULTS: ENTRY_DEFAULTS,
  evaluateBreakoutTradingEntry,
  freshBreakoutState,
  detectLevels,
  checkConsolidation,
  checkLongBreakout,
  checkShortBreakout,
  checkRetestEntry,
  scoreConfidence,
  classifyMarketCond,
} = require("../bs/breakoutTradingEntry");

class BreakoutTradingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "BREAKOUT_RETEST",
      label: "Breakout Trading Strategy",
      description:
        "Trades breakouts with healthy volatility (BB width / ATR floors), " +
        "confirmed by volume and a TRUE RETEST of the broken level (≥4h wait). " +
        "Risk-to-reward ~1:2 with structure-aware invalidation.",
      version: "2.6.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      ...ENTRY_DEFAULTS,
      riskPerTrade: 0.02,
      slMultiplier: 1.7,
      tpMultiplier: 3.2,
      minSlAtrFloor: 1.5,
      maxPlannedRR: 2.5,
      slPlusPartial1Pct: 0.33,
      maxTradesPerDay: 2,
      minCapital: 100,
      leverage: 1,
    };

    this._breakoutStates = new Map();
    this._lastSignalMeta = null;

    // Diagnostic ablation funnel (counting ONLY; never gates logic). Start via
    // resetAblation(); the entry module increments each stage/rejection so ONE
    // backtest run reports exactly which gate throttles trade frequency.
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejWarmup", label: "2. - Warmup insufficient" },
      { key: "rejAtrLookback", label: "3. - ATR/lookback insufficient" },
      { key: "rejLevels", label: "4. - No S/R levels" },
      { key: "rejConsolidation", label: "5. - No consolidation/BB squeeze" },
      { key: "rejBreakout", label: "6. - No breakout bar+volume" },
      { key: "rejRetestWindow", label: "7. - Outside retest window" },
      { key: "rejMinBars", label: "8. - Min bars since breakout" },
      { key: "rejDisplacement", label: "9. - Min displacement ATR" },
      { key: "rejTrueRetest", label: "10. - Not a true retest+rejection" },
      { key: "rejMarketCond", label: "11. - Market condition gate" },
      { key: "rejRrRoom", label: "12. - Insufficient RR room" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of BreakoutTradingStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() { return this._ablation; }

  getAblationSchema() { return BreakoutTradingStrategy.ABLATION_SCHEMA; }

  _stateKey(config = {}) {
    return (config.symbol || "default").toUpperCase();
  }

  _getBreakoutState(config = {}) {
    const key = this._stateKey(config);
    if (!this._breakoutStates.has(key)) {
      this._breakoutStates.set(key, freshBreakoutState());
    }
    return this._breakoutStates.get(key);
  }

  detectLevels(highs, lows = null) {
    return detectLevels(highs, lows, this.config);
  }

  checkConsolidation(closes, atr = null, price = null) {
    return checkConsolidation(closes, atr, price, this.config);
  }

  checkLongBreakout(closes, volumes, volSMA, resistance) {
    return checkLongBreakout(closes, volumes, volSMA, resistance, this.config);
  }

  checkShortBreakout(closes, volumes, volSMA, support) {
    return checkShortBreakout(closes, volumes, volSMA, support, this.config);
  }

  static get RETEST_TOUCH_TOL() {
    return require("../bs/breakoutTradingEntry").RETEST_TOUCH_TOL;
  }

  checkRetestEntry(closes, direction, breakoutLevel, lows = null, highs = null, opens = null, atr = null) {
    return checkRetestEntry(closes, direction, breakoutLevel, lows, highs, opens, atr, this.config);
  }

  _scoreConfidence(opts) {
    return scoreConfidence(opts);
  }

  _classifyMarketCond(squeezeWidthPct, avgPriorWidthPct, atrPct) {
    return classifyMarketCond(squeezeWidthPct, avgPriorWidthPct, atrPct);
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const merged = { ...this.config, ...config };
    const state = this._getBreakoutState(config);
    const result = evaluateBreakoutTradingEntry({
      indicators,
      lastIdx,
      config: merged,
      breakoutState: state,
      defaults: ENTRY_DEFAULTS,
      ablation: this._ablation,
    });

    if (result.resetState) {
      this._breakoutStates.set(this._stateKey(config), result.state);
    } else {
      Object.assign(state, result.state);
    }

    this._lastSignalMeta = result.meta;
    return result.signal;
  }

  calculateRiskConfig(entryPrice, atr, signal, extrasOrComponent = {}, maybeExtras = {}) {
    const extras = (extrasOrComponent && typeof extrasOrComponent === "object" && !Array.isArray(extrasOrComponent))
      ? extrasOrComponent
      : (maybeExtras && typeof maybeExtras === "object" ? maybeExtras : {});
    const meta = this._lastSignalMeta || {};
    const slMult = extras.slMultiplier ?? this.config.slMultiplier;
    const tpMult = extras.tpMultiplier ?? this.config.tpMultiplier;
    const slDist = atr * slMult;
    const minSlDist = atr * (this.config.minSlAtrFloor ?? 1.5);
    const maxRR = this.config.maxPlannedRR ?? 2.5;
    const breakoutLevel = extras.breakoutLevel ?? meta.breakoutLevel ?? null;
    const retestExtreme = extras.retestExtreme ?? meta.retestExtreme ?? null;
    const structuralTarget = extras.structuralTarget ?? meta.structuralTarget ?? null;

    let stopLoss;

    if (signal === "LONG") {
      const atrStop = entryPrice - slDist;
      let structureStop = null;
      if (retestExtreme != null) {
        structureStop = retestExtreme - atr * 0.2;
      } else if (breakoutLevel != null) {
        structureStop = breakoutLevel - atr * 0.25;
      }
      stopLoss = atrStop;
      if (structureStop != null && structureStop < atrStop) {
        stopLoss = structureStop;
      }
      if (entryPrice - stopLoss < minSlDist) stopLoss = entryPrice - minSlDist;
      if (stopLoss >= entryPrice) stopLoss = entryPrice - minSlDist;
    } else {
      const atrStop = entryPrice + slDist;
      let structureStop = null;
      if (retestExtreme != null) {
        structureStop = retestExtreme + atr * 0.2;
      } else if (breakoutLevel != null) {
        structureStop = breakoutLevel + atr * 0.25;
      }
      stopLoss = atrStop;
      if (structureStop != null && structureStop > atrStop) {
        stopLoss = structureStop;
      }
      if (stopLoss - entryPrice < minSlDist) stopLoss = entryPrice + minSlDist;
      if (stopLoss <= entryPrice) stopLoss = entryPrice + minSlDist;
    }

    const actualSlDist = Math.abs(entryPrice - stopLoss);
    const maxTpDist = actualSlDist * maxRR;

    let tpDist;
    const structOnCorrectSide = structuralTarget != null && (
      (signal === "LONG" && structuralTarget > entryPrice) ||
      (signal === "SHORT" && structuralTarget < entryPrice)
    );
    if (structOnCorrectSide) {
      tpDist = Math.abs(structuralTarget - entryPrice);
    } else {
      tpDist = atr * tpMult;
    }
    tpDist = Math.min(tpDist, maxTpDist);

    const takeProfit = signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / actualSlDist).toFixed(2)),
      slDistance: actualSlDist,
      tpDistance: tpDist,
      slMultiplier: slMult,
      tpMultiplier: tpMult,
      preferredTpMode: this.config.preferredTpMode || "full",
      slPlusPartial1Pct: this.config.slPlusPartial1Pct ?? 0.33,
    };
  }

  validateEntry(price, atr, volume, volSMA, config = {}) {
    const atrGate = evaluateAtrEntryGate({
      atr,
      price,
      atrBaseline: config._atrBaseline ?? config.atrBaseline ?? null,
      atrMinMult: config.atrMinMult ?? 0.2,
      atrMaxMult: config.atrMaxMult ?? 5.0,
      atrGateRelative: config.atrGateRelative === true,
      atrRelMin: config.atrRelMin ?? 0.6,
      atrRelMax: config.atrRelMax ?? 3.0,
    });
    if (!atrGate.valid) {
      return { valid: false, reason: atrGate.reason };
    }

    const volRatio = volSMA > 0 ? volume / volSMA : 0;
    if (volRatio < 0.8) {
      return {
        valid: false,
        reason: `Volume ${volRatio.toFixed(2)}× below threshold (0.8×)`,
      };
    }

    return { valid: true, reason: "Entry conditions met" };
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;
    let score = 50;
    if (volatility >= 0.5 && volatility <= 3) score += 15;
    if (trendStrength >= 0.5) score += 15;
    return this.clamp(score, 0, 100);
  }

  canActivate(balance, htfTrend, volatility) {
    if (balance < this.config.minCapital) {
      return {
        allowed: false,
        reason: `Balance $${balance} below minimum $${this.config.minCapital}`,
      };
    }
    return { allowed: true, reason: "Strategy ready" };
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getBreakoutState(config = {}) {
    return { ...this._getBreakoutState(config) };
  }

  resetBreakoutState(config = {}) {
    this._breakoutStates.delete(this._stateKey(config));
  }

  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.04,
      maxDailyLossPct: 0.08,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 5,
      maxConsecLoss: 3,
      leverage: this.config.leverage,
      preferredTpMode: this.config.preferredTpMode || "full",
      slPlusPartial1Pct: this.config.slPlusPartial1Pct ?? 0.33,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "15m",
      higherTf: "4h",
      checkInterval: 900000,
    };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = BreakoutTradingStrategy;
