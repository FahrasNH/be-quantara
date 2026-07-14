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
 *   MD_MR  · MD_SD     · MD_SA    (MINT  — Mean Drift pool)
 *   BS_BR  · BS_ICT    · BS_LS    (VAULT — Breakout Storm pool)
 *
 * ─── Legacy aliases (migrate → canonical; do NOT add new top-level presets) ──
 *   ADAPTIVE_FUSION / SMART_MONEY_CONCEPTS / SAC → AF_SMC
 *   TREND_FOLLOWING / TF / TM                     → TS_TF
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

  // MEAN_DRIFT — MINT Tier (Sprint 10: race-to-confirm)
  //   ADX Trend Strength Filter remains overlay inside MD_MR (not a racer)
  MD_MR:  "MD_MR",    // Mean Reversion           ✅ LIVE (racer)
  MD_SD:  "MD_SD",    // Supply and Demand        ✅ LIVE (racer — Sprint 10)
  MD_SA:  "MD_SA",    // Statistical Arbitrage    ✅ LIVE (racer — Sprint 10)

  // BREAKOUT_STORM — VAULT Tier (Sprint 11: race-to-confirm)
  BS_BR:  "BS_BR",    // Breakout Retest              ⛔ HALTED Sprint 14 (5/5 windows loss)
  BS_ICT: "BS_ICT",   // ICT-style trading            ✅ LIVE (racer — Sprint 11)
  BS_LS:  "BS_LS",    // Liquidation/Squeeze Trading  ✅ LIVE (racer — Sprint 11)
};

/**
 * Sprint 14: BS_BR Halt — realized backtest WR 37.1% / PF 0.72 across 5 windows
 * (n=267). Keep ICT + LS in the VAULT race; do NOT re-enable BS_BR until the
 * 5-window re-test gate clears AFTER v2.6 entry-retest + volatility-floor fixes
 * (see Notion Sprint 14: ≥4/5 window PF>1, WR≥45%, hold-time matches PRD).
 * Override per-run via config.bsBrHalted === false (backtest validation only).
 */
const BS_BR_HALTED = true;
const BS_BR_HALT_ALIASES = new Set([
  "BS_BR", "BREAKOUT_RETEST", "BREAKOUT_TRADING", "BR", "BREAKOUT_STORM",
]);

function isBsBrHaltedKey(key) {
  if (!BS_BR_HALTED) return false;
  return BS_BR_HALT_ALIASES.has(String(key || "").toUpperCase());
}

const BS_BR_ONLY_KEYS = new Set(["BS_BR", "BREAKOUT_RETEST", "BREAKOUT_TRADING", "BR"]);

/** Dedicated BS_BR backtest — true BR engine, ignore live halt (strategyGuard still blocks live). */
function applyDedicatedBsBrBacktestConfig(cfg = {}) {
  const comps = cfg.selectedComponents || cfg.bsActiveRacers || [];
  const bsOnly = Array.isArray(comps) && comps.length > 0
    && comps.every((c) => BS_BR_ONLY_KEYS.has(String(c || "").toUpperCase()));
  if (!bsOnly) return cfg;
  return {
    ...cfg,
    bsCombinationMode: "single",
    bsBrHalted: false,
    selectedComponents: ["BS_BR"],
    bsActiveRacers: ["BS_BR"],
  };
}

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
  TM:                   "TS_TF",   // legacy: Gen1 admin/conflict abbrev (pre-TS)
  MEAN_REVERSION:       "MD_MR",
  MEAN_DRIFT:           "MD_MR",   // umbrella bag name → primary engine
  MR:                   "MD_MR",   // legacy: Gen1 abbrev
  BREAKOUT_RETEST:      "BS_BR",
  BREAKOUT_STORM:       "BS_BR",   // umbrella bag name → primary engine
  BR:                   "BS_BR",   // legacy: Gen1 abbrev
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
  MD_SD:                "MD",
  MD_SA:                "MD",
  BS_BR:                "BS",
  BS_ICT:               "BS",
  BS_LS:                "BS",
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
    active: ["MD_MR", "MD_SD", "MD_SA"],
    umbrella: "MEAN_DRIFT",
    abbrev: "MD",
    combination: { mode: "race", participants: ["MD_MR", "MD_SD", "MD_SA"] },
  },
  VAULT: {
    // Sprint 14: BS_BR removed from live race pool until re-test gate passes.
    active: BS_BR_HALTED ? ["BS_ICT", "BS_LS"] : ["BS_BR", "BS_ICT", "BS_LS"],
    umbrella: "BREAKOUT_STORM",
    abbrev: "BS",
    combination: {
      mode: "race",
      participants: BS_BR_HALTED ? ["BS_ICT", "BS_LS"] : ["BS_BR", "BS_ICT", "BS_LS"],
    },
    halted: BS_BR_HALTED ? ["BS_BR"] : [],
  },
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
    "MD_MR", "MD_SD", "MD_SA",
    "BS_BR", "BS_ICT", "BS_LS",
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

