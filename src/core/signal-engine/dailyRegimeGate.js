// ─────────────────────────────────────────────────────────────────────────────
// Daily Regime Gate (v1.0, 2026-07-04)
//
// Detects whether daily timeframe is in a strong trend or choppy/sideways regime.
// Used by BOTH backtest engine (RealStrategyBacktestService) and live engine
// (BotEngine) to gate momentum strategies and protect Mean Reversion from
// strong-trend continuation risk.
//
// Principle: ADX-proxy = |EMA9−EMA21| / ATR
//   - Strong trend (>0.8): full trading for directional strategies; MR blocked
//   - Chop (<0.5): TF & BR disabled, SMC size −50%
//   - Transition (0.5-0.8): gradual degradation (not yet implemented; TBD)
//
// Daily data is precomputed on strategy start (backtest) or fetched fresh (live),
// then cached. Per-bar decisions use the cached daily values (one decision per
// calendar day, not per bar).
// ─────────────────────────────────────────────────────────────────────────────

const { calcEMA, calcATR } = require("../analytics-engine/indicators");
const { normalizeStrategyKey } = require("../../config/strategyKeyNormalizer");

// Thresholds (principle-based, NOT optimized to any period)
const TREND_STRENGTH_THRESHOLD_STRONG = 0.8;  // trend: full trading
const TREND_STRENGTH_THRESHOLD_CHOP = 0.5;    // chop: TREND_FOLLOWING/BREAKOUT_RETEST disabled, SMC −50%

/**
 * Compute daily trend strength for a set of daily candles.
 * Returns array parallel to input: trendStrength[i] = ADX-proxy for day i
 *
 * @param {Object} dailyCandles - {open, high, low, close, volume} arrays
 * @returns {number[]} trendStrength per candle (0.0-2.0 range typical)
 */
function computeDailyTrendStrength(dailyCandles) {
  if (!dailyCandles?.close?.length) return [];

  const closes = dailyCandles.close;
  const highs = dailyCandles.high;
  const lows = dailyCandles.low;

  // Precompute EMA9, EMA21, ATR once
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(highs, lows, closes, 14);

  const trend = [];
  for (let i = 0; i < closes.length; i++) {
    const emaDist = Math.abs(ema9[i] - ema21[i]);
    const atrVal = atr[i] || 1; // avoid division by zero
    trend.push(emaDist / atrVal);
  }
  return trend;
}

/**
 * Get regime for a specific date based on precomputed daily trend strength.
 * Used by backtest + live to make per-bar gating decisions.
 *
 * @param {Date|string} date - ISO date (YYYY-MM-DD)
 * @param {Object} cache - { dailyTrend, dateMap } cached from strategy start
 * @returns {string} "STRONG_TREND" | "CHOP" | "TRANSITION" | "UNKNOWN"
 */
function getRegimeForDate(date, cache) {
  if (!cache?.dateMap) return "UNKNOWN";

  const dateStr = typeof date === "string" ? date.split("T")[0] : date.toISOString().split("T")[0];
  let idx = cache.dateMap.get(dateStr);

  // Sprint 14: backfill gaps (timezone / missing daily bar) — walk back up to 3 days
  // so Daily Regime is not UNKNOWN solely due to dateMap holes at window edges.
  if (idx === undefined) {
    const base = new Date(`${dateStr}T00:00:00.000Z`);
    if (!Number.isNaN(base.getTime())) {
      for (let d = 1; d <= 3; d++) {
        const prev = new Date(base.getTime() - d * 86400000).toISOString().split("T")[0];
        idx = cache.dateMap.get(prev);
        if (idx !== undefined) break;
      }
    }
  }

  if (idx === undefined) return "UNKNOWN";

  const strength = cache.dailyTrend[idx];
  if (strength == null || Number.isNaN(strength)) return "UNKNOWN";
  // Warmup days (EMA/ATR not ready) — treat early nulls as UNKNOWN; after
  // first valid strength, reuse last known for sparse maps already handled above.
  if (strength >= TREND_STRENGTH_THRESHOLD_STRONG) return "STRONG_TREND";
  if (strength < TREND_STRENGTH_THRESHOLD_CHOP) return "CHOP";
  return "TRANSITION";
}

