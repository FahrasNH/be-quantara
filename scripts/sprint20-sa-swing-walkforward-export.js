#!/usr/bin/env node
"use strict";

/**
 * Sprint 20 — STATISTICAL_ARBITRAGE Swing walk-forward re-export (5 windows, 5 koin).
 *
 * Gelombang 1 config: mdSaEntryZMax=2.5, mdSaZBoostPerUnit=0 (strategyDefaults SSOT).
 * Runs dataset-expand via dev server API (1:1 with UI Advance) per window × symbol.
 *
 * Prerequisites (be-bot-trading/.env):
 *   DATASET_EXPAND_API_URL=https://dev.quantara.software
 *   DATASET_EXPAND_EMAIL=...
 *   DATASET_EXPAND_PASSWORD=...
 *
 * Usage:
 *   node scripts/sprint20-sa-swing-walkforward-export.js
 *   node scripts/sprint20-sa-swing-walkforward-export.js --dry-run
 *   node scripts/sprint20-sa-swing-walkforward-export.js --window 3 --symbol ETHUSDT
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const REPO_ROOT = path.join(__dirname, "..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint20-sa-swing-walkforward");
const SWING_SCRIPT = path.join(__dirname, "dataset-expand/statistical-arbitrage/swing.js");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"];

/** 5-window walk-forward set (2020–2026), aligned with Sprint 18 gap policy. */
const WINDOWS = [
  { id: 1, start: "2020-01-04", end: "2020-04-04" },
  { id: 2, start: "2020-04-03", end: "2021-02-08" },
  { id: 3, start: "2021-02-06", end: "2021-12-14" },
  { id: 4, start: "2022-10-13", end: "2023-08-18" },
  { id: 5, start: "2023-08-18", end: "2024-05-22" },
];

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const wIdx = process.argv.indexOf("--window");
  const windowFilter = wIdx !== -1 ? parseInt(process.argv[wIdx + 1], 10) : null;
  const sIdx = process.argv.indexOf("--symbol");
  const symbolFilter = sIdx !== -1 ? process.argv[sIdx + 1] : null;
  return { dryRun, windowFilter, symbolFilter };
}

function runWindowSymbol(win, symbol, dryRun) {
  const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`, symbol);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    window: win.id,
    start: win.start,
    end: win.end,
    symbol,
    strategy: "STATISTICAL_ARBITRAGE",
    tradeType: "Swing",
    gelombang1: {
      mdSaEntryZMax: 2.5,
      mdSaZBoostPerUnit: 0,
      note: "Config from strategyDefaults.js SSOT — Gelombang 1",
    },
    exportVariant: "full",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (dryRun) {
    console.log(`[dry-run] Would run window ${win.id} ${symbol}: ${win.start} → ${win.end}`);
    return { ok: true, dryRun: true };
  }

  const args = [
    SWING_SCRIPT,
    "--via-api",
    "--symbols", symbol,
    "--start", win.start,
    "--end", win.end,
    "--capital", "1000",
    "--exchange", "binance",
    "--out", outDir,
  ];

  console.log(`\n══ Window ${win.id} · ${symbol}: ${win.start} → ${win.end} ══`);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(`Window ${win.id} ${symbol} failed (exit ${result.status})`);
    return { ok: false, window: win.id, symbol };
  }

  console.log(`Window ${win.id} ${symbol} complete → ${outDir}`);
  return { ok: true, window: win.id, symbol, outDir };
}

function main() {
  const { dryRun, windowFilter, symbolFilter } = parseArgs();
  const api = process.env.DATASET_EXPAND_API_URL;
  const hasAuth = (process.env.DATASET_EXPAND_EMAIL && process.env.DATASET_EXPAND_PASSWORD)
    || process.env.DATASET_EXPAND_TOKEN;

  console.log("Sprint 20 — SA Swing Gelombang 1 walk-forward re-export");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${WINDOWS.length} · Symbols: ${SYMBOLS.join(", ")}`);
  console.log("Gelombang 1: mdSaEntryZMax=2.5, mdSaZBoostPerUnit=0");

  if (!dryRun && (!api || !hasAuth)) {
    console.error("\n❌ Missing dev server credentials.");
    console.error("Set in be-bot-trading/.env:");
    console.error("  DATASET_EXPAND_API_URL=https://dev.quantara.software");
    console.error("  DATASET_EXPAND_EMAIL + DATASET_EXPAND_PASSWORD");
    console.error("\nOr run with --dry-run to generate manifests only.");
    process.exit(1);
  }

  const windows = windowFilter
    ? WINDOWS.filter((w) => w.id === windowFilter)
    : WINDOWS;
  const symbols = symbolFilter ? [symbolFilter] : SYMBOLS;

  const results = [];
  for (const win of windows) {
    for (const symbol of symbols) {
      results.push(runWindowSymbol(win, symbol, dryRun));
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n❌ ${failed.length} run(s) failed`);
    process.exit(1);
  }

  console.log(`\n✅ All ${results.length} run(s) complete`);
}

main();
