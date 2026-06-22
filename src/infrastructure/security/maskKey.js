// ─── src/infrastructure/security/maskKey.js ─────────────────────────────────
// SECURITY: derive a non-reversible masked fingerprint from an exchange API key
// for display in the admin console (ADMIN-FE-07 AC-02). The raw key/secret must
// NEVER leave the server — this returns only the last 4 characters, dotted.
// Extracted from the admin router so it can be unit-tested in isolation.
// ─────────────────────────────────────────────────────────────────────────────
function maskKey(k) {
  const s = k ? String(k) : "";
  return s.length <= 4 ? "••••" : `••••${s.slice(-4)}`;
}

module.exports = { maskKey };
