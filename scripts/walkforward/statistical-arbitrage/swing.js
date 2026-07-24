#!/usr/bin/env node
"use strict";

/**
 * STATISTICAL_ARBITRAGE · Swing walk-forward export.
 *
 * 5-window × 5-coin grid — Gelombang 1+2 SSOT (entryZ 2.0, mean exit, HTF gate).
 *
 * Run:
 *   node scripts/walkforward/statistical-arbitrage/swing.js
 *   node scripts/walkforward/statistical-arbitrage/swing.js --dry-run
 *   node scripts/walkforward/statistical-arbitrage/swing.js --local
 *   node scripts/walkforward/statistical-arbitrage/swing.js --window 3 --symbol ETHUSDT
 *
 * Output: tmp/sprint20-sa-swing-walkforward/window-XX/SYMBOL/
 */

process.stdout.write("[walkforward] SA Swing export…\n");

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../../.env") });

const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_5, filterWindows } = require("../lib/windows");
const { DEFAULT_SYMBOLS_5 } = require("../lib/symbols");
const { parseGridArgs } = require("../lib/parseArgs");
const { runGrid } = require("../lib/runGridExport");
const { requireViaApiCredentials, resolveViaApiToken } = require("../lib/auth");

const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint20-sa-swing-walkforward");

function buildManifest({ win, symbol }) {
  return {
    window: win.id,
    start: win.start,
    end: win.end,
    symbol,
    strategy: "STATISTICAL_ARBITRAGE",
    tradeType: "Swing",
    gelombang: {
      mdSaEntryZ: 2.0,
      mdSaEntryZMax: 2.5,
      mdSaZBoostPerUnit: 0,
      mdSaSkipHtfSideways: true,
      mdSaHtfAlignGate: true,
      mdSaUseBenchmarkResidual: true,
      mdSaExitAtMean: true,
      note: "Gelombang 1+2 from strategyDefaults.js SSOT",
    },
    exportVariant: "full",
  };
}

async function main() {
  const { dryRun, useLocal, windowFilter, symbolFilter } = parseGridArgs();
  const api = process.env.DATASET_EXPAND_API_URL;

  console.log("SA Swing Gelombang 1+2 walk-forward re-export");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${GAP_POLICY_5.length} · Symbols: ${DEFAULT_SYMBOLS_5.join(", ")}`);
  console.log("Config: entryZ=2.0, zMax=2.5, HTF gate, BTC-residual, mean exit");

  requireViaApiCredentials({ dryRun, useLocal, api });
  const token = await resolveViaApiToken({ dryRun, useLocal, api });

  const windows = filterWindows(GAP_POLICY_5, windowFilter);
  const symbols = symbolFilter ? [symbolFilter] : DEFAULT_SYMBOLS_5;

  const results = await runGrid({
    windows,
    symbols,
    strategyKey: "STATISTICAL_ARBITRAGE",
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

  console.log(`\n✅ All ${results.length} run(s) complete`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
