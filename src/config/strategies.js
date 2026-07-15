const {
  STRATEGY_RECAP_CATALOG,
  LIVE_RECAP_KEYS,
} = require("./strategyRecapCatalog");
const {
  STRATEGY_MIGRATION_MAP,
  STRATEGY_ABBREV,
  normalizeStrategyKey,
  ingressNormalizeStrategyKey,
  isLegacyAlias,
  isGen1StrategyKey,
  normalizeTradeTypeKey,
  LEGACY_TRADE_TYPE_ALIASES,
  GEN1_STRATEGY_LITERALS,
  abbrevToEngine,
  ABBREV_TO_ENGINE,
  getGen1DeprecationStats,
  resetGen1DeprecationStats,
} = require("./strategyKeyNormalizer");

/**
 * Quantara Strategy Configuration
 * Version: 2.1.0
 *
 * Umbrella + Component nesting model.
 * Each tier unlocks a POOL of independent component strategies (race-to-confirm).
 * Umbrella names are tier-access bags — not fusion/voting mechanisms.
 *
 * ─── Canonical live component keys ───────────────────────────────────────────
 *   SMART_MONEY_CONCEPTS · WYCKOFF · VOLUME_SPREAD_ANALYSIS   (FOUNDRY — Adaptive Fusion pool)
 *   TREND_FOLLOWING  · MARKET_STRUCTURE     · AUCTION_MARKET_THEORY    (FORGE  — Trend Surge pool)
 *   MEAN_REVERSION  · SUPPLY_AND_DEMAND     · STATISTICAL_ARBITRAGE    (MINT  — Mean Drift pool)
 *   BREAKOUT_RETEST  · ICT_STYLE_TRADING    · LIQUIDATION_SQUEEZE    (VAULT — Breakout Storm pool)
 *
 * ─── Legacy aliases (migrate → canonical via strategyKeyNormalizer ACL) ─────
 *   Umbrella keys (ADAPTIVE_FUSION, TREND_SURGE, MEAN_DRIFT, BREAKOUT_STORM)
 *   and Gen1 ingress keys normalize to SMART_MONEY_CONCEPTS / TREND_FOLLOWING / MEAN_REVERSION / BREAKOUT_RETEST.
 *   A / B / C                                    → PDF trade-type presets (NOT AF)
 *     (strategyDefaults.js A/B/C = Aggressive Scalping / Day / Swing — unrelated
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
  SMART_MONEY_CONCEPTS:     "SMART_MONEY_CONCEPTS",     // Smart Money Concepts     ✅ LIVE (racer)
  WYCKOFF: "WYCKOFF", // Wyckoff Spring/Upthrust  ✅ LIVE (racer)
  VOLUME_SPREAD_ANALYSIS:     "VOLUME_SPREAD_ANALYSIS",     // Volume Spread Analysis   ✅ LIVE (racer)
  AF_LS:      "AF_LS",      // Liquidity Sweep          ⏳ Sprint 9+
  AF_OBR:     "AF_OBR",     // Order Block Retest       ⏳ Sprint 9+

  // TREND_SURGE — FORGE Tier (Sprint 12: race-to-confirm among independent racers)
  TREND_FOLLOWING:  "TREND_FOLLOWING",    // Trend Following        ✅ LIVE (race participant)
  MARKET_STRUCTURE:  "MARKET_STRUCTURE",    // Dow Theory (HH/HL)     ✅ LIVE (race participant — Sprint 12)
  AUCTION_MARKET_THEORY:  "AUCTION_MARKET_THEORY",    // Auction Market Theory  ✅ LIVE (race participant — Sprint 12)
  TS_EW:  "TS_EW",    // Elliott Wave           ⏳ Future
  TS_PA:  "TS_PA",    // Price Action           ⏳ Future

  // MEAN_DRIFT — MINT Tier (Sprint 10: race-to-confirm)
  //   ADX Trend Strength Filter remains overlay inside MEAN_REVERSION (not a racer)
  MEAN_REVERSION:  "MEAN_REVERSION",    // Mean Reversion           ✅ LIVE (racer)
  SUPPLY_AND_DEMAND:  "SUPPLY_AND_DEMAND",    // Supply and Demand        ✅ LIVE (racer — Sprint 10)
  STATISTICAL_ARBITRAGE:  "STATISTICAL_ARBITRAGE",    // Statistical Arbitrage    ✅ LIVE (racer — Sprint 10)

  // BREAKOUT_STORM — VAULT Tier (Sprint 11: race-to-confirm)
  BREAKOUT_RETEST:  "BREAKOUT_RETEST",    // Breakout Retest              ⛔ HALTED Sprint 14 (5/5 windows loss)
  ICT_STYLE_TRADING: "ICT_STYLE_TRADING",   // ICT-style trading            ✅ LIVE (racer — Sprint 11)
  LIQUIDATION_SQUEEZE:  "LIQUIDATION_SQUEEZE",    // Liquidation/Squeeze Trading  ✅ LIVE (racer — Sprint 11)
};

/**
 * Sprint 14: BREAKOUT_RETEST Halt — realized backtest WR 37.1% / PF 0.72 across 5 windows
 * (n=267). Keep ICT + LS in the VAULT race; do NOT re-enable BREAKOUT_RETEST until the
 * 5-window re-test gate clears AFTER v2.6 entry-retest + volatility-floor fixes
 * (see Notion Sprint 14: ≥4/5 window PF>1, WR≥45%, hold-time matches PRD).
 * Override per-run via config.bsBrHalted === false (backtest validation only).
 */
