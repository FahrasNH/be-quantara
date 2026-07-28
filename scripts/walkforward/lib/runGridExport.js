"use strict";

const fs = require("fs");
const path = require("path");

const { main: runDatasetExpand } = require("../../dataset-expand/lib/runDatasetExpand");
const { windowDir } = require("./paths");
const { readNetReturn, formatNet } = require("./summary");

/**
 * Run one window×symbol cell via dataset-expand (direct require — single auth token).
 *
 * @param {object} opts
 * @param {object} opts.win - { id, start, end }
 * @param {string} opts.symbol
 * @param {string} opts.strategyKey
 * @param {string} opts.tradeType
 * @param {string} opts.outRoot
 * @param {(ctx: object) => object} opts.buildManifest
 * @param {boolean} opts.dryRun
 * @param {boolean} opts.useLocal
 * @param {string|null} opts.token
 * @param {string|null} opts.api
 */
async function runWindowSymbol(opts) {
  const {
    win,
    symbol,
    strategyKey,
    tradeType,
    outRoot,
    buildManifest,
    dryRun,
    useLocal,
    token,
    api,
    rsiVariant = null,
  } = opts;

  const outDir = windowDir(outRoot, win.id, symbol);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = buildManifest({ win, symbol, strategyKey, tradeType });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  if (dryRun) {
    console.log(`[dry-run] Would run window ${win.id} ${symbol}: ${win.start} → ${win.end}`);
    return { ok: true, dryRun: true, window: win.id, symbol, outDir };
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
  if (rsiVariant) {
    argv.push("--rsi-variant", rsiVariant);
  }

  try {
    await runDatasetExpand({ strategyKey, tradeType, argv });
    const net = readNetReturn(outDir);
    console.log(`Window ${win.id} ${symbol} complete → ${outDir} (NET ${formatNet(net)})`);
    return { ok: true, window: win.id, symbol, outDir, netReturn: net };
  } catch (err) {
    console.error(`Window ${win.id} ${symbol} failed: ${err.message || err}`);
    return { ok: false, window: win.id, symbol };
  }
}

/**
 * Run full window×symbol grid with optional throttle between via-api jobs.
 */
async function runGrid({
  windows,
  symbols,
  strategyKey,
  tradeType,
  outRoot,
  buildManifest,
  dryRun,
  useLocal,
  token,
  api,
  rsiVariant = null,
  throttleMs = 1500,
}) {
  const results = [];
  for (const win of windows) {
    for (const symbol of symbols) {
      results.push(await runWindowSymbol({
        win,
        symbol,
        strategyKey,
        tradeType,
        outRoot,
        buildManifest,
        dryRun,
        useLocal,
        token,
        api,
        rsiVariant,
      }));
      if (!dryRun && !useLocal && throttleMs > 0) {
        await new Promise((r) => setTimeout(r, throttleMs));
      }
    }
  }
  return results;
}

module.exports = {
  runWindowSymbol,
  runGrid,
};
