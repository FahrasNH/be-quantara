// ─── src/infrastructure/store/platformStore.js ──────────────────────────────
// Lightweight, file-backed key/value store for platform-level admin state that
// does NOT warrant a Prisma model + migration (the schema has no Settings model
// and `migrate dev` is brittle here — see shadow-DB note in project memory).
//
// Holds two things, both surfaced by the Admin v2 endpoints (ADMIN-BE-08):
//   • maintenanceMode + featureFlags   → GET/PATCH /admin/settings (FE-11)
//   • flaggedUsers                     → GET /admin/users?status=Flagged (FE-05)
//
// Reads are cached in memory; writes are flushed synchronously to disk so state
// survives a process restart. This is intentionally simple — single-process,
// low-write admin config, not a hot path.
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

const STORE_DIR  = path.join(process.cwd(), "data");
const STORE_FILE = path.join(STORE_DIR, "platform-store.json");

const DEFAULTS = {
  maintenanceMode: false,
  // Free-form feature flags toggled from the admin Settings page. Env-derived
  // flags (ALLOWED_TIERS/ALLOWED_EXCHANGES) are read-only and surfaced
  // separately by the route — they are NOT stored here.
  featureFlags: {},
  // { [userId]: { reason, flaggedAt, flaggedBy } }
  flaggedUsers: {},
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function persist() {
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn("[platformStore] persist failed:", err.message);
  }
}

// ── Settings (maintenance + feature flags) ──────────────────────────────────
function getSettings() {
  const s = load();
  return { maintenanceMode: !!s.maintenanceMode, featureFlags: { ...s.featureFlags } };
}

/** Patch settings; returns { before, after } for audit logging. Only known keys. */
function patchSettings(patch = {}) {
  const s = load();
  const before = getSettings();
  if (typeof patch.maintenanceMode === "boolean") s.maintenanceMode = patch.maintenanceMode;
  if (patch.featureFlags && typeof patch.featureFlags === "object") {
    s.featureFlags = { ...s.featureFlags, ...patch.featureFlags };
  }
  persist();
  return { before, after: getSettings() };
}

// ── Flagged users ───────────────────────────────────────────────────────────
function listFlagged() {
  const s = load();
  return Object.entries(s.flaggedUsers).map(([userId, meta]) => ({ userId, ...meta }));
}

function isFlagged(userId) {
  return !!load().flaggedUsers[userId];
}

function flagUser(userId, reason, flaggedBy) {
  const s = load();
  s.flaggedUsers[userId] = {
    reason:    reason || "Manual review",
    flaggedAt: new Date().toISOString(),
    flaggedBy: flaggedBy || null,
  };
  persist();
  return s.flaggedUsers[userId];
}

function clearFlag(userId) {
  const s = load();
  const existed = !!s.flaggedUsers[userId];
  delete s.flaggedUsers[userId];
  persist();
  return existed;
}

module.exports = {
  getSettings, patchSettings,
  listFlagged, isFlagged, flagUser, clearFlag,
  _file: STORE_FILE, // exposed for tests
};
