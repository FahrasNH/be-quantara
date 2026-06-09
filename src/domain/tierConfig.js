// ─────────────────────────────────────────────
// tierConfig.js — Tier Entitlement Source of Truth
//
// Maps subscription tier → allowed strategies + feature flags.
// Every entitlement check must read from here — no hardcoded tier logic elsewhere.
//
// Tier hierarchy: FOUNDRY < FORGE < MINT < VAULT
// ─────────────────────────────────────────────

const TIER_CONFIG = {
  FOUNDRY: {
    label: "Foundry",
    price: 9,
    strategies: ["ADAPTIVE_FUSION"],
    maxPositions: 1,
    // Multi-Strategy per Coin: alokasi modal equal-weight antar strategi pada
    // satu koin, dan maks satu posisi per strategi per simbol.
    capitalAllocation: { equal: true },
    maxPositionsPerSymbol: 1,
    autoSelector: false,
    aiOptimizer: false,
    supportSLA: null,       // self-service
    capitalRange: { min: 1_000_000, max: 2_000_000 },
  },

  FORGE: {
    label: "Forge",
    price: 29,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM"],
    maxPositions: 2,
    capitalAllocation: { equal: true },
    maxPositionsPerSymbol: 2,
    autoSelector: false,
    aiOptimizer: false,
    supportSLA: "48h",
    capitalRange: { min: 2_000_000, max: 5_000_000 },
  },

  MINT: {
    label: "Mint",
    price: 79,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION"],
    maxPositions: 3,
    capitalAllocation: { equal: true },
    maxPositionsPerSymbol: 3,
    autoSelector: true,
    aiOptimizer: false,     // static equal-weight allocation
    supportSLA: "24h",
    capitalRange: { min: 10_000_000, max: 15_000_000 },
  },

  VAULT: {
    label: "Vault",
    price: 299,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION", "BREAKOUT_RETEST"],
    maxPositions: 4,
    // equal: true → 25% per strategi. dynamic (AI optimizer) menyusul di Fase 3.
    capitalAllocation: { equal: true /* dynamic: false */ },
    maxPositionsPerSymbol: 4,   // bukan maxPositions global
    autoSelector: true,
    // AI optimizer feature flag — disabled until Fase 3
    aiOptimizer: process.env.VAULT_AI_OPTIMIZER_ENABLED === "true",
    supportSLA: "2h",
    capitalRange: { min: 30_000_000, max: null },
  },
};

// Ascending tier order (used for upgrade path display)
const TIER_ORDER = ["FOUNDRY", "FORGE", "MINT", "VAULT"];

/**
 * Get config for a tier. Returns null if tier is invalid.
 * @param {string} tier
 */
function getTierConfig(tier) {
  return TIER_CONFIG[tier] ?? null;
}

/**
 * Check if a tier is allowed to use a given strategy.
 * @param {string} tier
 * @param {string} strategyKey
 * @returns {{ allowed: boolean, requiredTier?: string }}
 */
function canUseStrategy(tier, strategyKey) {
  const config = getTierConfig(tier);
  if (!config) return { allowed: false };

  if (config.strategies.includes(strategyKey)) {
    return { allowed: true };
  }

  // Find the lowest tier that unlocks this strategy
  const requiredTier = TIER_ORDER.find((t) =>
    TIER_CONFIG[t].strategies.includes(strategyKey)
  );

  return { allowed: false, requiredTier: requiredTier ?? null };
}

/**
 * Map legacy balanceTier (A/B/C) to new tier name.
 * Used only for the one-time migration.
 * @param {string} legacy  "A" | "B" | "C"
 * @returns {string}
 */
function migrateLegacyTier(legacy) {
  const map = { C: "FOUNDRY", B: "FORGE", A: "MINT" };
  return map[legacy] ?? "FOUNDRY";
}

/**
 * Return all tiers, ordered lowest → highest, with strategy list.
 * Used by pricing/UI endpoints.
 */
function listTiers() {
  return TIER_ORDER.map((key) => ({
    key,
    ...TIER_CONFIG[key],
  }));
}

module.exports = {
  TIER_CONFIG,
  TIER_ORDER,
  getTierConfig,
  canUseStrategy,
  migrateLegacyTier,
  listTiers,
};
