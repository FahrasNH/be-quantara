#!/usr/bin/env node
"use strict";

/**
 * VOLUME_SPREAD_ANALYSIS · Intraday walk-forward re-validation.
 *
 * 3-window × BTC (Sprint 23 GO/NO-GO — gross PF > 1.0 per window after fix #1 HTF gate).
 * Same windows as 819-trade root-cause: 2023 / 2024-25 / 2025-26.
 *
 * Run:
 *   node scripts/walkforward/volume-spread-analysis/intraday.js
 *   node scripts/walkforward/volume-spread-analysis/intraday.js --dry-run
 *   node scripts/walkforward/volume-spread-analysis/intraday.js --local
 *   node scripts/walkforward/volume-spread-analysis/intraday.js --window 2 --symbol BTCUSDT
 *   node scripts/walkforward/volume-spread-analysis/intraday.js --summary-only
 *
 * Output: tmp/vsa-intraday-walkforward/window-XX/SYMBOL/
 */

process.stdout.write("[walkforward] VSA Intraday export…\n");

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

const { REPO_ROOT } = require("../lib/paths");
const { VSA_INTRADAY_3, filterWindows } = require("../lib/windows");
const { DEFAULT_SYMBOL_BTC } = require("../lib/symbols");
const { parseGridArgs } = require("../lib/parseArgs");
const { runGrid } = require("../lib/runGridExport");
const { collectSummary, printSummaryTable, printVerdict } = require("../lib/summary");
const { requireViaApiCredentials, resolveViaApiToken } = require("../lib/auth");

const OUT_ROOT = path.join(REPO_ROOT, "tmp/vsa-intraday-walkforward");
const MIN_PASSES_PER_SYMBOL = 3;
const PROMOTE_HINT = "liveTradeTypeGate.js (VOLUME_SPREAD_ANALYSIS Intraday)";

function buildManifest({ win, symbol }) {
  return {
    window: win.id,
    label: win.label,
    start: win.start,
    end: win.end,
    symbol,
    strategy: "VOLUME_SPREAD_ANALYSIS",
    tradeType: "Intraday",
    sprint23: {
      vsaHtfAlignGate: true,
      vsaHtfCounterPenalty: 0.5,
      vsaScalpingShelved: true,
      vsaSessionFilter: false,
      vsaIntradayDetectorMode: "confirmation",
      entryTf: "15m",
      htfTf: "1h",
      goNoGo: "gross PF > 1.0 in all 3 windows (Sprint 23 root-cause gate)",
      note: "Intraday SSOT — session filter OFF",
    },
    exportVariant: "full",
  };
}

async function main() {
  const { dryRun, useLocal, summaryOnly, windowFilter, symbolFilter } = parseGridArgs();
  const api = process.env.DATASET_EXPAND_API_URL;

  const windows = filterWindows(VSA_INTRADAY_3, windowFilter);
  const symbols = symbolFilter ? [symbolFilter] : DEFAULT_SYMBOL_BTC;

  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  console.log("VSA Intraday walk-forward re-validation (Sprint 23)");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${windows.map((w) => `${w.id}(${w.label})`).join(", ")} · Symbols: ${symbols.join(", ")}`);
  console.log("Config: HTF-align gate + session OFF + confirmation-bar detector v2");

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
    strategyKey: "VOLUME_SPREAD_ANALYSIS",
    tradeType: "Intraday",
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
