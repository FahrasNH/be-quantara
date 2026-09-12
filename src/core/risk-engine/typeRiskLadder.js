// ─────────────────────────────────────────────────────────────────────────────
// Per-type risk ladder (v4.0, 2026-07-19)
//
// riskPerTrade stays the COMBINED cap across all concurrent type legs of a
// strategy, but instead of splitting it EQUALLY (÷ typeOrder.length), it is
// distributed by trade-type weight:
//
//   v4.0 weights:  Scalping 1 : Intraday 2 : Swing 2  (sum 5)
//   Allocation:    1% + 2% + 2% = 5% combined cap
//
//   ALL 12 strategies  combined 0.05 → 1% (Scalping) / 2% (Intraday) / 2% (Swing)
//           (uniform per user directive 2026-07-19 — supersedes v3.2 2:3:4)
//
// Used by BOTH RealStrategyBacktestService (runTripleTypeBacktest /
// runMultiTypeBacktest) and live BotEngine._handleMultiPositionSignal — single
// source of truth so live sizing can never drift from what the backtest showed
// (the 3× SMC live-risk bug class, 311e18d).
//
// Optional cfg.typeRiskWeights overrides the default map per strategy (e.g.
// Wyckoff de-emphasizes Scalping fee-drag while keeping trade frequency).
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_RISK_WEIGHTS = { Scalping: 1, Intraday: 2, Swing: 2 };

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
 * @param {Object} [weightOverrides] - optional per-type weights (e.g. { Scalping: 0.25 })
 */
function riskShareForType(type, activeTypes, combinedRisk, weightOverrides) {
  const weights = (weightOverrides && typeof weightOverrides === "object")
    ? { ...TYPE_RISK_WEIGHTS, ...weightOverrides }
    : TYPE_RISK_WEIGHTS;
  const resolved = resolveType(type);
  const w = weights[resolved] ?? 1;
  const sum = (activeTypes || []).reduce(
    (s, t) => s + (weights[resolveType(t)] ?? 1),
    0,
  );
  if (!sum || !Number.isFinite(combinedRisk)) return combinedRisk;
  return combinedRisk * (w / sum);
}

/**
 * Apply optional per-leg risk overrides from typeOverrides[leg]:
 *   - riskPerTrade: absolute share (replaces ladder share)
 *   - riskMult: multiply the ladder share (e.g. Swing 4× without touching SC/ID)
 * Sibling legs are unchanged when only one leg sets these knobs.
 */
function applyLegRiskShare(sharedRisk, legOverrides = {}) {
  if (Number.isFinite(legOverrides?.riskPerTrade) && legOverrides.riskPerTrade > 0) {
    return legOverrides.riskPerTrade;
  }
  const mult = Number(legOverrides?.riskMult);
  if (Number.isFinite(mult) && mult > 0) return sharedRisk * mult;
  return sharedRisk;
}

module.exports = {
  TYPE_RISK_WEIGHTS,
  COMPONENT_TYPE,
  resolveType,
  riskShareForType,
  applyLegRiskShare,
};
