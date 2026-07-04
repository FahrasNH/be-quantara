// ─────────────────────────────────────────────────────────────────────────────
// Per-type risk ladder (v2.8, 2026-07-04)
//
// riskPerTrade stays the COMBINED cap across all concurrent type legs of a
// strategy, but instead of splitting it EQUALLY (÷ typeOrder.length), it is
// distributed by trade-type weight — Swing runners deserve full size, Scalping
// chop deserves the least:
//
//   weights  Scalping 0.5 : Intraday 1 : Swing 2
//
//   AF_SMC  combined 0.035 → 0.5% (A/Scalping) / 1% (B/Intraday) / 2% (C/Swing)
//   TS_TF   combined 0.03  → 1% (Intraday) / 2% (Swing)
//   MD_MR   combined 0.015 → 0.5% (Scalping) / 1% (Intraday)
//
// Used by BOTH RealStrategyBacktestService (runTripleTypeBacktest /
// runMultiTypeBacktest) and live BotEngine._handleMultiPositionSignal — single
// source of truth so live sizing can never drift from what the backtest showed
// (the 3× SMC live-risk bug class, 311e18d).
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_RISK_WEIGHTS = { Scalping: 0.5, Intraday: 1, Swing: 2 };

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
