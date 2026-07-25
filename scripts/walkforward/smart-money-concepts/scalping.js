#!/usr/bin/env node
"use strict";

/**
 * SMART_MONEY_CONCEPTS · Scalping walk-forward export.
 *
 * 8 windows 2020–2026, BTCUSDT, via dataset-expand spawn (1:1 UI Advance).
 *
 * Run from be-bot-trading/ OR scripts/walkforward/:
 *   node scripts/walkforward/smart-money-concepts/scalping.js
 *   node scripts/walkforward/smart-money-concepts/scalping.js --dry-run
 *   node scripts/walkforward/smart-money-concepts/scalping.js --window 3
 *
 * Output: tmp/sprint18-smc-walkforward/window-XX/
 */

process.stdout.write("[walkforward] SMC Scalping export…\n");

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_8_WITH_FORMAT, filterWindows } = require("../lib/windows");
const { parseGridArgs } = require("../lib/parseArgs");
const { runSpawnGrid } = require("../lib/runSpawnExport");
const { requireViaApiCredentials } = require("../lib/auth");

const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint18-smc-walkforward");
const SCALPING_SCRIPT = path.join(REPO_ROOT, "scripts/dataset-expand/smart-money-concepts/scalping.js");

function buildManifest({ win }) {
  return {
    window: win.id,
    start: win.start,
    end: win.end,
    format: win.format,
    strategy: "SMART_MONEY_CONCEPTS",
    tradeType: "Scalping",
    config: {
      asiaSessionBlock: false,
      atrPctFloor: 0.287,
      plannedRR: 2.0,
      // TIME_STOP OFF — no maxHoldHours
    },
    exportVariant: "full",
    note: "Gap 2021-12 → 2022-10 (bear crash) intentionally excluded from walk-forward set",
  };
}

function main() {
  const { dryRun, windowFilter } = parseGridArgs();
  const api = process.env.DATASET_EXPAND_API_URL;

  console.log("SMC Scalping walk-forward re-export");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${GAP_POLICY_8_WITH_FORMAT.length} (2020–2026, current Scalping config)`);

  requireViaApiCredentials({ dryRun, useLocal: false, api });

  const windows = filterWindows(GAP_POLICY_8_WITH_FORMAT, windowFilter);
  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  const results = runSpawnGrid({
    windows,
    datasetExpandScript: SCALPING_SCRIPT,
    outRoot: OUT_ROOT,
    buildManifest,
    dryRun,
  });

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(
    path.join(OUT_ROOT, "run-summary.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), dryRun, results }, null, 2),
  );

  if (failed.length) {
    console.error(`\n${failed.length} window(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ Walk-forward export batch complete");
  console.log("See docs/SMC_SCALPING_WALKFORWARD_EXPORT.md for Full ML column export steps.");
}

main();
