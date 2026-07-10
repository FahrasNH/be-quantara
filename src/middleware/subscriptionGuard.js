// ─── src/middleware/subscriptionGuard.js ────────────────────────────────────
// Subscription / tier-feature gating (Sprint 5 / PAY-07).
//
// Runs AFTER authMiddleware (req.userId set). Resolves the user's CURRENT tier
// via entitlement.getUserTier() — which reads the active Subscription first and
// returns FOUNDRY when a subscription has expired/cancelled — then checks the
// requested feature against domain/tierConfig.
//
// Use as a route guard factory:
//   router.post("/auto-select", authMiddleware, requireFeature("autoSelector"), handler)
//   router.post("/bots",        authMiddleware, requireStrategy(req => req.body.strategyKey), handler)
// ─────────────────────────────────────────────────────────────────────────────

const { getUserTier, getActiveSubscription } = require("../services/entitlement");
const { getTierConfig, canUseStrategy } = require("../domain/tierConfig");

// Boolean feature flags that live directly on the tier config.
const BOOLEAN_FEATURES = ["autoSelector", "aiOptimizer"];

/**
 * Pure tier-feature check. Exposed for unit tests.
 * @param {string} tier
 * @param {string} feature  a boolean flag (autoSelector|aiOptimizer) or a strategy key
 * @returns {{ allowed: boolean, reason?: string, requiredTier?: string|null }}
 */
function checkTierFeature(tier, feature) {
  const config = getTierConfig(tier);
  if (!config) return { allowed: false, reason: "UNKNOWN_TIER" };

  if (BOOLEAN_FEATURES.includes(feature)) {
    return config[feature] === true
      ? { allowed: true }
      : { allowed: false, reason: "FEATURE_NOT_IN_TIER" };
  }

  // Otherwise treat the feature as a strategy key.
  const res = canUseStrategy(tier, feature);
  return res.allowed
    ? { allowed: true }
    : { allowed: false, reason: "STRATEGY_NOT_IN_TIER", requiredTier: res.requiredTier ?? null };
}

/**
 * Async: resolve the user's tier and check a feature. Returns a structured
 * result the middleware turns into a 403.
 * @returns {Promise<{ allowed, tier, reason?, requiredTier? }>}
 */
async function checkUserTierAccess(userId, requiredFeature) {
  const tier = await getUserTier(userId);
  const res = checkTierFeature(tier, requiredFeature);
  return { ...res, tier };
}

function deny(res, { tier, reason, requiredTier }) {
  const messages = {
    UNKNOWN_TIER:        "Tier tidak dikenali.",
    FEATURE_NOT_IN_TIER: "Fitur ini tidak tersedia di tier kamu. Upgrade untuk membukanya.",
    STRATEGY_NOT_IN_TIER: requiredTier
      ? `Strategi ini membutuhkan tier ${requiredTier}. Tier kamu sekarang: ${tier}.`
      : "Strategi ini tidak tersedia di tier kamu.",
    NO_ACTIVE_SUBSCRIPTION: "Kamu belum punya langganan aktif. Silakan berlangganan untuk mengakses fitur ini.",
  };
  return res.status(403).json({
    ok: false,
    statusCode: 403,
    code: reason,
    message: messages[reason] || "Akses ditolak untuk tier kamu.",
    currentTier: tier ?? null,
    requiredTier: requiredTier ?? null,
  });
}

/**
 * Guard factory: require a tier feature (boolean flag or strategy key).
 * `feature` may be a string or a function (req) => string (e.g. read from body).
 */
function requireFeature(feature) {
  return async function featureGuard(req, res, next) {
    try {
      if (!req.userId) return res.status(401).json({ ok: false, statusCode: 401, message: "Unauthorized" });
      const f = typeof feature === "function" ? feature(req) : feature;
      if (!f) return next(); // nothing to check (e.g. multi-strategy auto path)
      const result = await checkUserTierAccess(req.userId, f);
      if (!result.allowed) return deny(res, result);
      req.userTier = result.tier;
      next();
    } catch (err) { next(err); }
  };
}

// Convenience alias for strategy-key gating from a request extractor.
const requireStrategy = (extractor) => requireFeature(extractor);

/**
 * Guard: require ANY active subscription (used where even the base paid tier
 * must be current — e.g. a premium-only endpoint). FOUNDRY base access does not
 * need this; gate specific features with requireFeature instead.
 */
function requireActiveSubscription() {
  return async function activeSubGuard(req, res, next) {
    try {
      if (!req.userId) return res.status(401).json({ ok: false, statusCode: 401, message: "Unauthorized" });
      const sub = await getActiveSubscription(req.userId);
      if (!sub) return deny(res, { tier: "FOUNDRY", reason: "NO_ACTIVE_SUBSCRIPTION" });
      req.activeSubscription = sub;
      next();
    } catch (err) { next(err); }
  };
}

module.exports = {
  checkTierFeature,
  checkUserTierAccess,
  requireFeature,
  requireStrategy,
  requireActiveSubscription,
  BOOLEAN_FEATURES,
};