/**
 * Apply gate to signal & return modified risk/size.
 *
 * @param {Object} params
 *   - signal: "LONG" | "SHORT" | null
 *   - strategyKey: "SMART_MONEY_CONCEPTS" | "TREND_FOLLOWING" | "MEAN_REVERSION" | "BREAKOUT_RETEST"
 *   - regime: "STRONG_TREND" | "CHOP" | "TRANSITION" | "UNKNOWN"
 *   - riskPerTrade: base risk %
 *   - blockLongInChop: Sprint 13 — when true, block LONG in CHOP for structure strategies
 *     (SHORT still allowed). Fail-open when false/undefined.
 *   - blockAllInChop: Sprint 22 — when true, block ALL sides in CHOP (Intraday tier).
 *   - blockStrongTrend: Mean Reversion safety gate; defaults to true for MR.
 *   - blockTransition: optional Mean Reversion transition gate.
 * @returns {Object} { allow: boolean, riskPerTrade: adjusted%, reason: string }
 */
function applyRegimeGate(params) {
  const {
    signal,
    strategyKey,
    regime,
    riskPerTrade,
    blockLongInChop,
    blockAllInChop,
    blockStrongTrend,
    blockTransition,
    mrChopRiskMultiplier,
    mrTransitionRiskMultiplier,
  } = params;

  if (!signal || regime === "UNKNOWN") {
    return { allow: true, riskPerTrade, reason: "no_signal_or_unknown_regime" };
  }

  const key = normalizeStrategyKey(String(strategyKey || "").toUpperCase());
  const isMomentum = key === "TREND_FOLLOWING" || key === "MARKET_STRUCTURE" || key === "AUCTION_MARKET_THEORY"
    || key === "BREAKOUT_RETEST" || key === "ICT_STYLE_TRADING" || key === "LIQUIDATION_SQUEEZE"
    || key === "BREAKOUT_STORM";
  const isStructure = key === "SMART_MONEY_CONCEPTS" || key === "WYCKOFF" || key === "VOLUME_SPREAD_ANALYSIS";
  const isMeanReversion = key === "MEAN_REVERSION";

  if (regime === "STRONG_TREND") {
    if (isMeanReversion && blockStrongTrend !== false) {
      return { allow: false, riskPerTrade: 0, reason: "strong_trend_mean_reversion_blocked" };
    }
    // Full trading for strategies whose edge is directional.
    return { allow: true, riskPerTrade, reason: "strong_trend_full_size" };
  }

  if (regime === "CHOP") {
    if (isMeanReversion) {
      const multiplier = Number.isFinite(mrChopRiskMultiplier)
        ? Math.max(0, mrChopRiskMultiplier)
        : 0.5;
      return {
        allow: true,
        riskPerTrade: riskPerTrade * multiplier,
        reason: `chop_mean_reversion_${multiplier}x_size`,
      };
    }
    if (isMomentum) {
      // TF & BR disabled during chop (false breakout risk too high)
      return { allow: false, riskPerTrade: 0, reason: "chop_momentum_blocked" };
    }
    if (isStructure) {
      // Sprint 22: Intraday tier — both sides lose in CHOP; skip entirely.
      if (blockAllInChop === true) {
        return { allow: false, riskPerTrade: 0, reason: "chop_all_blocked" };
      }
      // Sprint 13: optional Side×Regime gate — counter-trend LONGs in CHOP are
      // historically weak; SHORT fades remain allowed.
      if (blockLongInChop && signal === "LONG") {
        return { allow: false, riskPerTrade: 0, reason: "chop_long_blocked" };
      }
      // SMC (structure-based) runs at 50% size during chop (still profitable but safer)
      return { allow: true, riskPerTrade: riskPerTrade * 0.5, reason: "chop_structure_half_size" };
    }
    // Default: unknown strategy, conservative
    return { allow: true, riskPerTrade: riskPerTrade * 0.5, reason: "chop_default_half_size" };
  }

  if (regime === "TRANSITION") {
    if (isMeanReversion && blockTransition === true) {
      return { allow: false, riskPerTrade: 0, reason: "transition_mean_reversion_blocked" };
    }
    const multiplier = isMeanReversion && Number.isFinite(mrTransitionRiskMultiplier)
      ? Math.max(0, mrTransitionRiskMultiplier)
      : 0.75;
    return { allow: true, riskPerTrade: riskPerTrade * multiplier, reason: "transition_gradual" };
  }

  return { allow: true, riskPerTrade, reason: "unknown_regime_fallback" };
}

module.exports = {
  computeDailyTrendStrength,
  getRegimeForDate,
  applyRegimeGate,
  TREND_STRENGTH_THRESHOLD_STRONG,
  TREND_STRENGTH_THRESHOLD_CHOP,
};
