#!/usr/bin/env node
/**
 * migrate-research-dataset.js — Sprint 16 Research Dataset SSOT migration.
 *
 * Parses 6 SMC XLSX windows (1418 trades) → TradeResearchDataset table.
 * Also supports CSV paths (dataset-expand format with ML columns).
 *
 * Usage:
 *   node scripts/migrate-research-dataset.js [--dry-run]
 *   node scripts/migrate-research-dataset.js --files=/path/a.xlsx,/path/b.csv
 *   node scripts/migrate-research-dataset.js --validate
 */

"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const {
  ResearchDatasetService,
  DEFAULT_XLSX_WINDOWS,
} = require("../src/modules/research/services/ResearchDatasetService");
const { ResearchDatasetValidator } = require("../src/modules/research/services/ResearchDatasetValidator");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const DRY_RUN = args["dry-run"] === true || args["dry-run"] === "true";
const VALIDATE_ONLY = args.validate === true || args.validate === "true";
const FILES = args.files
  ? String(args.files).split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_XLSX_WINDOWS;

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   Research Dataset SSOT Migration (Sprint 16)   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Files: ${FILES.length}  Dry-run: ${DRY_RUN}  Validate-only: ${VALIDATE_ONLY}\n`);

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }

  const service = new ResearchDatasetService();
  const validator = new ResearchDatasetValidator();

  if (!VALIDATE_ONLY) {
    const result = await service.migrateFromFiles(FILES, { dryRun: DRY_RUN });
    console.log("\n── Migration ──");
    console.log(JSON.stringify(result, null, 2));
  }

  if (!DRY_RUN) {
    const quality = await service.getDataQualityReport();
    console.log("\n── Data Quality ──");
    console.log(JSON.stringify(quality, null, 2));

    const validation = await validator.runPredictiveValidation({
      strategyKey: "SMART_MONEY_CONCEPTS",
    });
    console.log("\n── Predictive Validation ──");
    console.log(JSON.stringify(validation, null, 2));

    const summary = await service.getSummary({ strategyKey: "SMART_MONEY_CONCEPTS" });
    console.log("\n── Summary ──");
    console.log(JSON.stringify(summary, null, 2));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[migrate-research-dataset] Fatal:", err.message || err);
    process.exit(1);
  });
}

module.exports = { main };