const BS_BR_HALTED = true;
/** Gen2-only; ingress aliases resolved via normalizeStrategyKey. */
const BS_BR_HALT_ALIASES = new Set(["BREAKOUT_RETEST", "BREAKOUT_STORM"]);

function isBsBrHaltedKey(key) {
  if (!BS_BR_HALTED) return false;
  const canonical = normalizeStrategyKey(String(key || "").toUpperCase());
  return canonical === "BREAKOUT_RETEST";
}

function isBsBrOnlyKey(key) {
  return normalizeStrategyKey(String(key || "").toUpperCase()) === "BREAKOUT_RETEST";
}

/** Dedicated BREAKOUT_RETEST backtest — true BR engine, ignore live halt (strategyGuard still blocks live). */
function applyDedicatedBsBrBacktestConfig(cfg = {}) {
  const comps = cfg.selectedComponents || cfg.bsActiveRacers || [];
  const bsOnly = Array.isArray(comps) && comps.length > 0
    && comps.every((c) => isBsBrOnlyKey(c));
  if (!bsOnly) return cfg;
  return {
    ...cfg,
    bsCombinationMode: "single",
    bsBrHalted: false,
    selectedComponents: ["BREAKOUT_RETEST"],
    bsActiveRacers: ["BREAKOUT_RETEST"],
  };
}

/**
 * Experimental / bonus keys — registered in StrategyRegistry but NOT part of
 * umbrella race pools or TIER_COMPONENT_MAP.active.
 */
const EXPERIMENTAL_STRATEGIES = {
  GROK_AI_TRADING: "GROK_AI_TRADING", // VAULT bonus; LLM entry engine — use sparingly
};

// Gen1→Gen2 mapping lives in strategyKeyNormalizer.js (ACL SSOT).

// ─── Tier → component mapping ─────────────────────────────────────────────────

