"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { REPO_ROOT, windowDir } = require("./paths");

/**
 * Spawn dataset-expand trade-type script per window (spawn pattern).
 *
 * @param {object} opts
 * @param {object} opts.win
 * @param {string} opts.datasetExpandScript - absolute path to scalping.js etc.
 * @param {string} opts.outRoot
 * @param {(ctx: object) => object} opts.buildManifest
 * @param {string[]} [opts.symbols]
 * @param {boolean} opts.dryRun
 */
function runSpawnWindow(opts) {
  const {
    win,
    datasetExpandScript,
    outRoot,
    buildManifest,
    symbols = ["BTCUSDT"],
    dryRun,
  } = opts;

  const outDir = windowDir(outRoot, win.id);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = buildManifest({ win, symbols });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (dryRun) {
    console.log(`[dry-run] Would run window ${win.id}: ${win.start} → ${win.end} → ${outDir}`);
    return { ok: true, dryRun: true, window: win.id, outDir };
  }

  const args = [
    datasetExpandScript,
    "--via-api",
    "--symbols", symbols.join(","),
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
  if (win.format === "xlsx") {
    console.log('  Export Full ML via UI/API: POST /api/v1/backtest/export-csv { variant: "full", format: "xlsx" }');
  }
  return { ok: true, window: win.id, outDir };
}

function runSpawnGrid({ windows, datasetExpandScript, outRoot, buildManifest, symbols, dryRun }) {
  return windows.map((win) => runSpawnWindow({
    win,
    datasetExpandScript,
    outRoot,
    buildManifest,
    symbols,
    dryRun,
  }));
}

module.exports = {
  runSpawnWindow,
  runSpawnGrid,
};
