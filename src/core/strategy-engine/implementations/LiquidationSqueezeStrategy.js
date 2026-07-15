/**
 * LiquidationSqueezeStrategy.js — BS_LS (Liquidation/Squeeze Trading)
 * BREAKOUT_STORM race participant #2.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateLiquidationSqueezeEntry,
  evaluateOIFundingGate,
  DEFAULTS,
} = require("../bs/liquidationSqueeze");

class LiquidationSqueezeStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "BS_LS",
      label: "Liquidation/Squeeze Trading",
      description:
        "BS race participant (PDF Liquidation/Squeeze): wick displacement proxy " +
        "+ OI change / funding extremes (fail-open when OI/funding unavailable).",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0.5 } = marketConditions;
    let score = 50;
    if (volatility > 0.55) score += 20;
    return [{
      key: "BS_LS",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "ls_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const exchangeData = {
      funding: indicators.funding ?? indicators.fundingRate ?? config.funding ?? null,
      fundingRate: indicators.fundingRate ?? null,
      oiHistory: indicators.oiHistory || indicators.oi || config.oiHistory || null,
    };
    const result = evaluateLiquidationSqueezeEntry({
      highs: indicators.highs || [],
      lows: indicators.lows || [],
      opens: indicators.opens || [],
      closes: indicators.closes || [],
      volumes: indicators.volumes || [],
      volSMA: indicators.volSMA,
      lastIdx,
      exchangeData,
      config: { ...DEFAULTS, ...this.config, ...config },
    });
    const wick = result.wick || {};
    // Sprint 15: flat ls* ML fields (OI percentile / BB squeeze when feed available)
    const lsFields = {
      lsOiValue: result.oiValue ?? exchangeData.oiHistory?.slice?.(-1)?.[0] ?? null,
      lsOiPercentile: result.oiPercentile ?? null,
      lsBbWidth: result.bbWidth ?? null,
      lsBbWidthPercentile: result.bbWidthPercentile ?? null,
      lsLiquidationLevel: wick.level ?? wick.extreme ?? null,
      lsWickDepthAtr: wick.depthAtr ?? wick.wickAtr ?? null,
      lsOiForecast24h: result.oiChange ?? null,
    };
    this._lastSignalMeta = {
      component: "BS_LS",
      winningComponent: result.signal ? "BS_LS" : null,
      strategyLabel: "Liquidation/Squeeze Trading",
      componentConfidence: result.signal ? Math.round(result.confidence * 100) : 0,
      confidence: result.confidence,
      reason: result.reason,
      funding: result.funding,
      oiChange: result.oiChange,
      dataAvailable: result.dataAvailable,
      wick: result.wick,
      ...lsFields,
    };
    return result.signal || null;
  }

  /** Overlay helper for other strategies (optional universal use). */
  evaluateFundingOverlay(direction, exchangeData, config = {}) {
    return evaluateOIFundingGate(direction, exchangeData, { ...DEFAULTS, ...config });
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 4, slMultiplier: 1.6, tpMultiplier: 2.8 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.6;
    const tpMult = opts.tpMultiplier ?? 2.8;
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
    return { interval: "15m", higherTf: "4h", checkInterval: 60_000 };
  }

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = LiquidationSqueezeStrategy;
