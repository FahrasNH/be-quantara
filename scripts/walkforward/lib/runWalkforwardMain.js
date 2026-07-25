#!/usr/bin/env node
"use strict";

/**
 * Generic walk-forward export for any strategyKey × tradeType.
 *
 * Grid policy:
 *   Scalping  → GAP_POLICY_8 × BTCUSDT (override with --symbol)
 *   Intraday  → GAP_POLICY_5 × DEFAULT_SYMBOLS_5
 *   Swing     → GAP_POLICY_5 × DEFAULT_SYMBOLS_5
 *
 * Output: tmp/<prefix>-<type>-walkforward/window-XX[/SYMBOL]/
 */

const fs = require("fs");
const path = require("path");

const { REPO_ROOT } = require("./paths");
const { GAP_POLICY_5, GAP_POLICY_8, filterWindows } = require("./windows");
const { DEFAULT_SYMBOLS_5 } = require("./symbols");
const { parseGridArgs } = require("./parseArgs");
const { runGrid } = require("./runGridExport");
const { collectSummary, printSummaryTable, printVerdict } = require("./summary");
const { requireViaApiCredentials, resolveViaApiToken } = require("./auth");

const OUT_PREFIX = {
  "smart-money-concepts": "smc",
  wyckoff: "wyckoff",
  "volume-spread-analysis": "vsa",
  "trend-following": "tf",
  "market-structure": "ms",
  "auction-market-theory": "amt",
  "mean-reversion": "mr",
  "supply-and-demand": "snd",
  "statistical-arbitrage": "sa",
  "breakout-retest": "br",
  "ict-style-trading": "ict",
  "liquidation-squeeze": "ls",
};

const MIN_PASSES_PER_SYMBOL = 3;

function outPrefix(slug) {
  return OUT_PREFIX[slug] || slug;
}

function resolveGrid(tradeType) {
  if (tradeType === "Scalping") {
    return {
      windows: GAP_POLICY_8,
      defaultSymbols: ["BTCUSDT"],
      label: "8-window BTC Scalping",
    };
  }
  return {
    windows: GAP_POLICY_5,
    defaultSymbols: DEFAULT_SYMBOLS_5,
    label: "5×5 promotion gate",
  };
}

function buildManifest({ win, symbol, strategyKey, tradeType }) {
  return {
    window: win.id,
    start: win.start,
    end: win.end,
    symbol,
    strategy: strategyKey,
    tradeType,
    exportVariant: "full",
    note: "Walk-forward via dataset-expand SSOT (strategyDefaults on BE)",
  };
}

/**
 * @param {{ strategyKey: string, tradeType: string, slug: string }} opts
 */
async function walkforwardMain({ strategyKey, tradeType, slug }) {
  require("dotenv").config({ path: path.join(REPO_ROOT, ".env") });

  const prefix = outPrefix(slug);
  const typeSlug = tradeType.toLowerCase();
  const OUT_ROOT = path.join(REPO_ROOT, `tmp/${prefix}-${typeSlug}-walkforward`);
  const PROMOTE_HINT = `liveTradeTypeGate.js (${strategyKey} ${tradeType})`;
  const grid = resolveGrid(tradeType);

  process.stdout.write(`[walkforward] ${strategyKey} · ${tradeType} export…\n`);

  const { dryRun, useLocal, summaryOnly, windowFilter, symbolFilter } = parseGridArgs();
  const api = process.env.DATASET_EXPAND_API_URL;

  const windows = filterWindows(grid.windows, windowFilter);
  const symbols = symbolFilter ? [symbolFilter] : grid.defaultSymbols;

  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  console.log(`${strategyKey} · ${tradeType} walk-forward`);
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Grid: ${grid.label} · Windows: ${windows.length} · Symbols: ${symbols.join(", ")}`);

  if (summaryOnly) {
    const summary = collectSummary(OUT_ROOT, windows, symbols, MIN_PASSES_PER_SYMBOL, PROMOTE_HINT);
    printSummaryTable(summary.cells, windows, symbols);
    printVerdict(summary, MIN_PASSES_PER_SYMBOL);
    fs.mkdirSync(OUT_ROOT, { recursive: true });
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
    strategyKey,
    tradeType,
    outRoot: OUT_ROOT,
    buildManifest: (ctx) => buildManifest({ ...ctx, strategyKey, tradeType }),
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
    console.log(`\n✅ Dry-run: ${results.length} manifest(s) written → ${OUT_ROOT}`);
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

/** Entry used by per-strategy stub scripts — starts async runner. */
function stubMain(opts) {
  walkforwardMain(opts).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  walkforwardMain,
  stubMain,
  OUT_PREFIX,
  outPrefix,
  resolveGrid,
};
