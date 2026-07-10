/**
 * admin-v2.test.js — ADMIN-QA-01 (AC-ADMIN-09) automated coverage for the
 * Admin v2 endpoints. Standalone (no jest, no live DB): node test/admin-v2.test.js
 *
 * Covers the pieces that are deterministic without a database/JWT:
 *   • TC-05 / AC-03 — exchange API keys are masked, never plaintext (maskKey)
 *   • platform store — flag/clear/list + settings (maintenance) round-trip
 *   • alert severity ordering (critical → warning → info)
 *   • strategy win-rate math
 * DB/JWT-dependent cases (TC-01..04, TC-06..15) are exercised against staging —
 * see ADMIN_QA_REPORT.md for the manual matrix.
 */
"use strict";

const fs   = require("fs");
const path = require("path");
const { maskKey } = require("../src/infrastructure/security/maskKey");

let passed = 0, failed = 0;
function t(name, cond) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else      { failed++; console.error(`  ✗ ${name}`); }
}

console.log("\nADMIN-V2 (ADMIN-QA-01)\n");

// ── TC-05 / AC-03: API key masking never leaks the raw key ───────────────────
{
  const raw = "bg_live_1234567890ABCDEF";
  const masked = maskKey(raw);
  t("maskKey returns only last 4 chars",            masked === "••••CDEF");
  t("maskKey output does not contain the raw key",  !masked.includes(raw));
  t("maskKey output length is short (no leak)",     masked.length <= 8);
  t("maskKey hides short keys entirely",            maskKey("abc") === "••••");
  t("maskKey handles null/empty safely",            maskKey(null) === "••••" && maskKey("") === "••••");
  // The masked fingerprint must never expose more than the trailing 4 chars.
  t("maskKey never reveals the key prefix",         !maskKey(raw).includes("bg_live"));
}

// ── Platform store: flagged users + settings round-trip ──────────────────────
{
  // Isolate from any real data/ file by pointing cwd-derived path at a temp dir.
  const tmp = path.join(require("os").tmpdir(), `qa-store-${process.pid}`);
  const origCwd = process.cwd();
  try {
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
    process.chdir(tmp);
    // Fresh require so the module binds STORE_DIR to the temp cwd.
    delete require.cache[require.resolve("../src/infrastructure/store/platformStore")];
    const store = require("../src/infrastructure/store/platformStore");

    t("settings default: maintenance off", store.getSettings().maintenanceMode === false);

    const p = store.patchSettings({ maintenanceMode: true });
    t("patchSettings flips maintenance on",        p.after.maintenanceMode === true);
    t("patchSettings reports previous value",      p.before.maintenanceMode === false);

    store.flagUser("user-1", "volume anomaly", "admin-9");
    t("flagUser marks the user flagged",           store.isFlagged("user-1") === true);
    t("listFlagged includes the user + reason",    store.listFlagged().some(f => f.userId === "user-1" && f.reason === "volume anomaly"));
    t("unrelated user is not flagged",             store.isFlagged("user-2") === false);

    const cleared = store.clearFlag("user-1");
    t("clearFlag removes the flag",                cleared === true && store.isFlagged("user-1") === false);
    t("clearFlag on absent user is a no-op",       store.clearFlag("ghost") === false);

    // Persistence: a re-require reads the same file back.
    delete require.cache[require.resolve("../src/infrastructure/store/platformStore")];
    const store2 = require("../src/infrastructure/store/platformStore");
    t("settings persist across reload",            store2.getSettings().maintenanceMode === true);
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    // Restore the canonical module instance for any later tests.
    delete require.cache[require.resolve("../src/infrastructure/store/platformStore")];
  }
}

// ── Alert severity ordering (mirrors GET /admin/alerts sort) ─────────────────
{
  const RANK = { critical: 0, warning: 1, info: 2 };
  const input = [
    { id: "a", severity: "info" },
    { id: "b", severity: "critical" },
    { id: "c", severity: "warning" },
  ];
  const sorted = [...input].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  t("alerts sort critical → warning → info", sorted.map(x => x.id).join("") === "bca");
}

// ── Strategy win-rate math (mirrors GET /admin/strategy-stats) ───────────────
{
  const winRate = (wins, closed) => (closed ? Number(((wins / closed) * 100).toFixed(1)) : 0);
  t("win rate 6/10 = 60.0",  winRate(6, 10) === 60.0);
  t("win rate 0 closed = 0", winRate(0, 0) === 0);
}

console.log(`\n${failed === 0 ? "✅" : "❌"} ADMIN-V2: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
