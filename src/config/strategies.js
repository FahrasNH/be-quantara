/**
 * Quantara Strategy Configuration
 * Version: 2.0.0
 *
 * Umbrella + Component nesting model.
 * Each tier has one umbrella; each umbrella has one or more component strategies.
 */

// ─── Umbrella identifiers ────────────────────────────────────────────────────

const UMBRELLA_STRATEGIES = {
  ADAPTIVE_FUSION: "AF",
  TREND_SURGE:     "TS",
  MEAN_DRIFT:      "MD",
  BREAKOUT_STORM:  "BS",
};

// ─── Active component strategy keys ──────────────────────────────────────────

const COMPONENT_STRATEGIES = {
  // ADAPTIVE_FUSION — FOUNDRY Tier (3-component voting: SMC + Wyckoff + VSA)
  AF_SMC:     "AF_SMC",     // Smart Money Concepts     ✅ LIVE (Component A)
  AF_WYCKOFF: "AF_WYCKOFF", // Wyckoff Spring/Upthrust  ✅ LIVE (Component B)
  AF_VSA:     "AF_VSA",     // Volume Spread Analysis   ✅ LIVE (Component C)
  AF_LS:      "AF_LS",      // Liquidity Sweep          ⏳ Sprint 9+
  AF_OBR:     "AF_OBR",     // Order Block Retest       ⏳ Sprint 9+

  // TREND_SURGE — FORGE Tier (A trigger + B structure gate + C VWAP precision)
  TS_TF:  "TS_TF",    // Trend Following        ✅ LIVE (Component A)
  TS_MS:  "TS_MS",    // Dow Theory (HH/HL)     ✅ LIVE (Component B — Sprint 9)
  TS_VP:  "TS_VP",    // Auction Market Theory  ✅ LIVE (Component C — Sprint 9)
  TS_EW:  "TS_EW",    // Elliott Wave           ⏳ Future
  TS_PA:  "TS_PA",    // Price Action           ⏳ Future

  // MEAN_DRIFT — MINT Tier
  MD_MR:  "MD_MR",    // Mean Reversion         ✅ LIVE
  MD_BB:  "MD_BB",    // Bollinger Bands        ⏳ Future
  MD_RD:  "MD_RD",    // RSI Divergence         ⏳ Future

  // BREAKOUT_STORM — VAULT Tier
  BS_BR:  "BS_BR",    // Breakout Retest        ✅ LIVE
  BS_VS:  "BS_VS",    // Volatility Spike       ⏳ Future
  BS_LB:  "BS_LB",    // Level Breakout         ⏳ Future
};

// ─── Migration map: old key → new key ────────────────────────────────────────
// Used by StrategyRegistry and Prisma migration script.
// Primary keys: AF_SMC, TS_TF, MD_MR, BS_BR
// Legacy aliases redirect to primary keys.

const STRATEGY_MIGRATION_MAP = {
  AF_SMC:               "AF_SMC",  // primary: Adaptive Fusion - Smart Money Concepts
  ADAPTIVE_FUSION:      "AF_SMC",  // legacy: old user name
  SAC:                  "AF_SMC",  // legacy: old abbreviation (SAC = Smart Money Concepts Abbreviation — confusing)
  SMART_MONEY_CONCEPTS: "AF_SMC",  // legacy: descriptor
  TS_TF:                "TS_TF",   // primary: Trend Surge - Trend Following
  TREND_FOLLOWING:      "TS_TF",   // legacy: descriptor
  TF:                   "TS_TF",   // legacy: abbreviation
  MEAN_REVERSION:       "MD_MR",
  MR:                   "MD_MR",
  BREAKOUT_RETEST:      "BS_BR",
  BR:                   "BS_BR",
};

// ─── Abbreviated labels (for UI display) ─────────────────────────────────────

const STRATEGY_ABBREV = {
  AF_SMC:               "AF",
  AF_WYCKOFF:           "AF",
  AF_VSA:               "AF",
  TS_TF:                "TS",
  TS_MS:                "TS",
  TS_VP:                "TS",
  MD_MR:                "MD",
  BS_BR:                "BS",
  // Legacy backward compat
  ADAPTIVE_FUSION:      "AF",
  SMART_MONEY_CONCEPTS: "AF",
  TREND_FOLLOWING:      "TS",
  MEAN_REVERSION:       "MD",
  BREAKOUT_RETEST:      "BS",
};

// ─── Tier → component mapping ─────────────────────────────────────────────────

const TIER_COMPONENT_MAP = {
  FOUNDRY: {
    active: ["AF_SMC", "AF_WYCKOFF", "AF_VSA"],
    umbrella: "ADAPTIVE_FUSION",
    abbrev: "AF",
    voting: { defaultMinVotes: 2, altcoinMinVotes: 3 },
  },
  FORGE: {
    active: ["TS_TF", "TS_MS", "TS_VP"],
    umbrella: "TREND_SURGE",
    abbrev: "TS",
    layering: { structureGate: true, vwapPrecision: true },
  },
  MINT:    { active: ["MD_MR"],  umbrella: "MEAN_DRIFT",      abbrev: "MD" },
  VAULT:   { active: ["BS_BR"],  umbrella: "BREAKOUT_STORM",  abbrev: "BS" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a strategy key (resolve legacy → new).
 * Returns the canonical key or the original if already current.
 */
function normalizeStrategyKey(key) {
  return STRATEGY_MIGRATION_MAP[key] || key;
}

/**
 * Get active component keys for a given tier.
 */
function getActiveComponentsForTier(tier) {
  return TIER_COMPONENT_MAP[tier]?.active || [];
}

/**
 * Check if a key is a currently live component (not future).
 */
function isActiveComponent(key) {
  const liveKeys = [
    "AF_SMC", "AF_WYCKOFF", "AF_VSA",
    "TS_TF", "TS_MS", "TS_VP",
    "MD_MR", "BS_BR", "GROK_AI_TRADING",
  ];
  return liveKeys.includes(key);
}

module.exports = {
  UMBRELLA_STRATEGIES,
  COMPONENT_STRATEGIES,
  STRATEGY_MIGRATION_MAP,
  STRATEGY_ABBREV,
  TIER_COMPONENT_MAP,
  normalizeStrategyKey,
  getActiveComponentsForTier,
  isActiveComponent,
};
