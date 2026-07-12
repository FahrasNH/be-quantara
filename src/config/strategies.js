/**
 * Quantara Strategy Configuration
 * Version: 2.1.0
 *
 * Umbrella + Component nesting model.
 * Each tier unlocks a POOL of independent component strategies (race-to-confirm).
 * Umbrella names are tier-access bags — not fusion/voting mechanisms.
 *
 * ─── Canonical live component keys ───────────────────────────────────────────
 *   AF_SMC · AF_WYCKOFF · AF_VSA   (FOUNDRY — Adaptive Fusion pool)
 *   TS_TF  · TS_MS     · TS_VP    (FORGE  — Trend Surge pool)
 *   MD_MR                          (MINT)
 *   BS_BR                          (VAULT)
 *
 * ─── Legacy aliases (migrate → canonical; do NOT add new top-level presets) ──
 *   ADAPTIVE_FUSION / SMART_MONEY_CONCEPTS / SAC → AF_SMC
 *   TREND_FOLLOWING / TF                         → TS_TF
 *   MEAN_REVERSION / MR                          → MD_MR
 *   BREAKOUT_RETEST / BR                         → BS_BR
 *   A / B / C                                    → PDF trade-type presets (NOT AF)
 *     (legacyStrategies.js A/B/C = Aggressive Scalping / Day / Swing — unrelated
 *      to AF component slots; never treat as Adaptive Fusion keys)
 *
 * ─── GROK_AI_TRADING (experimental / VAULT bonus — NOT a tier umbrella) ──────
 *   Real strategy key that CAN generate entry/exit via Grok (xAI).
 *   Architecture principle: LLM should be complementary (context/narrative),
 *   not a primary signal engine. Kept registered for VAULT bonus + admin
 *   experiments; gated by entitlement (VAULT / open mode). Do NOT add to
 *   TIER_COMPONENT_MAP race pools. Prefer GrokConfirm overlay over this key
 *   for production bots.
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
  // ADAPTIVE_FUSION — FOUNDRY Tier (3 independent racers: SMC + Wyckoff + VSA)
  AF_SMC:     "AF_SMC",     // Smart Money Concepts     ✅ LIVE (racer)
  AF_WYCKOFF: "AF_WYCKOFF", // Wyckoff Spring/Upthrust  ✅ LIVE (racer)
  AF_VSA:     "AF_VSA",     // Volume Spread Analysis   ✅ LIVE (racer)
  AF_LS:      "AF_LS",      // Liquidity Sweep          ⏳ Sprint 9+
  AF_OBR:     "AF_OBR",     // Order Block Retest       ⏳ Sprint 9+

  // TREND_SURGE — FORGE Tier (Sprint 12: race-to-confirm among independent racers)
  TS_TF:  "TS_TF",    // Trend Following        ✅ LIVE (race participant)
  TS_MS:  "TS_MS",    // Dow Theory (HH/HL)     ✅ LIVE (race participant — Sprint 12)
  TS_VP:  "TS_VP",    // Auction Market Theory  ✅ LIVE (race participant — Sprint 12)
  TS_EW:  "TS_EW",    // Elliott Wave           ⏳ Future
  TS_PA:  "TS_PA",    // Price Action           ⏳ Future

  // MEAN_DRIFT — MINT Tier (single live key; A→B→C layers inside MD_MR)
  //   A: BB+RSI mean reversion · B: ADX regime gate · C: OB/FVG precision
  MD_MR:  "MD_MR",    // Mean Reversion (layered) ✅ LIVE
  MD_BB:  "MD_BB",    // Bollinger Bands          ⏳ Future
  MD_RD:  "MD_RD",    // RSI Divergence           ⏳ Future

  // BREAKOUT_STORM — VAULT Tier
  BS_BR:  "BS_BR",    // Breakout Retest        ✅ LIVE
  BS_VS:  "BS_VS",    // Volatility Spike       ⏳ Future
  BS_LB:  "BS_LB",    // Level Breakout         ⏳ Future
};

/**
 * Experimental / bonus keys — registered in StrategyRegistry but NOT part of
 * umbrella race pools or TIER_COMPONENT_MAP.active.
 */