const TIER_COMPONENT_MAP = {
  FOUNDRY: {
    active: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
    umbrella: "ADAPTIVE_FUSION",
    abbrev: "AF",
    // Sprint 12: umbrella is a tier access bag; components race independently.
    combination: { mode: "race", participants: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"] },
  },
  FORGE: {
    active: ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"],
    umbrella: "TREND_SURGE",
    abbrev: "TS",
    combination: { mode: "race", participants: ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"] },
  },
  MINT: {
    active: ["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"],
    umbrella: "MEAN_DRIFT",
    abbrev: "MD",
    combination: { mode: "race", participants: ["MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE"] },
  },
  VAULT: {
    // Sprint 14: BREAKOUT_RETEST removed from live race pool until re-test gate passes.
    active: BS_BR_HALTED ? ["ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"] : ["BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"],
    umbrella: "BREAKOUT_STORM",
    abbrev: "BS",
    combination: {
      mode: "race",
      participants: BS_BR_HALTED ? ["ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"] : ["BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE"],
    },
    halted: BS_BR_HALTED ? ["BREAKOUT_RETEST"] : [],
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    "SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS",
    "TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY",
    "MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE",
    "BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE",
    "GROK_AI_TRADING", // experimental — see EXPERIMENTAL_STRATEGIES
  ];
  return liveKeys.includes(key);
}

/** Display metadata for live engines + race components (UI / filter catalog). */
const STRATEGY_CATALOG_BASE = {
  SMART_MONEY_CONCEPTS:     { label: "Smart Money Concepts",     umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "engine",    status: "production", tier: "FOUNDRY" },
  WYCKOFF: { label: "Wyckoff Method",           umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "component", status: "production", tier: "FOUNDRY" },
  VOLUME_SPREAD_ANALYSIS:     { label: "Volume Spread Analysis",   umbrella: "Adaptive Fusion", umbrellaAbbrev: "AF", role: "component", status: "production", tier: "FOUNDRY" },
  TREND_FOLLOWING:      { label: "Trend Following",          umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "engine",    status: "production", tier: "FORGE" },
  MARKET_STRUCTURE:      { label: "Dow Theory",               umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "component", status: "production", tier: "FORGE" },
  AUCTION_MARKET_THEORY:      { label: "Auction Market Theory",    umbrella: "Trend Surge",     umbrellaAbbrev: "TS", role: "component", status: "production", tier: "FORGE" },
  MEAN_REVERSION:      { label: "Mean Reversion",              umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "engine",    status: "production", tier: "MINT" },
  SUPPLY_AND_DEMAND:      { label: "Supply and Demand",           umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "component", status: "production", tier: "MINT" },
  STATISTICAL_ARBITRAGE:      { label: "Statistical Arbitrage",       umbrella: "Mean Drift",      umbrellaAbbrev: "MD", role: "component", status: "production", tier: "MINT" },
  BREAKOUT_RETEST:      { label: "Breakout Trading",            umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "engine",    status: BS_BR_HALTED ? "halted" : "production", tier: "VAULT" },
  ICT_STYLE_TRADING:     { label: "ICT-style trading",           umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "component", status: "production", tier: "VAULT" },
  LIQUIDATION_SQUEEZE:      { label: "Liquidation/Squeeze Trading", umbrella: "Breakout Storm",  umbrellaAbbrev: "BS", role: "component", status: "production", tier: "VAULT" },
};

/** Merge Trading Strategy Recap.pdf Konsep/Indicator/trade-type SSOT into catalog rows. */
const STRATEGY_CATALOG = Object.fromEntries(
  LIVE_RECAP_KEYS.map((key) => {
    const base = STRATEGY_CATALOG_BASE[key];
    const recap = STRATEGY_RECAP_CATALOG[key] || {};
    return [key, {
      ...base,
      pdfName: recap.pdfName || base.label,
      concept: recap.concept || null,
      indicators: recap.indicators || null,
      pdfTradeType: recap.pdfTradeType || null,
      runtimeTradeTypes: recap.runtimeTradeTypes || null,
      recapStatus: recap.recapStatus || null,
      recapNotes: recap.recapNotes || null,
      description: recap.concept || base.label,
    }];
  })
);

const CANONICAL_ENGINE_KEYS = ["SMART_MONEY_CONCEPTS", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];
const LIVE_COMPONENT_KEYS = [
  "SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS",
  "TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY",
  "MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE",
  "BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE",
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
  STRATEGY_RECAP_CATALOG,
  LIVE_RECAP_KEYS,
  CANONICAL_ENGINE_KEYS,
  LIVE_COMPONENT_KEYS,
  BS_BR_HALTED,
  BS_BR_HALT_ALIASES,
  GEN1_STRATEGY_LITERALS,
  LEGACY_TRADE_TYPE_ALIASES,
  ABBREV_TO_ENGINE,
  normalizeStrategyKey,
  ingressNormalizeStrategyKey,
  normalizeTradeTypeKey,
  isGen1StrategyKey,
  abbrevToEngine,
  getGen1DeprecationStats,
  resetGen1DeprecationStats,
  getActiveComponentsForTier,
  isActiveComponent,
  isLegacyAlias,
  isBsBrHaltedKey,
  applyDedicatedBsBrBacktestConfig,
  getStrategyCatalog,
};