/** Display metadata for live engines + race components (UI / filter catalog). */
const STRATEGY_CATALOG = {
  AF_SMC:     { label: "Smart Money Concepts",     umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "engine",    status: "production", tier: "FOUNDRY" },
  AF_WYCKOFF: { label: "Wyckoff Method",           umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "component", status: "production", tier: "FOUNDRY" },
  AF_VSA:     { label: "Volume Spread Analysis",   umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "component", status: "production", tier: "FOUNDRY" },
  TS_TF:      { label: "Trend Following",          umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "engine",    status: "production", tier: "FORGE" },
  TS_MS:      { label: "Dow Theory",               umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "component", status: "production", tier: "FORGE" },
  TS_VP:      { label: "Auction Market Theory",    umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "component", status: "production", tier: "FORGE" },
  MD_MR:      { label: "Mean Reversion",              umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "engine",    status: "production", tier: "MINT" },
  MD_SD:      { label: "Supply and Demand",           umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "component", status: "production", tier: "MINT" },
  MD_SA:      { label: "Statistical Arbitrage",       umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "component", status: "production", tier: "MINT" },
  BS_BR:      { label: "Breakout Retest",             umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "engine",    status: BS_BR_HALTED ? "halted" : "production", tier: "VAULT" },
  BS_ICT:     { label: "ICT-style trading",           umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "component", status: "production", tier: "VAULT" },
  BS_LS:      { label: "Liquidation/Squeeze Trading", umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "component", status: "production", tier: "VAULT" },
};

const CANONICAL_ENGINE_KEYS = ["AF_SMC", "TS_TF", "MD_MR", "BS_BR"];
const LIVE_COMPONENT_KEYS = [
  "AF_SMC", "AF_WYCKOFF", "AF_VSA",
  "TS_TF", "TS_MS", "TS_VP",
  "MD_MR", "MD_SD", "MD_SA",
  "BS_BR", "BS_ICT", "BS_LS",
];

/**
 * Single catalog for strategy pickers / filters.
 * Legacy Gen1 aliases are intentionally omitted from `engines`/`components`
 * (normalize via STRATEGY_MIGRATION_MAP). Overlay modifiers (ADX / OI+Funding)
 * are never listed — they are not selectable strategies.
 */
function getStrategyCatalog() {
  const engines = CANONICAL_ENGINE_KEYS.map((key) => ({
    key,
    ...STRATEGY_CATALOG[key],
    abbrev: STRATEGY_ABBREV[key],
  }));
  const components = LIVE_COMPONENT_KEYS.map((key) => ({
    key,
    ...STRATEGY_CATALOG[key],
    abbrev: STRATEGY_ABBREV[key],
  }));
  const umbrellas = Object.entries(TIER_COMPONENT_MAP).map(([tier, cfg]) => ({
    tier,
    key: CANONICAL_ENGINE_KEYS.find((k) => STRATEGY_CATALOG[k]?.tier === tier) || cfg.active[0],
    label: STRATEGY_CATALOG[cfg.active[0]]?.umbrella || cfg.umbrella,
    abbrev: cfg.abbrev,
    components: cfg.active,
  }));
  return {
    engines,
    components,
    umbrellas,
    aliases: { ...STRATEGY_MIGRATION_MAP },
  };
}

module.exports = {
  UMBRELLA_STRATEGIES,
  COMPONENT_STRATEGIES,
  EXPERIMENTAL_STRATEGIES,
  STRATEGY_MIGRATION_MAP,
  STRATEGY_ABBREV,
  TIER_COMPONENT_MAP,
  STRATEGY_CATALOG,
  CANONICAL_ENGINE_KEYS,
  LIVE_COMPONENT_KEYS,
  BS_BR_HALTED,
  BS_BR_HALT_ALIASES,
  normalizeStrategyKey,
  getActiveComponentsForTier,
  isActiveComponent,
  isLegacyAlias,
  isBsBrHaltedKey,
  applyDedicatedBsBrBacktestConfig,
  getStrategyCatalog,
};
