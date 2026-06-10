// ─────────────────────────────────────────────
// entitlement.js — Tier Entitlement Service
//
// Single place for all tier-based access checks.
// Import canUseStrategy() wherever strategy access must be verified.
// ─────────────────────────────────────────────

const { PrismaClient } = require("@prisma/client");
const { canUseStrategy, getTierConfig, migrateLegacyTier } = require("../domain/tierConfig");
// Sumber kebenaran strategi yang belum boleh live (single source of truth).
const { DRY_RUN_ONLY_STRATEGIES } = require("../middleware/strategyGuard");

const prisma = new PrismaClient();

/**
 * Apakah strategi sudah siap untuk LIVE trading (bukan dry-run-only)?
 * Pure function — mengacu ke DRY_RUN_ONLY_STRATEGIES (mis. BREAKOUT_RETEST).
 * @param {string} strategyKey
 * @returns {boolean}
 */
function isStrategyLiveReady(strategyKey) {
  return !DRY_RUN_ONLY_STRATEGIES.has(strategyKey);
}

/**
 * Saring daftar strategi sesuai mode eksekusi.
 * Pure function (mudah di-test) — dipisah dari getTierStrategies yang menyentuh DB.
 * @param {string[]} strategies
 * @param {("dry"|"live")} mode
 * @returns {string[]}
 */
function filterStrategiesByMode(strategies, mode) {
  const list = Array.isArray(strategies) ? strategies : [];
  return mode === "live" ? list.filter(isStrategyLiveReady) : list.slice();
}

/**
 * Fetch user's current tier from DB.
 * Falls back to migrating the legacy balanceTier field if tier is unset.
 * @param {string} userId
 * @returns {Promise<string>} tier key e.g. "FOUNDRY"
 */
async function getUserTier(userId) {
  const record = await prisma.userStrategy.findUnique({
    where:  { userId },
    select: { tier: true, balanceTier: true },
  });

  if (!record) return "FOUNDRY";

  // If tier is already set (non-default), return it
  if (record.tier && record.tier !== "FOUNDRY") return record.tier;

  // Migrate legacy balanceTier on first access
  if (record.balanceTier && record.balanceTier !== "C") {
    const migrated = migrateLegacyTier(record.balanceTier);
    await prisma.userStrategy.update({
      where: { userId },
      data:  { tier: migrated },
    });
    return migrated;
  }

  return record.tier ?? "FOUNDRY";
}

/**
 * Assert that a user's tier allows a given strategy.
 * Throws an object with { status, body } if denied — catch and send as response.
 *
 * @param {string} userId
 * @param {string} strategyKey
 * @throws {{ status: number, body: object }}
 */
async function assertStrategyAllowed(userId, strategyKey) {
  const tier = await getUserTier(userId);
  const result = canUseStrategy(tier, strategyKey);

  if (!result.allowed) {
    const err = {
      status: 403,
      body: {
        ok: false,
        statusCode: 403,
        message: result.requiredTier
          ? `Strategy "${strategyKey}" membutuhkan tier ${result.requiredTier}. Tier kamu sekarang: ${tier}.`
          : `Strategy "${strategyKey}" tidak tersedia.`,
        currentTier:  tier,
        requiredTier: result.requiredTier ?? null,
      },
    };
    throw err;
  }

  return tier;
}

/**
 * Return all strategies for a user's tier, plus locked list (with required tier).
 * Used by /strategies/available endpoint.
 *
 * @param {string} userId
 * @returns {Promise<{ tier: string, allowed: string[], locked: Array<{key, requiredTier}> }>}
 */
async function getStrategyEntitlements(userId) {
  const { TIER_ORDER, TIER_CONFIG } = require("../domain/tierConfig");
  const tier = await getUserTier(userId);
  const config = getTierConfig(tier);

  const allowed = config?.strategies ?? [];

  // Collect all strategies from higher tiers that are locked
  const locked = [];
  for (const t of TIER_ORDER) {
    for (const s of TIER_CONFIG[t].strategies) {
      if (!allowed.includes(s) && !locked.find((l) => l.key === s)) {
        locked.push({ key: s, requiredTier: t });
      }
    }
  }

  return { tier, allowed, locked };
}

/**
 * Daftar strategi yang HARUS dijalankan otomatis untuk user (dari tier-nya).
 * Inti fitur "Auto Multi-Strategy Execution per Coin": user tidak memilih strategi;
 * semua strategi tier dijalankan serentak. Dalam mode "live", strategi yang masih
 * dry-run-only (mis. BREAKOUT_RETEST) di-exclude agar tidak live trade (AC-07).
 *
 * @param {string} userId
 * @param {("dry"|"live")} [mode="dry"]
 * @returns {Promise<string[]>}
 */
async function getTierStrategies(userId, mode = "dry") {
  const tier = await getUserTier(userId);
  const config = getTierConfig(tier);
  return filterStrategiesByMode(config?.strategies ?? [], mode);
}

module.exports = {
  getUserTier,
  assertStrategyAllowed,
  getStrategyEntitlements,
  getTierStrategies,
  isStrategyLiveReady,
  filterStrategiesByMode,
};
