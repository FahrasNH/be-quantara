// ─────────────────────────────────────────────────────────────────────────────
// Per-type risk ladder (v3.2, 2026-07-05)
//
// riskPerTrade stays the COMBINED cap across all concurrent type legs of a
// strategy, but instead of splitting it EQUALLY (÷ typeOrder.length), it is
// distributed by trade-type weight:
//
//   v3.2 weights:  Scalping 2 : Intraday 3 : Swing 4
//   Allocation:    1% + 1.5% + 2% = 4.5% combined cap
//
//   SMART_MONEY_CONCEPTS  combined 0.045 → 1% (Scalping RR 2.0) / 1.5% (Intraday) / 2% (Swing)
//           (Previously v3.1: 0.5% / 1.5% / 2% — Scalping +0.5% RR fix)
//   TREND_FOLLOWING   combined 0.03  → 1% (Intraday) / 2% (Swing) [unchanged]
//   MEAN_REVERSION   combined 0.015 → 0.5% (Scalping) / 1% (Intraday) [unchanged]
//
// Used by BOTH RealStrategyBacktestService (runTripleTypeBacktest /
// runMultiTypeBacktest) and live BotEngine._handleMultiPositionSignal — single
// source of truth so live sizing can never drift from what the backtest showed
// (the 3× SMC live-risk bug class, 311e18d).
//
// v3.2 Rationale:
// - Scalping 1%: RR 2.0 root cause fix (SL 2.2×ATR, TP 4.4×ATR, 1W:2L ratio)
// - Intraday 1.5%: 28.9% WR BULLISH-only + regime filter = breakeven→profit
// - Swing 2%: 41.7% WR proven; stable anchor capital
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_RISK_WEIGHTS = { Scalping: 2, Intraday: 3, Swing: 4 };

// Live multi-AF componentIds are "A"/"B"/"C" (SMC sub-strategies); backtest
// uses the full type names. Map both vocabularies (key-vocab standing rule).
const COMPONENT_TYPE = { A: "Scalping", B: "Intraday", C: "Swing" };

function resolveType(idOrType) {
  return COMPONENT_TYPE[idOrType] || idOrType;
}

/**
 * Share of the combined riskPerTrade cap for one type leg.
 * @param {string} type          - "Scalping" | "Intraday" | "Swing" (or "A"/"B"/"C")
 * @param {string[]} activeTypes - all concurrently-running type legs
 * @param {number} combinedRisk  - the strategy's configured riskPerTrade (combined cap)
 */
function riskShareForType(type, activeTypes, combinedRisk) {
  const resolved = resolveType(type);
  const w = TYPE_RISK_WEIGHTS[resolved] ?? 1;
  const sum = (activeTypes || []).reduce(
    (s, t) => s + (TYPE_RISK_WEIGHTS[resolveType(t)] ?? 1),
    0,
  );
  if (!sum || !Number.isFinite(combinedRisk)) return combinedRisk;
  return combinedRisk * (w / sum);
}

module.exports = { TYPE_RISK_WEIGHTS, COMPONENT_TYPE, resolveType, riskShareForType };
