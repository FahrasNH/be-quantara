#!/usr/bin/env node
"use strict";

/**
 * SMART_MONEY_CONCEPTS · Swing walk-forward re-validation.
 *
 * 5-window × 5-coin promotion gate via dataset-expand (1:1 UI Advance on dev BE).
 *
 * Run:
 *   node scripts/walkforward/smart-money-concepts/swing.js
 *   node scripts/walkforward/smart-money-concepts/swing.js --dry-run
 *   node scripts/walkforward/smart-money-concepts/swing.js --local
 *   node scripts/walkforward/smart-money-concepts/swing.js --window 3 --symbol ETHUSDT
 *   node scripts/walkforward/smart-money-concepts/swing.js --summary-only
 *
 * Output: tmp/smc-swing-walkforward/window-XX/SYMBOL/
 */

process.stdout.write("[walkforward] SMC Swing export…\n");

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_5, filterWindows } = require("../lib/windows");
const { DEFAULT_SYMBOLS_5 } = require("../lib/symbols");
const { parseGridArgs } = require("../lib/parseArgs");
const { runGrid } = require("../lib/runGridExport");
const { collectSummary, printSummaryTable, printVerdict } = require("../lib/summary");
const { requireViaApiCredentials, resolveViaApiToken } = require("../lib/auth");

const OUT_ROOT = path.join(REPO_ROOT, "tmp/smc-swing-walkforward");
const MIN_PASSES_PER_SYMBOL = 3;
const PROMOTE_HINT = "liveTradeTypeGate.js (SMART_MONEY_CONCEPTS Swing)";

function buildManifest({ win, symbol }) {
  return {
    window: win.id,
    start: win.start,
    end: win.end,
    symbol,
    strategy: "SMART_MONEY_CONCEPTS",
    tradeType: "Swing",
    sprint23: {
      // SSOT: SMC_LEG_TYPE_OVERRIDES.Swing + top-level smcMinConfidenceC/Swing = 60
      smcMinConfidenceSwing: 60,
      smcMinConfidenceC: 60,
      atrMinMult: 0.8,
      slAtrMult: 1.2,
      tpAtrMult: 3.6,
      // Session filter OFF + TIME_STOP OFF (global policy)
      note: "Swing SSOT from strategyDefaults.js — RR ~3.0, conf≥60, session/TIME_STOP OFF",
    },
    exportVariant: "full",
  };
}

async function main() {
  const { dryRun, useLocal, summaryOnly, windowFilter, symbolFilter } = parseGridArgs();
  const api = process.env.DATASET_EXPAND_API_URL;

  const windows = filterWindows(GAP_POLICY_5, windowFilter);
  const symbols = symbolFilter ? [symbolFilter] : DEFAULT_SYMBOLS_5;

  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  console.log("SMC Swing walk-forward re-validation");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${windows.length} · Symbols: ${symbols.join(", ")}`);
  console.log("Config: conf≥60, SL/TP 1.2/3.6, atrMin 0.8, session OFF, TIME_STOP OFF (Swing SSOT)");

  if (summaryOnly) {
    const summary = collectSummary(OUT_ROOT, windows, symbols, MIN_PASSES_PER_SYMBOL, PROMOTE_HINT);
    printSummaryTable(summary.cells, windows, symbols);
    printVerdict(summary, MIN_PASSES_PER_SYMBOL);
    fs.writeFileSync(
      path.join(OUT_ROOT, "walkforward-summary.json"),
      JSON.stringify({ ranAt: new Date().toISOString(), summaryOnly: true, ...summary }, null, 2),
    );
    process.exit(summary.allSymbolsOk ? 0 : 1);
  }

  requireViaApiCredentials({ dryRun, useLocal, api });
  const token = await resolveViaApiToken({ dryRun, useLocal, api });

  const results = await runGrid({
    windows,
    symbols,
    strategyKey: "SMART_MONEY_CONCEPTS",
    tradeType: "Swing",
    outRoot: OUT_ROOT,
    buildManifest,
    dryRun,
    useLocal,
    token,
    api,
  });

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n❌ ${failed.length} run(s) failed`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n✅ Dry-run: ${results.length} manifest(s) written`);
    return;
  }

  const summary = collectSummary(OUT_ROOT, windows, symbols, MIN_PASSES_PER_SYMBOL, PROMOTE_HINT);
  printSummaryTable(summary.cells, windows, symbols);
  printVerdict(summary, MIN_PASSES_PER_SYMBOL);

  fs.writeFileSync(
    path.join(OUT_ROOT, "walkforward-summary.json"),
    JSON.stringify({ ranAt: new Date().toISOString(), dryRun, useLocal, results, ...summary }, null, 2),
  );

  console.log(`\nSummary JSON → ${path.join(OUT_ROOT, "walkforward-summary.json")}`);
  console.log(`\n✅ All ${results.length} run(s) complete`);
  if (!summary.allSymbolsOk) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
