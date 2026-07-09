"use strict";

/**
 * FeatureEngineer.js — Sprint 5 / RL-2
 *
 * Transforms entryContext JSON + trade metadata → normalized 60-dim feature vector.
 * Uses pure JS normalization (no external dependencies).
 * All values are clamped to [0, 1] range; NaN/Infinity → 0.
 *
 * Feature layout (60 total):
 *   [0-9]   Signal features
 *   [10-19] Regime features
 *   [20-29] Market features
 *   [30-39] Time features
 *   [40-49] Risk features
 *   [50-59] Historical features
 */

const VECTOR_DIM = 60;

const REGIMES = ["trend_up", "trend_down", "ranging", "expansion", "compression", "high_vol", "low_vol", "other"];
const PAIR_TIERS = ["LIQUID", "STABLE", "VOLATILE"];
const STRATEGY_KEYS = ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];
const TRADE_TYPES = ["Scalping", "Swing"];

const FEATURE_NAMES = [
  // [0-9] Signal features
  "signal_confidenceScore", "signal_bosScore", "signal_chochScore", "signal_orderBlockFresh",
  "signal_fvgScore", "signal_liquidityScore", "signal_signalQuality", "signal_votingScore",
  "signal_entryConfidence", "signal_rejectScore",
  // [10-19] Regime features
  "regime_trend_up", "regime_trend_down", "regime_ranging", "regime_expansion",
  "regime_compression", "regime_high_vol", "regime_low_vol", "regime_other",
  "regime_regimeConfidence", "regime_adxValue",
  // [20-29] Market features
  "market_atr", "market_atrPct", "market_rsi", "market_bbWidth",
  "market_volumeRatio", "market_spread", "market_fundingRate", "market_ema9",
  "market_ema21", "market_ema50",
  // [30-39] Time features
  "time_hour_of_day", "time_day_of_week", "time_is_weekend", "time_is_asia",
  "time_is_europe", "time_is_us", "time_minute_of_hour", "time_pad1",
  "time_pad2", "time_pad3",
  // [40-49] Risk features
  "risk_riskPercent", "risk_leverage", "risk_plannedRR", "risk_capitalAllocated",
  "risk_tier_LIQUID", "risk_tier_STABLE", "risk_tier_VOLATILE", "risk_side_LONG",
  "risk_side_SHORT", "risk_pad1",
  // [50-59] Historical features
  "hist_winRate", "hist_profitFactor", "hist_sharpe", "hist_avgHoldingHours",
  "hist_recentWinStreak", "hist_recentLossStreak",
  "hist_strategy_ADAPTIVE_FUSION", "hist_strategy_TREND_FOLLOWING",
  "hist_strategy_MEAN_REVERSION", "hist_strategy_BREAKOUT_RETEST",
];

