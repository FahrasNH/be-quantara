/**
 * VolumeProfileStrategy.js — TS Component C (Auction Market Theory / VWAP + Value Area)
 *
 * Sprint 12: independent race participant with VWAP reclaim / VA-edge entries.
 * Precision helpers retained for tsCombinationMode:"gate" rollback.
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateVolumeProfileComponent,
  evaluateVolumeProfilePrecision,
  evaluateVolumeProfileEntry,
  DEFAULTS,
} = require("../ts/volumeProfileEntry");

class VolumeProfileStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "AUCTION_MARKET_THEORY",
      label: "Auction Market Theory",
      description:
        "TS race participant: Auction Market Theory — session VWAP reclaim / Value Area edge entries (independent of Trend Following).",
      version: "2.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._ablation = null;
  }

  static get ABLATION_SCHEMA() {
    return [
      { key: "evaluated", label: "1. Bars evaluated" },
      { key: "rejWarmup", label: "2. - Warmup insufficient" },
      { key: "rejSession", label: "3. - Session timestamp gate" },
      { key: "rejVwapBars", label: "4. - Session VWAP bars" },
      { key: "rejProfile", label: "5. - Volume profile (POC/VAH/VAL)" },
      { key: "rejVwap", label: "6. - VWAP reclaim/lose" },
      { key: "rejValVahReject", label: "7. - VAL bounce / VAH reject" },
      { key: "passed", label: "= PASSED (tradeable signals)" },
    ];
  }
  resetAblation() {
    const a = {};
    for (const s of VolumeProfileStrategy.ABLATION_SCHEMA) a[s.key] = 0;
    this._ablation = a;
    return this._ablation;
  }
  getAblation() { return this._ablation; }
  getAblationSchema() { return VolumeProfileStrategy.ABLATION_SCHEMA; }

  rankByMarketConditions(marketConditions = {}) {
    const { volume = 1.0 } = marketConditions;
    let score = 50;
    if (volume >= 1.0) score += 20;
    return [{
      key: "AUCTION_MARKET_THEORY",
      label: this.config.label,
      score: Math.max(0, Math.min(100, score)),
      reason: "liquidity_affinity",
    }];
  }

  canActivate(balance) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  /**
   * Race-mode entry signal (VWAP reclaim/lose or VA edge bounce).
   */
  detectSignal(indicators, lastIdx, config = {}) {
    const result = evaluateVolumeProfileEntry(indicators, lastIdx, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
      ablation: this._ablation,
    });
    const nested = result.meta || {};
    // Sprint 15: flat vp* ML fields for Dynamic ML multi-sheet export
    const vpFields = {
      vpVwapLevel: nested.vwap ?? null,
      vpVahLevel: nested.vah ?? null,
      vpValLevel: nested.val ?? null,
      vpPocLevel: nested.poc ?? null,
      vpTriggerType: result.reason ? String(result.reason).toUpperCase() : null,
    };
    this._lastSignalMeta = {
      component: "AUCTION_MARKET_THEORY",
      winningComponent: result.signal ? "AUCTION_MARKET_THEORY" : null,
      strategyLabel: "Auction Market Theory",
      ...result,
      ...vpFields,
    };
    return result.signal || null;
  }

  evaluate(indicators, lastIdx, config = {}) {
    const result = evaluateVolumeProfileComponent(indicators, lastIdx, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
    });
    this._lastSignalMeta = { component: "AUCTION_MARKET_THEORY", ...result };
    return result;
  }

  evaluatePrecision(indicators, lastIdx, direction, config = {}) {
    const result = evaluateVolumeProfilePrecision(indicators, lastIdx, direction, {
      ...DEFAULTS,
      ...config.volumeProfile,
      ...config,
    });
    this._lastSignalMeta = { component: "AUCTION_MARKET_THEORY", ...result };
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  getRiskConfig() {
    return { riskPerTrade: 0.015, maxTradesPerDay: 3, slMultiplier: 1.5, tpMultiplier: 3.0 };
  }

  calculateRiskConfig(entryPrice, atr, signal, _component, opts = {}) {
    const slMult = opts.slMultiplier ?? 1.5;
    const tpMult = opts.tpMultiplier ?? 3.0;
    const slDist = atr * slMult;
    const tpDist = atr * tpMult;
    return {
      stopLoss: signal === "LONG" ? entryPrice - slDist : entryPrice + slDist,
      takeProfit: signal === "LONG" ? entryPrice + tpDist : entryPrice - tpDist,
      slDistance: slDist,
      tpDistance: tpDist,
      riskReward: tpMult / slMult,
    };
  }

  getTimeframeConfig() {
    return { interval: "5m", higherTf: "4h", checkInterval: 60_000 };
  }

  validateEntry(price, atr, volume) {
    if (!volume || volume === 0) return { valid: false, reason: "missing_volume" };
    return { valid: true, reason: "ok" };
  }
}

module.exports = VolumeProfileStrategy;
