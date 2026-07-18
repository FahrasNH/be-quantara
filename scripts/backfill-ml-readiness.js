#!/usr/bin/env node
/**
 * backfill-ml-readiness.js — Sprint 16 / ML Data Readiness Phase 1
 *
 * Backfills pair_tier, signal_delay_ms, winning_component on recent trades.
 * HOD/liquidation context cannot be reconstructed — only forward-filled going forward.
 *
 * Usage:
 *   node scripts/backfill-ml-readiness.js [--days=30] [--dry-run]
 */

"use strict";

const db = require("../src/infrastructure/db/database");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const DAYS = parseInt(args.days ?? "30", 10);
const DRY_RUN = args["dry-run"] === true || args["dry-run"] === "true";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   ML Readiness Backfill (Sprint 16 / Phase 1)   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Days: ${DAYS}  Dry-run: ${DRY_RUN}\n`);

  if (DRY_RUN) {
    console.log("  [DRY RUN] — no writes; run without --dry-run to apply");
    return;
  }

  await db.init();
  const result = await db.backfillMlReadinessFields({ days: DAYS });
  console.log(`\n  Scanned: ${result.scanned}  Updated: ${result.updated}`);
  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[backfill-ml-readiness] Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { main };
