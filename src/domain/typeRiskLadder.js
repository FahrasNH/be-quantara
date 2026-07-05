// ─────────────────────────────────────────────────────────────────────────────
// Per-type risk ladder (v3.1, 2026-07-05)
//
// riskPerTrade stays the COMBINED cap across all concurrent type legs of a
// strategy, but instead of splitting it EQUALLY (÷ typeOrder.length), it is
// distributed by trade-type weight:
//
//   v3.1 weights:  Scalping 1 : Intraday 3 : Swing 4
//   Allocation:    0.5% + 1.5% + 2% = 4% combined cap
//
//   AF_SMC  combined 0.04 → 0.5% (Scalping 15m/5m hybrid) / 1.5% (Intraday) / 2% (Swing)
//           (Previously: 0.5% / 1% / 2% — Intraday +0.5%, Swing stable, Scalping active hybrid)
//   TS_TF   combined 0.03  → 1% (Intraday) / 2% (Swing) [unchanged]
//   MD_MR   combined 0.015 → 0.5% (Scalping) / 1% (Intraday) [unchanged]
//
// Used by BOTH RealStrategyBacktestService (runTripleTypeBacktest /
// runMultiTypeBacktest) and live BotEngine._handleMultiPositionSignal — single
// source of truth so live sizing can never drift from what the backtest showed
// (the 3× SMC live-risk bug class, 311e18d).
//
// v3.1 Rationale:
// - Scalping 0.5%: 15m/5m hybrid testing phase (TP ladder + volume + displacement gates)
// - Intraday 1.5%: 28.9% WR BULLISH-only + regime filter = breakeven→profit
// - Swing 2%: 41.7% WR proven; stable anchor capital
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_RISK_WEIGHTS = { Scalping: 1, Intraday: 3, Swing: 4 };

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