class FeatureEngineer {
  /**
   * Generate a 60-dim normalized feature vector from entryContext + tradeMetadata.
   * @param {object} entryContext — from TradeFeatureCollector.captureEntryFeatures()
   * @param {object} tradeMetadata — { strategyKey, symbol, side, dryRun }
   * @returns {Float32Array} length 60
   */
  buildFeatureVector(entryContext = {}, tradeMetadata = {}) {
    const ctx = entryContext || {};
    const meta = tradeMetadata || {};

    const vec = new Float32Array(VECTOR_DIM);
    let i = 0;

    // ── [0-9] Signal features ─────────────────────────────────────────────
    vec[i++] = this.normalize(ctx.confidenceScore,  0, 100);
    vec[i++] = this.normalize(ctx.bosScore,         0, 100);
    vec[i++] = this.normalize(ctx.chochScore,       0, 100);
    vec[i++] = ctx.orderBlockFresh ? 1 : 0;
    vec[i++] = this.normalize(ctx.fvgScore,         0, 100);
    vec[i++] = this.normalize(ctx.liquidityScore,   0, 100);
    vec[i++] = this.normalize(ctx.signalQuality,    0, 100);
    vec[i++] = this.normalize(ctx.votingScore,      0, 100);
    vec[i++] = this.normalize(ctx.entryConfidence,  0, 100);
    vec[i++] = this.normalize(ctx.rejectScore,      0, 100);

    // ── [10-19] Regime features ───────────────────────────────────────────
    const regimeKey = (ctx.regime || "other").toLowerCase().replace(/[\s-]/g, "_");
    for (const r of REGIMES) {
      vec[i++] = regimeKey === r ? 1 : 0;
    }
    vec[i++] = this.normalize(ctx.regimeConfidence, 0, 100);
    vec[i++] = this.normalize(ctx.adxValue,         0, 100);

    // ── [20-29] Market features ───────────────────────────────────────────
    const price = ctx.price || ctx.entryPrice || 1;
    vec[i++] = this.normalize(ctx.atr,            0, price * 0.1);   // ATR up to 10% of price
    vec[i++] = this.normalize(ctx.atrPct,         0, 10);             // ATR% up to 10%
    vec[i++] = this.normalize(ctx.rsi,            0, 100);
    vec[i++] = this.normalize(ctx.bbWidth,        0, 0.2);            // BB width up to 20%
    vec[i++] = this.normalize(ctx.volumeRatio,    0, 5);              // vol ratio up to 5x
    vec[i++] = this.normalize(ctx.spread,         0, 0.01);           // spread up to 1%
    // Funding rate clamped to [-0.1, 0.1] then normalized to [0,1]
    const fundingClamped = Math.max(-0.1, Math.min(0.1, ctx.fundingRate ?? 0));
    vec[i++] = this.normalize(fundingClamped, -0.1, 0.1);
    // EMA values: normalize relative to price
    vec[i++] = price > 0 ? this.normalize(ctx.ema9  ?? price, price * 0.95, price * 1.05) : 0.5;
    vec[i++] = price > 0 ? this.normalize(ctx.ema21 ?? price, price * 0.95, price * 1.05) : 0.5;
    vec[i++] = price > 0 ? this.normalize(ctx.ema50 ?? price, price * 0.95, price * 1.05) : 0.5;

    // ── [30-39] Time features ─────────────────────────────────────────────
    const capturedAt = ctx.capturedAt ? new Date(ctx.capturedAt) : new Date();
    const hour = capturedAt.getUTCHours();
    const dow  = capturedAt.getUTCDay();
    const min  = capturedAt.getUTCMinutes();

    vec[i++] = hour / 24;
    vec[i++] = dow  / 7;
    vec[i++] = dow === 0 || dow === 6 ? 1 : 0; // weekend

    // Trading sessions (UTC hours)
    vec[i++] = (hour >= 1  && hour < 9)  ? 1 : 0; // Asia: 01:00-09:00 UTC
    vec[i++] = (hour >= 8  && hour < 17) ? 1 : 0; // Europe: 08:00-17:00 UTC
    vec[i++] = (hour >= 13 && hour < 22) ? 1 : 0; // US: 13:00-22:00 UTC

    vec[i++] = min / 60;
    vec[i++] = 0; // padding
    vec[i++] = 0; // padding
    vec[i++] = 0; // padding

    // ── [40-49] Risk features ─────────────────────────────────────────────
    vec[i++] = this.normalize(ctx.riskPercent ?? ctx.riskPerTrade, 0, 10);
    vec[i++] = this.normalize(ctx.leverage,    0, 10);
    vec[i++] = this.normalize(ctx.plannedRR,   0, 5);
    // Capital allocated: log-normalize (log10(capital)/log10(1M)) → [0,1]
    const capital = Math.max(1, ctx.capitalAllocated ?? ctx.capital ?? 500);
    vec[i++] = Math.min(1, Math.log10(capital) / 6);

    // Pair tier one-hot
    const pairTier = (ctx.pairTier || "").toUpperCase();
    for (const t of PAIR_TIERS) {
      vec[i++] = pairTier === t ? 1 : 0;
    }
    // Side one-hot
    const side = (meta.side || ctx.side || "").toUpperCase();
    vec[i++] = side === "LONG"  ? 1 : 0;
    vec[i++] = side === "SHORT" ? 1 : 0;
    vec[i++] = 0; // padding

    // ── [50-59] Historical features ───────────────────────────────────────
    vec[i++] = this.normalize(ctx.historicalWR     ?? ctx.histWinRate,    0, 1);
    vec[i++] = this.normalize(ctx.historicalPF     ?? ctx.histProfitFactor, 0, 5);
    vec[i++] = this.normalize(ctx.historicalSharpe ?? ctx.histSharpe,     -3, 3);
    vec[i++] = this.normalize(ctx.avgHoldingHours, 0, 72); // up to 72h
    vec[i++] = this.normalize(ctx.recentWinStreak, 0, 10);
    vec[i++] = this.normalize(ctx.recentLossStreak, 0, 10);

    // Strategy key one-hot
    const stratKey = (meta.strategyKey || ctx.strategyKey || "").toUpperCase();
    for (const s of STRATEGY_KEYS) {
      vec[i++] = stratKey === s ? 1 : 0;
    }

    // Validate
    if (!this.validateVector(vec)) {
      // Sanitize any remaining NaN/Infinity
      for (let j = 0; j < VECTOR_DIM; j++) {
        if (!Number.isFinite(vec[j])) vec[j] = 0;
      }
    }

    return vec;
  }

  /**
   * Normalize a value to [0, 1] range (clamp at boundaries).
   * Returns 0 if value is not a finite number.
   */
  normalize(value, min, max) {
    if (value === null || value === undefined || !Number.isFinite(value)) return 0;
    if (max === min) return 0;
    const normalized = (value - min) / (max - min);
    return Math.max(0, Math.min(1, normalized));
  }

  /**
   * Returns the array of feature names (for interpretability).
   * @returns {string[]} length 60
   */
  getFeatureNames() {
    return [...FEATURE_NAMES];
  }

  /**
   * Validate that a vector has no NaN/Infinity and is the correct length.
   * @returns {boolean}
   */
  validateVector(vector) {
    if (!vector || vector.length !== VECTOR_DIM) return false;
    for (let i = 0; i < VECTOR_DIM; i++) {
      if (!Number.isFinite(vector[i])) return false;
    }
    return true;
  }

  /**
   * Check for data leakage — ensure no exit data is present in entryContext.
   * Returns array of suspect field names (empty = no leakage detected).
   * @param {object} entryContext
   * @returns {string[]}
   */
  checkLeakage(entryContext = {}) {
    const LEAKAGE_FIELDS = [
      "exitPrice", "exit_price", "pnl", "pnlPct", "pnl_pct",
      "exitedAt", "exited_at", "closeTime", "close_time",
      "actualOutcome", "result", "exitContext", "exitReason",
    ];
    const found = [];
    for (const field of LEAKAGE_FIELDS) {
      if (field in entryContext && entryContext[field] !== null && entryContext[field] !== undefined) {
        found.push(field);
      }
    }
    return found;
  }
}

module.exports = FeatureEngineer;
module.exports.VECTOR_DIM = VECTOR_DIM;
module.exports.FEATURE_NAMES = FEATURE_NAMES;
