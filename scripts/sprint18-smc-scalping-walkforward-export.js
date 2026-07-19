#!/usr/bin/env node
"use strict";

/**
 * Sprint 18 — SMC 5m Scalping walk-forward re-export (8 windows, 2020–2026).
 *
 * Runs dataset-expand via dev server API (1:1 with UI Advance) for each window,
 * then writes trades.csv + stats.json per window under tmp/sprint18-smc-walkforward/.
 *
 * Prerequisites (be-bot-trading/.env):
 *   DATASET_EXPAND_API_URL=https://dev.quantara.software
 *   DATASET_EXPAND_EMAIL=...
 *   DATASET_EXPAND_PASSWORD=...
 *
 * Usage:
 *   node scripts/sprint18-smc-scalping-walkforward-export.js
 *   node scripts/sprint18-smc-scalping-walkforward-export.js --dry-run
 *   node scripts/sprint18-smc-scalping-walkforward-export.js --window 3
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const REPO_ROOT = path.join(__dirname, "..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint18-smc-walkforward");
const SCALPING_SCRIPT = path.join(__dirname, "dataset-expand/smart-money-concepts/scalping.js");

/** Walk-forward windows — post Sprint 16 config (Asia block, ATR 0.287, RR 2.0, maxHoldHours=2). */
const WINDOWS = [
  { id: 1, start: "2020-01-04", end: "2020-04-04", format: "csv" },
  { id: 2, start: "2020-04-03", end: "2021-02-08", format: "csv" },
  { id: 3, start: "2021-02-06", end: "2021-12-14", format: "csv" },
  { id: 4, start: "2022-10-13", end: "2023-08-18", format: "csv" },
  { id: 5, start: "2023-08-18", end: "2024-05-22", format: "csv" },
  { id: 6, start: "2024-05-20", end: "2025-03-26", format: "csv" },
  { id: 7, start: "2025-03-26", end: "2026-01-28", format: "csv" },
  { id: 8, start: "2026-01-28", end: "2026-07-06", format: "xlsx" },
];

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const wIdx = process.argv.indexOf("--window");
  const windowFilter = wIdx !== -1 ? parseInt(process.argv[wIdx + 1], 10) : null;
  return { dryRun, windowFilter };
}

function runWindow(win, dryRun) {
  const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    window: win.id,
    start: win.start,
    end: win.end,
    format: win.format,
    strategy: "SMART_MONEY_CONCEPTS",
    tradeType: "Scalping",
    config: {
      asiaSessionBlock: true,
      atrPctFloor: 0.287,
      plannedRR: 2.0,
      maxHoldHours: 2,
    },
    exportVariant: "full",
    note: "Gap 2021-12 → 2022-10 (bear crash) intentionally excluded from walk-forward set",
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (dryRun) {
    console.log(`[dry-run] Would run window ${win.id}: ${win.start} → ${win.end} → ${outDir}`);
    return { ok: true, dryRun: true };
  }

  const args = [
    SCALPING_SCRIPT,
    "--via-api",
    "--symbols", "BTCUSDT",
    "--start", win.start,
    "--end", win.end,
    "--capital", "1000",
    "--exchange", "binance",
    "--out", outDir,
  ];

  console.log(`\n══ Window ${win.id}: ${win.start} → ${win.end} ══`);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    console.error(`Window ${win.id} failed (exit ${result.status})`);
    return { ok: false, window: win.id };
  }

  console.log(`Window ${win.id} complete → ${outDir}`);
  console.log(`  Export Full ML CSV via UI/API: POST /api/v1/backtest/export-csv { variant: "full", format: "${win.format === "xlsx" ? "xlsx" : "csv"}" }`);
  return { ok: true, window: win.id, outDir };
}

function main() {
  const { dryRun, windowFilter } = parseArgs();
  const api = process.env.DATASET_EXPAND_API_URL;
  const hasAuth = (process.env.DATASET_EXPAND_EMAIL && process.env.DATASET_EXPAND_PASSWORD)
    || process.env.DATASET_EXPAND_TOKEN;

  console.log("Sprint 18 — SMC Scalping walk-forward re-export");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${WINDOWS.length} (2020–2026, post Sprint 16 config)`);

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

  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  const results = windows.map((w) => runWindow(w, dryRun));
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
