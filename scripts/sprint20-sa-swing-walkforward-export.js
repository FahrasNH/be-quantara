#!/usr/bin/env node
"use strict";

/**
 * Sprint 20 — STATISTICAL_ARBITRAGE Swing walk-forward re-export (5 windows, 5 koin).
 *
 * Gelombang 1+2 config from strategyDefaults SSOT (entryZ 2.0, z-cap, HTF gate, BTC-residual, mean exit).
 * Runs dataset-expand via dev server API (1:1 with UI Advance) per window × symbol.
 * Single login per run — avoids auth 429 from per-spawn logins.
 *
 * Prerequisites (be-bot-trading/.env):
 *   DATASET_EXPAND_API_URL=https://dev.quantara.software
 *   DATASET_EXPAND_EMAIL=...
 *   DATASET_EXPAND_PASSWORD=...
 *
 * Usage:
 *   node scripts/sprint20-sa-swing-walkforward-export.js
 *   node scripts/sprint20-sa-swing-walkforward-export.js --dry-run
 *   node scripts/sprint20-sa-swing-walkforward-export.js --local
 *   node scripts/sprint20-sa-swing-walkforward-export.js --window 3 --symbol ETHUSDT
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { main: runDatasetExpand } = require("./dataset-expand/lib/runDatasetExpand");
const { loginForToken } = require("./dataset-expand/lib/viaApi");

const REPO_ROOT = path.join(__dirname, "..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint20-sa-swing-walkforward");

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
  const useLocal = process.argv.includes("--local");
  const wIdx = process.argv.indexOf("--window");
  const windowFilter = wIdx !== -1 ? parseInt(process.argv[wIdx + 1], 10) : null;
  const sIdx = process.argv.indexOf("--symbol");
  const symbolFilter = sIdx !== -1 ? process.argv[sIdx + 1] : null;
  return { dryRun, useLocal, windowFilter, symbolFilter };
}

async function runWindowSymbol(win, symbol, { dryRun, useLocal, token, api }) {
  const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`, symbol);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
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
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (dryRun) {
    console.log(`[dry-run] Would run window ${win.id} ${symbol}: ${win.start} → ${win.end}`);
    return { ok: true, dryRun: true };
  }

  console.log(`\n══ Window ${win.id} · ${symbol}: ${win.start} → ${win.end} ══`);

  const argv = [
    "--symbols", symbol,
    "--start", win.start,
    "--end", win.end,
    "--capital", "1000",
    "--exchange", "binance",
    "--out", outDir,
  ];
  if (useLocal) {
    argv.push("--local");
  } else {
    argv.push("--via-api", "--api", api, "--token", token);
  }

  try {
    await runDatasetExpand({
      strategyKey: "STATISTICAL_ARBITRAGE",
      tradeType: "Swing",
      argv,
    });
    console.log(`Window ${win.id} ${symbol} complete → ${outDir}`);
    return { ok: true, window: win.id, symbol, outDir };
  } catch (err) {
    console.error(`Window ${win.id} ${symbol} failed: ${err.message || err}`);
    return { ok: false, window: win.id, symbol };
  }
}

async function main() {
  const { dryRun, useLocal, windowFilter, symbolFilter } = parseArgs();
  const api = process.env.DATASET_EXPAND_API_URL;
  const hasAuth = (process.env.DATASET_EXPAND_EMAIL && process.env.DATASET_EXPAND_PASSWORD)
    || process.env.DATASET_EXPAND_TOKEN;

  console.log("Sprint 20 — SA Swing Gelombang 1+2 walk-forward re-export");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${WINDOWS.length} · Symbols: ${SYMBOLS.join(", ")}`);
  console.log("Config: entryZ=2.0, zMax=2.5, HTF gate, BTC-residual, mean exit");

  if (!dryRun && !useLocal && (!api || !hasAuth)) {
    console.error("\n❌ Missing dev server credentials.");
    console.error("Set in be-bot-trading/.env:");
    console.error("  DATASET_EXPAND_API_URL=https://dev.quantara.software");
    console.error("  DATASET_EXPAND_EMAIL + DATASET_EXPAND_PASSWORD");
    console.error("\nOr run with --local or --dry-run.");
    process.exit(1);
  }

  let token = process.env.DATASET_EXPAND_TOKEN || null;
  if (!dryRun && !useLocal && !token && process.env.DATASET_EXPAND_EMAIL) {
    console.log(`[auth] Single login → ${api}`);
    token = await loginForToken({
      apiBase: api,
      email: process.env.DATASET_EXPAND_EMAIL,
      password: process.env.DATASET_EXPAND_PASSWORD,
      log: console.log,
    });
  }

  const windows = windowFilter
    ? WINDOWS.filter((w) => w.id === windowFilter)
    : WINDOWS;
  const symbols = symbolFilter ? [symbolFilter] : SYMBOLS;

  const results = [];
  for (const win of windows) {
    for (const symbol of symbols) {
      results.push(await runWindowSymbol(win, symbol, { dryRun, useLocal, token, api }));
      if (!dryRun && !useLocal) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

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
