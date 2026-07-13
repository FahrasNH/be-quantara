/**
 * WyckoffStrategy.js — AF racer B (Spring / Upthrust / LPS / LPSY)
 *
 * Independent race participant under AdaptiveFusionUmbrella (Sprint 12).
 * Also usable as vote Component B when afCombinationMode:"vote".
 *
 * Entry logic follows Syarat_Entry_Strategi_Wyckoff.txt.
 * Event detection aligned with wyckoff_indicator.txt via wyckoffComponent.
 *
 * Default entryModel: "aggressive" (aligned with wyckoffComponent DEFAULTS / AF race).
 *   Spring/UTAD + reclaim + volume — viable for Scalping/Swing standalone backtests.
 * Set config.entryModel / config.wyckoff.entryModel to:
 *   "moderate"     — + prior trend + rejection wick + local CHoCH + RR ≥ 1:2 (Syarat)
 *   "conservative" — safest chain including SOS/SOW + LPS/LPSY
 */

"use strict";

const StrategyBase = require("../base/StrategyBase");
const {
  evaluateWyckoffComponent,
  candlesFromIndicators,
  DEFAULTS,
} = require("../af/wyckoffComponent");

/** Strategy-level defaults layered on component DEFAULTS. */
const STRATEGY_DEFAULTS = {
  entryModel: "aggressive",
  minRr: 2.0,
  volMultiplier: 1.5,
  lookback: 100,
};

class WyckoffStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "AF_WYCKOFF",
      label: "Wyckoff Method (Spring/Upthrust)",
      description:
        "AF Component B: Wyckoff accumulation/distribution entries " +
        "(Spring → reclaim → CHoCH → LPS / UTAD → rejection → CHoCH → LPSY) " +
        "with volume confirmation per schematic indicator rules.",
      version: "2.0.0",
      enabled: true,
      ...config,
    });
    this._lastSignalMeta = null;
    this._lastSignalIdx = null;
  }

  _mergedConfig(config = {}) {
    return {
      ...DEFAULTS,
      ...STRATEGY_DEFAULTS,
      ...this.config?.wyckoff,
      ...config.wyckoff,
      ...config,
    };
  }

  rankByMarketConditions(marketConditions = {}) {
    const { volatility = 1.0, trend_strength = 0.3 } = marketConditions;
    // Wyckoff thrives in ranging / moderate-vol markets after a prior trend
    let score = 50;
    if (trend_strength < 0.25) score += 25;
    if (volatility >= 0.8 && volatility <= 2.0) score += 15;
    if (trend_strength > 0.6) score -= 20;
    return [
      {
        key: "AF_WYCKOFF",
        label: this.config.label,
        score: Math.max(0, Math.min(100, score)),
        reason: "range_phase_affinity",
      },
    ];
  }

  canActivate(balance, htfTrend, volatility) {
    if (balance != null && balance < 10) {
      return { allowed: false, reason: "insufficient_balance" };
    }
    return { allowed: true, reason: "ok" };
  }

  detectSignal(indicators, lastIdx, config = {}) {
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      this._mergedConfig(config),
      { lastSignalIdx: this._lastSignalIdx },
    );

    this._lastSignalMeta = {
      component: "AF_WYCKOFF",
      vote: result.vote,
      confidence: result.confidence,
      reason: result.reason,
      meta: result.meta || null,
    };

    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
      return result.vote;
    }
    return null;
  }

  /**
   * Full evaluation with NEUTRAL (for umbrella vote breakdown).
   */
  evaluate(indicators, lastIdx, config = {}) {
    const candles = candlesFromIndicators(indicators, lastIdx);
    const result = evaluateWyckoffComponent(
      candles,
      this._mergedConfig(config),
      { lastSignalIdx: this._lastSignalIdx },
    );
    this._lastSignalMeta = {
      component: "AF_WYCKOFF",
      ...result,
    };
    if (result.vote === "LONG" || result.vote === "SHORT") {
      this._lastSignalIdx = lastIdx;
    }
    return result;
  }

  getLastSignalMeta() {
    return this._lastSignalMeta;
  }

  /**
   * Risk: min RR 1:2 (Syarat §10). SL below Spring / above UTAD when meta available.
   */
  getRiskConfig() {
    return {
      riskPerTrade: 0.01,
      maxTradesPerDay: 4,
      slMultiplier: 1.0,
      tpMultiplier: 2.0, // ≥ 1:2 vs SL
      minRr: STRATEGY_DEFAULTS.minRr,
    };
  }

  getTimeframeConfig() {
    return { interval: "15m", higherTf: "1h", checkInterval: 60_000 };
  }

  /**
   * Validate entry: volume + ATR + optional Wyckoff checklist / RR from last meta.
   */
  validateEntry(price, atr, volume, volSMA) {
    if (!volume || volume === 0) return { valid: false, reason: "missing_volume" };
    if (volSMA && volume < 0.5 * volSMA) return { valid: false, reason: "low_volume" };
    if (!atr || atr <= 0) return { valid: false, reason: "no_atr" };

    const meta = this._lastSignalMeta;
    if (meta?.meta?.entry && !meta.meta.entry.passed) {
      return { valid: false, reason: meta.meta.entry.reason || "entry_checklist_failed" };
    }

    // RR + proximity are moderate/conservative Syarat gates — do not re-apply on aggressive.
    const model = meta?.meta?.entry?.model
      || this._mergedConfig().entryModel
      || STRATEGY_DEFAULTS.entryModel;
    if (model === "aggressive") {
      return { valid: true, reason: "ok" };
    }

    if (meta?.meta?.rr != null && meta.meta.rr < STRATEGY_DEFAULTS.minRr) {
      return { valid: false, reason: "rr_below_minimum" };
    }

    // Prefer discount (long) / premium (short) — reject mid-range without confirmation
    const range = meta?.meta?.range;
    const vote = meta?.vote;
    if (range?.rangeHigh != null && range?.rangeLow != null && price != null && vote) {
      const mid = range.midRange ?? (range.rangeHigh + range.rangeLow) / 2;
      const width = range.rangeHigh - range.rangeLow;
      if (width > 0) {
        if (vote === "LONG" && price > mid + width * 0.15) {
          return { valid: false, reason: "long_too_close_to_resistance" };
        }
        if (vote === "SHORT" && price < mid - width * 0.15) {
          return { valid: false, reason: "short_too_close_to_support" };
        }
      }
    }

    return { valid: true, reason: "ok" };
  }

  /**
   * Suggested SL/TP from last signal meta (Spring low / UTAD high → range opposite).
   */
  getStopTakeLevels(price, side) {
    const meta = this._lastSignalMeta?.meta;
    if (!meta) return null;
    const sl = meta.stopLoss;
    const tp = meta.takeProfit;
    if (sl == null || tp == null || price == null) return null;
    if (side === "LONG" && !(sl < price && tp > price)) return null;
    if (side === "SHORT" && !(sl > price && tp < price)) return null;
    return { stopLoss: sl, takeProfit: tp, rr: meta.rr ?? null };
  }
}

module.exports = WyckoffStrategy;
