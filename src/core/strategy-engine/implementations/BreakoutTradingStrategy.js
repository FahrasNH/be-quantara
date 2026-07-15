/**
 * BreakoutTradingStrategy.js — BS_BR thin orchestrator
 *
 * Entry logic lives in bs/breakoutTradingEntry.js (Sprint 15 structure refactor).
 * Persisted strategy key stays "BREAKOUT_RETEST" / umbrella "BS_BR".
 */

const StrategyBase = require("../base/StrategyBase");
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
  }

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
    const slDist = atr * this.config.slMultiplier;
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
      tpDist = atr * this.config.tpMultiplier;
    }
    tpDist = Math.min(tpDist, maxTpDist);

    const takeProfit = signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / actualSlDist).toFixed(2)),
      slDistance: actualSlDist,
      tpDistance: tpDist,
      slMultiplier: this.config.slMultiplier,
      tpMultiplier: this.config.tpMultiplier,
      preferredTpMode: this.config.preferredTpMode || "full",
      slPlusPartial1Pct: this.config.slPlusPartial1Pct ?? 0.33,
    };
  }

  validateEntry(price, atr, volume, volSMA) {
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 0;

    if (atrPct < 0.2 || atrPct > 5.0) {
      return {
        valid: false,
        reason: `ATR ${atrPct.toFixed(2)}% outside healthy range (0.2-5%)`,
      };
    }

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
