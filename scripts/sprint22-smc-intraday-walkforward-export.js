#!/usr/bin/env node
"use strict";

/**
 * Sprint 22 — SMART_MONEY_CONCEPTS Intraday walk-forward re-validation (pre live promotion).
 *
 * Re-runs 5-window × 5-coin grid via dataset-expand (1:1 UI Advance on dev BE).
 * Engine must include Sprint 22 SMC Intraday fixes (commit 0cd068a+):
 *   conf≥80, pivot-structure OB, London session block, CHOP all-sides block.
 *
 * Prerequisites (be-bot-trading/.env):
 *   DATASET_EXPAND_API_URL=https://dev.quantara.software
 *   DATASET_EXPAND_EMAIL=...
 *   DATASET_EXPAND_PASSWORD=...
 *
 * Usage:
 *   node scripts/sprint22-smc-intraday-walkforward-export.js
 *   node scripts/sprint22-smc-intraday-walkforward-export.js --dry-run
 *   node scripts/sprint22-smc-intraday-walkforward-export.js --local
 *   node scripts/sprint22-smc-intraday-walkforward-export.js --window 3 --symbol ETHUSDT
 *   node scripts/sprint22-smc-intraday-walkforward-export.js --summary-only
 *
 * Output: tmp/sprint22-smc-intraday-walkforward/window-XX/SYMBOL/
 *   manifest.json · trades.csv · stats.json · walkforward-summary.json
 *
 * Network notes:
 *   Default = via-api (dev server). Use --local only when this machine reaches Binance.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { main: runDatasetExpand } = require("./dataset-expand/lib/runDatasetExpand");
const { loginForToken } = require("./dataset-expand/lib/viaApi");

const REPO_ROOT = path.join(__dirname, "..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint22-smc-intraday-walkforward");

/** Allowlist — ≥2 required; full 5-coin grid for promotion review. */
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT"];

/**
 * 5-window walk-forward set (2020–2024), aligned with Sprint 18/20 gap policy.
 * Gap 2021-12 → 2022-10 (bear crash) intentionally excluded.
 */
const WINDOWS = [
  { id: 1, start: "2020-01-04", end: "2020-04-04" },
  { id: 2, start: "2020-04-03", end: "2021-02-08" },
  { id: 3, start: "2021-02-06", end: "2021-12-14" },
  { id: 4, start: "2022-10-13", end: "2023-08-18" },
  { id: 5, start: "2023-08-18", end: "2024-05-22" },
];

/** Per-symbol: pass when ≥ this many windows have NET% ≥ 0 (majority of 5). */
const MIN_PASSES_PER_SYMBOL = 3;

function parseArgs() {
  const dryRun = process.argv.includes("--dry-run");
  const useLocal = process.argv.includes("--local");
  const summaryOnly = process.argv.includes("--summary-only");
  const wIdx = process.argv.indexOf("--window");
  const windowFilter = wIdx !== -1 ? parseInt(process.argv[wIdx + 1], 10) : null;
  const sIdx = process.argv.indexOf("--symbol");
  const symbolFilter = sIdx !== -1 ? process.argv[sIdx + 1] : null;
  return { dryRun, useLocal, summaryOnly, windowFilter, symbolFilter };
}

