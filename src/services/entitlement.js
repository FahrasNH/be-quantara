// ─────────────────────────────────────────────
// entitlement.js — Tier Entitlement Service
//
// Single place for all tier-based access checks.
// Import canUseStrategy() wherever strategy access must be verified.
// ─────────────────────────────────────────────

const { canUseStrategy, getTierConfig, migrateLegacyTier } = require("../domain/tierConfig");
// Sumber kebenaran strategi yang belum boleh live (single source of truth).
const { DRY_RUN_ONLY_STRATEGIES } = require("../middleware/strategyGuard");

// PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js
const prisma = require("../infrastructure/db/prismaClient");

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
  // Sprint 5 (PAY-07): an active, non-expired Subscription is the authoritative
  // tier. The legacy UserStrategy.tier is kept in sync by PaymentService on
  // grant, but the Subscription is the source of truth (and carries expiry).
  const activeSub = await getActiveSubscription(userId);
  if (activeSub) return activeSub.tier;

  // Once a user has entered the paid system (any Subscription row), it is
  // authoritative: no active sub → they drop to the free base tier. This makes
  // expiry/cancellation actually revoke access (PAY-07) instead of leaving the
  // synced legacy UserStrategy.tier granting the old paid tier forever.
  const hadSub = await prisma.subscription.count({ where: { userId } });
  if (hadSub > 0) return "FOUNDRY";

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
  if (strategyKey === "GROK_AI_TRADING") {
    const GrokTradingService = require("../server/services/GrokTradingService");
    const access = await GrokTradingService.canUseGrokTrading(userId);
    if (!access.allowed) {
      throw {
        status: 403,
        body: {
          ok: false,
          statusCode: 403,
          message: access.reason || "Grok Live Trading tidak tersedia untuk tier kamu.",
          tier: access.tier ?? null,
          requiredTier: "VAULT",
        },
      };
    }
    return getUserTier(userId);
  }

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

  // Grok AI Trading — tier gate terpisah (VAULT / open mode)
  const grokExtras = [];
  try {
    const GrokTradingService = require("../server/services/GrokTradingService");
    const access = await GrokTradingService.canUseGrokTrading(userId);
    if (access.allowed) grokExtras.push("GROK_AI_TRADING");
    else if (!locked.find(l => l.key === "GROK_AI_TRADING")) {
      locked.push({ key: "GROK_AI_TRADING", requiredTier: "VAULT" });
    }
  } catch { /* ignore */ }

  const allowedWithGrok = [...allowed, ...grokExtras.filter(k => !allowed.includes(k))];

  return { tier, allowed: allowedWithGrok, locked };
}

/**
 * Grok Confirm Gate otomatis untuk live bot bila server siap + user berhak (Vault / open mode).
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function shouldAutoEnableGrokConfirm(userId) {
  try {
    const GrokConfirmService = require("../server/services/GrokConfirmService");
    if (!GrokConfirmService.isEnabled()) return false;
    const access = await GrokConfirmService.canUseGrokConfirm(userId, { backtest: false });
    return access.allowed === true;
  } catch {
    return false;
  }
}

/**
 * Status Grok Confirm untuk UI bot (auto-include Vault, ketersediaan server).
 * @param {string} userId
 */
async function getGrokConfirmEntitlement(userId) {
  try {
    const GrokConfirmService = require("../server/services/GrokConfirmService");
    const available = GrokConfirmService.isEnabled();
    const included = available ? await shouldAutoEnableGrokConfirm(userId) : false;
    return { grokConfirmAvailable: available, grokConfirmIncluded: included };
  } catch {
    return { grokConfirmAvailable: false, grokConfirmIncluded: false };
  }
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

/**
 * Return the user's currently-active subscription, or null. "Active" =
 * status ACTIVE && endDate in the future. Lazily expires a stale ACTIVE row it
 * encounters (defensive — a cron could also do this) so entitlement never
 * over-grants past endDate.
 *
 * @param {string} userId
 * @returns {Promise<{ id, tier, status, billingCycle, startDate, endDate }|null>}
 */
async function getActiveSubscription(userId) {
  const sub = await prisma.subscription.findFirst({
    where:   { userId, status: "ACTIVE" },
    orderBy: { endDate: "desc" },
    select:  { id: true, tier: true, status: true, billingCycle: true, startDate: true, endDate: true },
  });
  if (!sub) return null;

  if (sub.endDate && new Date(sub.endDate).getTime() <= Date.now()) {
    // Expired but not yet swept — flip it and treat as no active sub.
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "EXPIRED" } }).catch(() => {});
    return null;
  }
  return sub;
}

module.exports = {
  getUserTier,
  getActiveSubscription,
  assertStrategyAllowed,
  getStrategyEntitlements,
  getTierStrategies,
  isStrategyLiveReady,
  filterStrategiesByMode,
  shouldAutoEnableGrokConfirm,
  getGrokConfirmEntitlement,
};
