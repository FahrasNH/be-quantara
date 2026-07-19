/**
 * liveTradeTypeGate.js — Sprint 14 live-safety gate (SSOT).
 *
 * The Sprint 14 factory reset opened all 3 trade types (Scalping / Intraday /
 * Swing) on EVERY umbrella for the Advance backtest — "apapun hasilnya". Some
 * of those legs are brand-new or unproven and must NOT trade real money until
 * they pass the 5-window walk-forward gate.
 *
 * Concretely: the "Scalping" leg was re-based onto a genuine 5m/30m stack (it
 * used to be a mislabelled 15m intraday leg). 5m has no demonstrated edge yet,
 * so Scalping is Advance-backtest-only. The previously-live 15m cadence now
 * lives under the "Intraday" label (proven), which — together with Swing —
 * stays live-eligible.
 *
 * This gate is consulted ONLY on the real-live path (dryRun === false). Dry-run
 * still exercises every leg so users can observe them without risking funds.
 * Backtest does not import this module at all.
 *
 * To promote a leg to live: add its type to LIVE_ELIGIBLE_TYPES (globally or
 * per-strategy) once it clears walk-forward validation.
 */

// Types that may trade REAL money by default (all strategies).
const DEFAULT_LIVE_ELIGIBLE_TYPES = ["Intraday", "Swing"];

// Optional per-strategy overrides (keyed by any strategy/engine key). Empty =
// use the default set. Populate when a specific strategy validates a leg.
const PER_STRATEGY_LIVE_ELIGIBLE_TYPES = {
  // e.g. SMART_MONEY_CONCEPTS: ["Intraday", "Swing"],  // Scalping stays backtest-only
};

/**
 * @param {string} strategyKey - e.g. "SMART_MONEY_CONCEPTS" / "TREND_FOLLOWING"
 * @param {string} type - "Scalping" | "Intraday" | "Swing"
 * @returns {boolean} true if this (strategy, type) leg may trade real money.
 */
function isTypeLiveEligible(strategyKey, type) {
  if (!type) return false;
  const eligible =
    PER_STRATEGY_LIVE_ELIGIBLE_TYPES[strategyKey] || DEFAULT_LIVE_ELIGIBLE_TYPES;
  return eligible.includes(type);
}

module.exports = {
  DEFAULT_LIVE_ELIGIBLE_TYPES,
  PER_STRATEGY_LIVE_ELIGIBLE_TYPES,
  isTypeLiveEligible,
};