function readNetReturn(outDir) {
  const statsPath = path.join(outDir, "stats.json");
  if (!fs.existsSync(statsPath)) return null;
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    const row = stats.perSymbol?.[0];
    const net = row?.totalReturn ?? stats.totalReturn;
    const n = Number(net);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function formatNet(net) {
  if (net == null) return "n/a";
  const sign = net >= 0 ? "+" : "";
  return `${sign}${net.toFixed(2)}%`;
}

function buildVerdict(cells) {
  const total = cells.length;
  const passCount = cells.filter((c) => c.pass).length;
  const bySymbol = {};
  for (const c of cells) {
    if (!bySymbol[c.symbol]) bySymbol[c.symbol] = { pass: 0, total: 0 };
    bySymbol[c.symbol].total += 1;
    if (c.pass) bySymbol[c.symbol].pass += 1;
  }
  const symbolResults = Object.entries(bySymbol).map(([symbol, { pass, total: t }]) => ({
    symbol,
    pass,
    total: t,
    ok: pass >= MIN_PASSES_PER_SYMBOL,
  }));
  const allSymbolsOk = symbolResults.length > 0 && symbolResults.every((s) => s.ok);
  const verdict = allSymbolsOk && passCount === total
    ? "PROMOTE — all window×symbol cells NET≥0; update liveTradeTypeGate.js"
    : allSymbolsOk
      ? "PROMOTE — each symbol passes majority windows; review outliers before liveTradeTypeGate.js"
      : "BLOCK — walk-forward gate not cleared; keep SMART_MONEY_CONCEPTS dry-run only";
  return { passCount, total, symbolResults, verdict, allSymbolsOk };
}

function printSummaryTable(cells, windows, symbols) {
  const colW = 11;
  const hdr = `${"Window".padEnd(8)} | ${symbols.map((s) => s.replace("USDT", "").padStart(colW)).join(" | ")}`;
  console.log("\n══ WALK-FORWARD SUMMARY (NET%) ══");
  console.log(hdr);
  console.log("-".repeat(hdr.length));
  for (const win of windows) {
    const rowCells = symbols.map((sym) => {
      const cell = cells.find((c) => c.window === win.id && c.symbol === sym);
      return formatNet(cell?.netReturn ?? null).padStart(colW);
    });
    console.log(`W${String(win.id).padStart(2, "0")}     | ${rowCells.join(" | ")}`);
  }
}

function printVerdict(summary) {
  const { passCount, total, symbolResults, verdict } = summary;
  console.log(`\nPass count (NET≥0): ${passCount}/${total}`);
  console.log("Per-symbol (need ≥3/5 windows NET≥0):");
  for (const s of symbolResults) {
    console.log(`  ${s.symbol}: ${s.pass}/${s.total} ${s.ok ? "✓" : "✗"}`);
  }
  console.log(`\nVerdict: ${verdict}`);
}

function collectSummary(windows, symbols) {
  const cells = [];
  for (const win of windows) {
    for (const symbol of symbols) {
      const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`, symbol);
      const netReturn = readNetReturn(outDir);
      cells.push({
        window: win.id,
        start: win.start,
        end: win.end,
        symbol,
        outDir,
        netReturn,
        pass: netReturn != null && netReturn >= 0,
      });
    }
  }
  return { cells, ...buildVerdict(cells) };
}

async function runWindowSymbol(win, symbol, { dryRun, useLocal, token, api }) {
  const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`, symbol);
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = {
    window: win.id,
    start: win.start,
    end: win.end,
    symbol,
    strategy: "SMART_MONEY_CONCEPTS",
    tradeType: "Intraday",
    sprint22: {
      smcMinConfidenceIntraday: 80,
      smcPivotStructure: true,
      slAtrMult: 1.8,
      tpAtrMult: 3.6,
      smcSessionFilter: true,
      noTradeSessions: ["London"],
      smcBlockAllInChop: true,
      note: "Sprint 22 Intraday SSOT from strategyDefaults.js — engine 0cd068a+",
    },
    exportVariant: "full",
  };
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

  try {
    await runDatasetExpand({
      strategyKey: "SMART_MONEY_CONCEPTS",
      tradeType: "Intraday",
      argv,
    });
    const net = readNetReturn(outDir);
    console.log(`Window ${win.id} ${symbol} complete → ${outDir} (NET ${formatNet(net)})`);
    return { ok: true, window: win.id, symbol, outDir, netReturn: net };
  } catch (err) {
    console.error(`Window ${win.id} ${symbol} failed: ${err.message || err}`);
    return { ok: false, window: win.id, symbol };
  }
}

async function main() {
  const { dryRun, useLocal, summaryOnly, windowFilter, symbolFilter } = parseArgs();
  const api = process.env.DATASET_EXPAND_API_URL;
  const hasAuth = (process.env.DATASET_EXPAND_EMAIL && process.env.DATASET_EXPAND_PASSWORD)
    || process.env.DATASET_EXPAND_TOKEN;

  const windows = windowFilter
    ? WINDOWS.filter((w) => w.id === windowFilter)
    : WINDOWS;
  const symbols = symbolFilter ? [symbolFilter] : SYMBOLS;

  if (!windows.length) {
    console.error(`Unknown window: ${windowFilter}`);
    process.exit(1);
  }

  console.log("Sprint 22 — SMC Intraday walk-forward re-validation");
  console.log(`Output: ${OUT_ROOT}`);
  console.log(`Windows: ${windows.length} · Symbols: ${symbols.join(", ")}`);
  console.log("Config: conf≥80, pivot OB, London block, CHOP block (Sprint 22 SSOT)");

  if (summaryOnly) {
    const summary = collectSummary(windows, symbols);
    printSummaryTable(summary.cells, windows, symbols);
    printVerdict(summary);
    fs.writeFileSync(
      path.join(OUT_ROOT, "walkforward-summary.json"),
      JSON.stringify({ ranAt: new Date().toISOString(), summaryOnly: true, ...summary }, null, 2),
    );
    process.exit(summary.allSymbolsOk ? 0 : 1);
  }

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

  if (dryRun) {
    console.log(`\n✅ Dry-run: ${results.length} manifest(s) written`);
    return;
  }

  const summary = collectSummary(windows, symbols);
  printSummaryTable(summary.cells, windows, symbols);
  printVerdict(summary);

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
