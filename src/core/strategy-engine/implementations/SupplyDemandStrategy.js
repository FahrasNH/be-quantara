/**
 * SupplyDemandStrategy.js — SUPPLY_AND_DEMAND (Supply and Demand)
 * MEAN_DRIFT race participant #1.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const { evaluateSupplyDemandEntry, DEFAULTS } = require("../md/supplyDemandEntry");

class SupplyDemandStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "SUPPLY_AND_DEMAND",
      label: "Supply and Demand",
      description:
        "MD race participant: retest of demand/supply zones (OB/FVG structure under S&D).",
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
      { key: "rejWarmup", label: "2. - Warmup/ATR insufficient" },
      { key: "rejZones", label: "3. - No FVG/OB zones" },
      { key: "rejZoneRadius", label: "4. - Nearest zone out of ATR radius" },
      { key: "rejReversal", label: "5. - No reversal candle" },
      { key: "rejConflict", label: "6. - Conflict resolution" },
      { key: "rejRetest", label: "7. - Retest gate" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }

  resetAblation() {
    const a = {};
    for (const s of SupplyDemandStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }

  getAblation() {
    return this._ablation;
  }

  getAblationSchema() {
    return SupplyDemandStrategy.ABLATION_SCHEMA;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { trend_strength = 0.5, volatility = 0.5 } = marketConditions;
    let score = 55;
    if (trend_strength < 0.4) score += 15;
    if (volatility > 0.3 && volatility < 0.8) score += 10;
    return [{
      key: "SUPPLY_AND_DEMAND",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "sd_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateSupplyDemandEntry({
      opens: indicators.opens || [],
      highs: indicators.highs || [],
      lows: indicators.lows || [],
      closes: indicators.closes || [],
      volumes: indicators.volumes || [],
      volSMA: indicators.volSMA,
      atr: indicators.atr?.[lastIdx],
      lastIdx,
      config: { ...DEFAULTS, ...this.config, ...config },
      ablation: this._ablation,
    });
    const atr = indicators.atr?.[lastIdx];
    const zone = result.nearestZone || {};
    const low = zone.low ?? zone.bottom ?? null;
    const high = zone.high ?? zone.top ?? null;
    const mid = low != null && high != null ? (low + high) / 2 : null;
    let zoneType = result.zoneType || null;
    if (zoneType && String(zoneType).includes("demand")) zoneType = "DEMAND";
    else if (zoneType && String(zoneType).includes("supply")) zoneType = "SUPPLY";
    const price = indicators.closes?.[lastIdx];
    // Sprint 15: flat sd* ML fields
    const sdFields = {
      sdZoneType: zoneType,
      sdZoneLevel: mid,
      sdZoneSizeAtr: low != null && high != null && atr > 0 ? (high - low) / atr : null,
      sdRetestDepthAtr: mid != null && atr > 0 && price != null
        ? Math.abs(price - mid) / atr
        : null,
      sdVolumeConfirmation: Boolean(result.hasVolConfirm),
      sdTimeToRetestBars: zone.barsSince ?? zone.ageBars
        ?? (zone.idx != null ? lastIdx - zone.idx : null),
      sdConfluence: Boolean(
        zone.zoneKind && (String(zone.zoneKind).includes("ob") || String(zone.zoneKind).includes("fvg"))
      ),
    };
    this._lastSignalMeta = {
      component: "SUPPLY_AND_DEMAND",
      winningComponent: result.signal ? "SUPPLY_AND_DEMAND" : null,
      strategyLabel: "Supply and Demand",
      componentConfidence: result.signal ? Math.round(result.confidence * 100) : 0,
      confidence: result.confidence,
      reason: result.reason,
      zoneType: result.zoneType,
      nearestZone: result.nearestZone,
      tpOverride: result.takeProfit,
      tpSource: result.tpSource,
      hasVolConfirm: result.hasVolConfirm,
      atr,
      price,
      ...sdFields,
    };
    return result.signal || null;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.01, maxTradesPerDay: 4, slMultiplier: 1.4, tpMultiplier: 2.5 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.4;
    const tpMult = opts.tpMultiplier ?? 2.5;
    const slDist = atr * slMult;
    let tpDist = atr * tpMult;
    const meta = this._lastSignalMeta;
    if (meta?.tpOverride != null && Number.isFinite(meta.tpOverride)) {
      const d = Math.abs(meta.tpOverride - entryPrice);
      if (d >= slDist * 0.5) tpDist = d;
    }
    const side = typeof signal === "object" ? signal.signal : signal;
    return {
      stopLoss: side === "LONG" ? entryPrice - slDist : entryPrice + slDist,
      takeProfit: side === "LONG" ? entryPrice + tpDist : entryPrice - tpDist,
      slDistance: slDist,
      tpDistance: tpDist,
      riskReward: tpDist / slDist,
      tpSource: meta?.tpSource || "rr",
    };
  }

  getTimeframeConfig() {
    return { interval: "5m", higherTf: "1h", checkInterval: 60_000 };
  }

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = SupplyDemandStrategy;
