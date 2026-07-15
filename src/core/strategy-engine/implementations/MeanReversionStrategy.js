/**
 * MeanReversionStrategy.js — MD_MR thin orchestrator
 *
 * Entry logic lives in md/meanReversionEntry.js (Sprint 15 structure refactor).
 */

const StrategyBase = require("../base/StrategyBase");
const {
  DEFAULTS: ENTRY_DEFAULTS,
  calculateBollingerBands,
  evaluateMeanReversionEntry,
} = require("../md/meanReversionEntry");

class MeanReversionStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "MEAN_REVERSION",
      label: "Mean Reversion (Mean Drift - MD_MR)",
      description:
        "Layered mean reversion: BB+RSI entry → ADX regime gate → OB/FVG precision. " +
        "Scalping (5m): RSI<28, BB(1.5σ). Intraday (15m): RSI<32, BB(2.0σ). " +
        "Optimal for MINT tier. RR 1:2.5 (Scalping), 1:2 (Intraday).",
      version: "3.0.0",
      enabled: true,
      ...config,
    });

    this.config = {
      ...this.config,
      ...ENTRY_DEFAULTS,
      volSMAPeriod: 20,
      atrMult: 1.4,
      leverage: 1.0,
      riskPerTrade: 0.008,
      tpMultiplierA: 2.5,
      holdMinutesA: 15,
      trailingStopAtrMultA: 0.3,
      tpMultiplierB: 2.0,
      holdMinutesB: 90,
      trailingStopAtrMultB: 0,
      mdAdxBalanceMax: 20,
      mdAdxImbalanceMin: 25,
      mdAdxTransitionConfidenceMult: 0.75,
      mdConfluenceAtrMult: 0.5,
      mdNoConfluenceConfidenceMult: 0.7,
      mdWithConfluenceConfidenceBoost: 1.1,
      mdFvgScanBars: 30,
      mdFvgMinGapPct: 0.002,
      mdObLookback: 20,
      mdObDispMult: 1.5,
      maxTradesPerDay: 5,
      minVotes: 1,
      maxConcurrentTrades: 3,
    };

    this._lastBBLevels = null;
    this._lastSignalMeta = null;
    this._adxCacheRef = { cache: null };
  }

  calculateBollingerBands(closes, period = 20, stdDev = 2.0) {
    return calculateBollingerBands(closes, period, stdDev);
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateMeanReversionEntry({
      indicators,
      lastIdx,
      config: { ...this.config, ...config },
      defaults: ENTRY_DEFAULTS,
      adxCacheRef: this._adxCacheRef,
    });
    this._lastBBLevels = result.bbLevels;
    this._lastSignalMeta = result.meta;
    return result.signal;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta || null;
  }

  calculateRiskConfig(entryPrice, atr, signal, component = null, _opts = {}) {
    const comp = component || (typeof signal === "object" ? signal.component : null) || "Intraday";
    const isComponentA = comp === "Scalping" || comp === "A";
    const side = typeof signal === "object" ? signal.signal : signal;

    const slDist = atr * this.config.atrMult;
    const tpMultiplier = isComponentA ? this.config.tpMultiplierA : this.config.tpMultiplierB;
    let tpDist = slDist * tpMultiplier;
    let tpSource = "rr";

    const meta = this._lastSignalMeta;
    if (meta?.tpOverride != null && Number.isFinite(meta.tpOverride)) {
      const overrideDist = Math.abs(meta.tpOverride - entryPrice);
      if (overrideDist >= slDist * 0.5 && overrideDist >= tpDist * 0.5) {
        tpDist = overrideDist;
        tpSource = meta.tpSource || "override";
      }
    }

    let stopLoss, takeProfit;
    if (side === "LONG") {
      stopLoss = entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss = entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }

    if (tpSource !== "rr" && meta?.tpOverride != null) {
      const ok =
        (side === "LONG" && meta.tpOverride > entryPrice) ||
        (side === "SHORT" && meta.tpOverride < entryPrice);
      if (ok) takeProfit = meta.tpOverride;
    }

    return {
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      riskReward: parseFloat((tpDist / slDist).toFixed(2)),
      slDistance: slDist,
      tpDistance: tpDist,
      component: isComponentA ? "Scalping" : "Intraday",
      holdMinutes: isComponentA ? this.config.holdMinutesA : this.config.holdMinutesB,
      trailingStopMult: isComponentA ? this.config.trailingStopAtrMultA : this.config.trailingStopAtrMultB,
      tpSource,
    };
  }

  validateMarketCondition(volatility = 0, trendStrength = 0) {
    const atrPct = volatility;

    if (atrPct < 0.5) {
      return { valid: false, reason: `Market too dead (ATR ${atrPct.toFixed(2)}% < 0.5%)` };
    }

    if (atrPct > 6) {
      return { valid: false, reason: `Market too volatile (ATR ${atrPct.toFixed(2)}% > 6%)` };
    }

    if (trendStrength > 0.7) {
      return { valid: false, reason: `Market too trending (strength ${trendStrength.toFixed(2)} > 0.7), use trend strategy` };
    }

    if (trendStrength < 0.2) {
      return { valid: true, reason: "Choppy market - IDEAL for mean reversion" };
    }

    return { valid: true, reason: "Market suitable for mean reversion" };
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0, trendStrength = 0 } = marketConditions;

    let score = 50;

    if (trendStrength < 0.3) score += 30;
    else if (trendStrength < 0.5) score += 15;
    else if (trendStrength > 0.7) score -= 30;

    if (volatility >= 1.0 && volatility <= 4.0) score += 20;
    else if (volatility > 5) score -= 15;
    else if (volatility < 0.5) score -= 15;

    return this.clamp(score, 0, 100);
  }

  getRiskConfig() {
    return {
      riskPerTrade: this.config.riskPerTrade,
      maxRiskPerTrade: 0.02,
      maxDailyLossPct: 0.05,
      maxTradesPerDay: this.config.maxTradesPerDay,
      cooldownAfterLoss: 15,
      maxConsecLoss: 2,
      leverage: this.config.leverage,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "5m",
      higherTf: null,
      checkInterval: 300000,
      components: [
        { id: "A", interval: "5m", holdMinutes: 15 },
        { id: "B", interval: "15m", holdMinutes: 90 },
      ],
    };
  }

  validateEntry(price, atr, volume, volSMA) {
    if (!price || !atr) return { valid: true, reason: "Data tidak lengkap — lewati gate" };
    const atrPct = (atr / price) * 100;
    const volRatio = volSMA > 0 ? volume / volSMA : 1;
    if (atrPct < 0.15 || atrPct > 4.0) {
      return { valid: false, reason: `ATR ${atrPct.toFixed(2)}% di luar rentang sehat (0.15–4.0%)` };
    }
    if (volRatio < 0.5) {
      return { valid: false, reason: `Volume ${volRatio.toFixed(2)}× di bawah ambang (0.5×)` };
    }
    return { valid: true, reason: "Entry conditions met" };
  }

  getConfig() {
    return this.config;
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
  }
}

module.exports = MeanReversionStrategy;
