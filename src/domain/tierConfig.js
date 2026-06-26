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
    // Cap JUMLAH posisi terbuka serentak LINTAS-AKUN (semua koin/strategi digabung).
    // Field BARU & terpisah dari maxPositions/maxPositionsPerSymbol (yang per-simbol):
    // ini batas account-wide yang ditegakkan di gate buka posisi (fix meter "8/4").
    maxConcurrentPositions: 4,
    // Hard cap jumlah bot (running + configured/stopped) per akun.
    maxActiveBots: 10,
    autoSelector: false,
    aiOptimizer: false,
    supportSLA: null,       // self-service
    capitalRange: { min: 1_000_000, max: 2_000_000 },
    badge: null,
  },

  FORGE: {
    label: "Forge",
    price: 24,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM"],
    maxPositions: 2,
    capitalAllocation: { equal: true },
    maxPositionsPerSymbol: 2,
    // Cap account-wide posisi terbuka serentak (per-tier account open-position cap).
    maxConcurrentPositions: 8,
    maxActiveBots: 25,
    autoSelector: false,
    aiOptimizer: false,
    supportSLA: "48h",
    capitalRange: { min: 2_000_000, max: 5_000_000 },
    badge: "Popular",
  },

  MINT: {
    label: "Mint",
    price: 54,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION"],
    maxPositions: 3,
    capitalAllocation: { equal: true },
    maxPositionsPerSymbol: 3,
    // Cap account-wide posisi terbuka serentak (per-tier account open-position cap).
    maxConcurrentPositions: 12,
    maxActiveBots: 40,
    autoSelector: true,
    aiOptimizer: false,     // static equal-weight allocation
    supportSLA: "24h",
    capitalRange: { min: 10_000_000, max: 15_000_000 },
  },

  VAULT: {
    label: "Vault",
    price: 99,
    strategies: ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION", "BREAKOUT_RETEST"],
    maxPositions: 4,
    // equal: true → 25% per strategi. dynamic (AI optimizer) menyusul di Fase 3.
    capitalAllocation: { equal: true /* dynamic: false */ },
    maxPositionsPerSymbol: 4,   // bukan maxPositions global
    // Cap account-wide posisi terbuka serentak (per-tier account open-position cap).
    maxConcurrentPositions: 16,
    maxActiveBots: 50,
    autoSelector: true,
    // AI optimizer feature flag — disabled until Fase 3
    aiOptimizer: process.env.VAULT_AI_OPTIMIZER_ENABLED === "true",
    supportSLA: "2h",
    capitalRange: { min: 30_000_000, max: null },
    badge: "Premium",
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
 * Cap JUMLAH posisi terbuka serentak LINTAS-AKUN untuk sebuah tier.
 * Sumber kebenaran tunggal gate "per-tier account open-position cap" (fix bug
 * meter Account Risk yang menampilkan "8 / 4" karena cap tak pernah ditegakkan
 * & angka 4 di-hardcode di UI). Tier tak dikenal → fallback aman ke FOUNDRY (4),
 * BUKAN unlimited (backward-compatible & konservatif).
 * @param {string} tier
 * @returns {number}
 */
function getMaxConcurrentPositions(tier) {
  const config = getTierConfig(tier);
  return config?.maxConcurrentPositions ?? TIER_CONFIG.FOUNDRY.maxConcurrentPositions;
}

/**
 * Cap JUMLAH bot aktif (running + configured/stopped) per akun untuk sebuah tier.
 * Tier tak dikenal → fallback aman ke FOUNDRY (10).
 * @param {string} tier
 * @returns {number}
 */
function getMaxActiveBots(tier) {
  const config = getTierConfig(tier);
  return config?.maxActiveBots ?? TIER_CONFIG.FOUNDRY.maxActiveBots;
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
  getMaxConcurrentPositions,
  getMaxActiveBots,
  migrateLegacyTier,
  listTiers,
};
