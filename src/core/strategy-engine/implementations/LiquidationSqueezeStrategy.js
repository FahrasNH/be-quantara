/**
 * LiquidationSqueezeStrategy.js — LIQUIDATION_SQUEEZE (Liquidation/Squeeze Trading)
 * BREAKOUT_STORM race participant #2.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateLiquidationSqueezeEntry,
  evaluateOIFundingGate,
  DEFAULTS,
} = require("../bs/liquidationSqueezeEntry");
const { isCounterHtfTrend } = require("../../../config/htfMode");

class LiquidationSqueezeStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "LIQUIDATION_SQUEEZE",
      label: "Liquidation/Squeeze Trading",
      description:
        "BS race participant (PDF Liquidation/Squeeze): wick displacement proxy " +
        "+ OI change / funding extremes (fail-open when OI/funding unavailable).",
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
      { key: "rejWick", label: "2. - No liquidation wick" },
      { key: "rejOiFunding", label: "3. - OI/funding unavailable" },
      { key: "rejSignalPath", label: "4. - Wick/funding signal path" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of LiquidationSqueezeStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() { return this._ablation; }
  getAblationSchema() { return LiquidationSqueezeStrategy.ABLATION_SCHEMA; }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0.5 } = marketConditions;
    let score = 50;
    if (volatility > 0.55) score += 20;
    return [{
      key: "LIQUIDATION_SQUEEZE",
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

  /**
   * CONTEXT_ONLY liquidity-context overlay.
   * TODO: wire full HTF swing-liquidity pool detection — stub flags missing HTF liq.
   */
  _htfLiquidityContextOk(signal, indicators, config = {}, lastIdx = null) {
    const htfIdx = config.htfIdx;
    const highs = indicators?.highsHTF ?? config.htfHighs;
    const lows = indicators?.lowsHTF ?? config.htfLows;
    if (htfIdx == null || htfIdx < 0 || !highs?.length || !lows?.length) {
      return { ok: true, reason: "htf_liq_unavailable_fail_open" };
    }
    const lookback = Math.min(20, htfIdx);
    const sliceLows = lows.slice(Math.max(0, htfIdx - lookback), htfIdx + 1).filter(v => v != null);
    const sliceHighs = highs.slice(Math.max(0, htfIdx - lookback), htfIdx + 1).filter(v => v != null);
    if (!sliceLows.length || !sliceHighs.length) {
      return { ok: true, reason: "htf_liq_unavailable_fail_open" };
    }
    const price = indicators.closes?.[lastIdx];
    if (price == null) return { ok: true, reason: "htf_liq_unavailable_fail_open" };
    if (signal === "LONG") {
      const liqLow = Math.min(...sliceLows);
      return { ok: price >= liqLow * 0.995, reason: "htf_liq_long_context" };
    }
    if (signal === "SHORT") {
      const liqHigh = Math.max(...sliceHighs);
      return { ok: price <= liqHigh * 1.005, reason: "htf_liq_short_context" };
    }
    return { ok: true, reason: "ok" };
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
      ablation: this._ablation,
      config: { ...DEFAULTS, ...this.config, ...config },
    });
    const wick = result.wick || {};
    const htfTrend = config.htfTrend ?? null;
    let confidence = result.confidence;
    let htfMeta = {};
    if (result.signal) {
      const liqCtx = this._htfLiquidityContextOk(result.signal, indicators, config, lastIdx);
      htfMeta.htfLiquidityContextOk = liqCtx.ok;
      htfMeta.htfLiquidityReason = liqCtx.reason;
      if (!liqCtx.ok) {
        // Liquidity-context penalty only — no generic −15 SOFT_BIAS penalty for LS.
        confidence = Math.max(0, (confidence ?? 0) - 0.1);
        htfMeta.htfLiquidityPenalty = 0.1;
      } else if (isCounterHtfTrend(result.signal, htfTrend)) {
        htfMeta.htfCounterTrend = true;
        htfMeta.htfOverlayOnly = true;
      }
    }
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
      component: "LIQUIDATION_SQUEEZE",
      winningComponent: result.signal ? "LIQUIDATION_SQUEEZE" : null,
      strategyLabel: "Liquidation/Squeeze Trading",
      componentConfidence: result.signal ? Math.round(confidence * 100) : 0,
      confidence,
      reason: result.reason,
      funding: result.funding,
      oiChange: result.oiChange,
      dataAvailable: result.dataAvailable,
      wick: result.wick,
      ...lsFields,
      ...htfMeta,
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
