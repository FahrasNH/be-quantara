#!/usr/bin/env node
"use strict";

/**
 * SMART_MONEY_CONCEPTS · Scalping walk-forward + Research #1/#3.
 *
 * Phase 1: Re-export 8 windows with sequence timing + MFE/MAE columns.
 * Phase 2: Analyze trades.csv for Sequence Quality + Exit Quality.
 *
 * Run:
 *   node scripts/walkforward/smart-money-concepts/scalping-research.js --dry-run
 *   node scripts/walkforward/smart-money-concepts/scalping-research.js --export-only
 *   node scripts/walkforward/smart-money-concepts/scalping-research.js --analyze-only
 *
 * Output: tmp/sprint19-smc-walkforward/window-XX/
 */

process.stdout.write("[walkforward] SMC Scalping research export…\n");

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_8, filterWindows } = require("../lib/windows");
const { parseGridArgs } = require("../lib/parseArgs");
const { runSpawnGrid } = require("../lib/runSpawnExport");
const { analyzeAllWindows, printResearchReports } = require("../lib/researchAnalysis");

const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint19-smc-walkforward");
const SCALPING_SCRIPT = path.join(REPO_ROOT, "scripts/dataset-expand/smart-money-concepts/scalping.js");

function buildManifest({ win }) {
  return {
    window: win.id,
    start: win.start,
    end: win.end,
    strategy: "SMART_MONEY_CONCEPTS",
    tradeType: "Scalping",
    exportVariant: "full",
    newColumns: ["Sweep Age Bars", "MFE", "MAE", "Exit Efficiency", "Conf *"],
  };
}

function main() {
  const { dryRun, exportOnly, analyzeOnly, windowFilter } = parseGridArgs();
  const windows = filterWindows(GAP_POLICY_8, windowFilter);

  console.log("SMC walk-forward + Research #1/#3");
  console.log(`Output: ${OUT_ROOT}`);

  if (!analyzeOnly) {
    if (!dryRun && !process.env.DATASET_EXPAND_API_URL) {
      console.error("Missing DATASET_EXPAND_API_URL — use --dry-run or set credentials in .env");
      process.exit(1);
    }
    for (const w of windows) {
      const [r] = runSpawnGrid({
        windows: [w],
        datasetExpandScript: SCALPING_SCRIPT,
        outRoot: OUT_ROOT,
        buildManifest,
        dryRun,
      });
      if (!r.ok) process.exit(1);
    }
  }

  if (!exportOnly || analyzeOnly) {
    const reports = analyzeAllWindows(OUT_ROOT, windows);
    const outPath = path.join(OUT_ROOT, "research-analysis.json");
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), reports }, null, 2));
    console.log(`\nResearch analysis → ${outPath}`);
    printResearchReports(reports);
  }
}

main();
