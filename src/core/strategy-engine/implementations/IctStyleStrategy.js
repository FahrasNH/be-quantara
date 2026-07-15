/**
 * IctStyleStrategy.js — BS_ICT (ICT-style trading)
 * BREAKOUT_STORM race participant #1.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const { evaluateIctStyleEntry, DEFAULTS } = require("../bs/ictKillZoneRaidEntry");

class IctStyleStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "BS_ICT",
      label: "ICT-style trading",
      description:
        "BS race participant (PDF ICT): Kill Zone UTC + liquidity raid reversal " +
        "(raid HIGH→SHORT, raid LOW→LONG); OTE/MSS subset.",
      version: "1.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 0.5 } = marketConditions;
    let score = 55;
    if (volatility > 0.4) score += 15;
    return [{
      key: "BS_ICT",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "ict_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateIctStyleEntry({
      highs: indicators.highs || [],
      lows: indicators.lows || [],
      closes: indicators.closes || [],
      volumes: indicators.volumes || [],
      volSMA: indicators.volSMA,
      timestamps: indicators.timestamps || indicators.times || indicators.openTimes || config.timestamps,
      lastIdx,
      config: { ...DEFAULTS, ...this.config, ...config },
    });
    const kz = result.killZone || {};
    const raid = result.raid || {};
    const reason = String(result.reason || raid.reason || "");
    let raidType = "NO_RAID";
    if (reason.includes("raid_high") || raid.direction === "SHORT") raidType = "RAID_HIGH";
    else if (reason.includes("raid_low") || raid.direction === "LONG") raidType = "RAID_LOW";
    const hourUtc = kz.minuteOfDay != null ? Math.floor(kz.minuteOfDay / 60) : null;
    // Sprint 15: flat ict* ML fields
    const ictFields = {
      ictKillZoneHour: hourUtc,
      ictKillZoneLevel: raid.level ?? null,
      ictRaidType: result.signal ? raidType : (raid.detected ? raidType : "NO_RAID"),
      ictRaidDepthAtr: null, // needs ATR at wire-time; BotEngine/backtest may fill
      ictVolumeRatio: raid.volOk === false ? 0.5 : (raid.volOk ? 1.2 : null),
      ictReversal: Boolean(result.signal && reason.includes("reversal")),
      ictMssPct: null, // MSS % not computed in current ICT raid subset
    };
    this._lastSignalMeta = {
      component: "BS_ICT",
      winningComponent: result.signal ? "BS_ICT" : null,
      strategyLabel: "ICT-style trading",
      componentConfidence: result.signal ? Math.round(result.confidence * 100) : 0,
      confidence: result.confidence,
      reason: result.reason,
      killZone: result.killZone,
      raid: result.raid,
      ...ictFields,
    };
    return result.signal || null;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 4, slMultiplier: 1.5, tpMultiplier: 2.5 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.5;
    const tpMult = opts.tpMultiplier ?? 2.5;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;
    const side = typeof signal === "object" ? signal.signal : signal;
    // Prefer SL beyond raid wick level when available
    const raidLevel = this._lastSignalMeta?.raid?.level;
    let stopLoss;
    let takeProfit;
    if (side === "LONG") {
      stopLoss = raidLevel != null && raidLevel < entryPrice
        ? Math.min(entryPrice - slDist, raidLevel - atr * 0.2)
        : entryPrice - slDist;
      takeProfit = entryPrice + tpDist;
    } else {
      stopLoss = raidLevel != null && raidLevel > entryPrice
        ? Math.max(entryPrice + slDist, raidLevel + atr * 0.2)
        : entryPrice + slDist;
      takeProfit = entryPrice - tpDist;
    }
    return {
      stopLoss,
      takeProfit,
      slDistance: Math.abs(entryPrice - stopLoss),
      tpDistance: Math.abs(takeProfit - entryPrice),
      riskReward: Math.abs(takeProfit - entryPrice) / Math.max(Math.abs(entryPrice - stopLoss), 1e-12),
    };
  }

  getTimeframeConfig() {
    return { interval: "15m", higherTf: "4h", checkInterval: 60_000 };
  }

  validateEntry() {
    return { valid: true, reason: "ok" };
  }
}

module.exports = IctStyleStrategy;