const EXPERIMENTAL_STRATEGIES = {
  GROK_AI_TRADING: "GROK_AI_TRADING", // VAULT bonus; LLM entry engine — use sparingly
};

// ─── Migration map: old key → new key ────────────────────────────────────────
// Used by StrategyRegistry and Prisma migration script.
// Primary Gen2 keys (AF_SMC, AF_WYCKOFF, …) are NOT listed — identity is implicit.
// Legacy aliases redirect to primary keys. Components stay as-is via fallback.

const STRATEGY_MIGRATION_MAP = {
  ADAPTIVE_FUSION:      "AF_SMC",  // legacy: old umbrella preset name
  SAC:                  "AF_SMC",  // legacy: old abbreviation
  SMART_MONEY_CONCEPTS: "AF_SMC",  // legacy: descriptor preset
  TREND_FOLLOWING:      "TS_TF",   // legacy: descriptor
  TREND_SURGE:          "TS_TF",   // umbrella bag name → primary engine
  TF:                   "TS_TF",   // legacy: abbreviation
  MEAN_REVERSION:       "MD_MR",
  MEAN_DRIFT:           "MD_MR",   // umbrella bag name → primary engine
  MR:                   "MD_MR",
  BREAKOUT_RETEST:      "BS_BR",
  BREAKOUT_STORM:       "BS_BR",   // umbrella bag name → primary engine
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
  GROK_AI_TRADING:      "GA",
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
    // Sprint 12: umbrella is a tier access bag; components race independently.
    combination: { mode: "race", participants: ["AF_SMC", "AF_WYCKOFF", "AF_VSA"] },
  },
  FORGE: {
    active: ["TS_TF", "TS_MS", "TS_VP"],
    umbrella: "TREND_SURGE",
    abbrev: "TS",
    combination: { mode: "race", participants: ["TS_TF", "TS_MS", "TS_VP"] },
  },
  MINT: {
    active: ["MD_MR"],
    umbrella: "MEAN_DRIFT",
    abbrev: "MD",
    // Layered pipeline inside MD_MR (not a race pool — see MeanReversionStrategy).
    combination: { mode: "pipeline", layers: ["BB_RSI", "ADX_GATE", "OB_FVG"] },
  },
  VAULT:   { active: ["BS_BR"],  umbrella: "BREAKOUT_STORM",  abbrev: "BS" },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize a strategy key (resolve legacy → Gen2 canonical).
 * Components (AF_WYCKOFF, TS_MS, …) and already-canonical keys pass through.
 */
function normalizeStrategyKey(key) {
  if (key == null || key === "") return key;
  const raw = String(key);
  return STRATEGY_MIGRATION_MAP[raw] || STRATEGY_MIGRATION_MAP[raw.toUpperCase()] || raw;
}

/**
 * Get active component keys for a given tier.
 */
function getActiveComponentsForTier(tier) {
  return TIER_COMPONENT_MAP[tier]?.active || [];
}

/**
 * Check if a key is a currently live component (not future).
 * GROK_AI_TRADING is live-but-experimental (VAULT bonus), not a race-pool member.
 */
function isActiveComponent(key) {
  const liveKeys = [
    "AF_SMC", "AF_WYCKOFF", "AF_VSA",
    "TS_TF", "TS_MS", "TS_VP",
    "MD_MR", "BS_BR",
    "GROK_AI_TRADING", // experimental — see EXPERIMENTAL_STRATEGIES
  ];
  return liveKeys.includes(key);
}

/**
 * True if key is a deprecated alias that should migrate to a canonical key.
 */
function isLegacyAlias(key) {
  const k = String(key || "").toUpperCase();
  return Boolean(STRATEGY_MIGRATION_MAP[k]);
}

module.exports = {
  UMBRELLA_STRATEGIES,
  COMPONENT_STRATEGIES,
  EXPERIMENTAL_STRATEGIES,
  STRATEGY_MIGRATION_MAP,
  STRATEGY_ABBREV,
  TIER_COMPONENT_MAP,
  normalizeStrategyKey,
  getActiveComponentsForTier,
  isActiveComponent,
  isLegacyAlias,
};
