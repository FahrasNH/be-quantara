#!/usr/bin/env node
"use strict";

/**
 * Aggregate TREND_FOLLOWING RSI ablation walk-forward results.
 *
 * Reads tmp/tf-{tier}-walkforward[-rsi-{variant}]/window-XX/SYMBOL/stats.json
 * Baseline variant A uses tmp/tf-{tier}-walkforward (no suffix).
 */

const fs = require("fs");
const path = require("path");
const { REPO_ROOT } = require("../lib/paths");
const { GAP_POLICY_5 } = require("../lib/windows");
const RSI_ABLATION_WINDOWS = GAP_POLICY_5.slice(0, 3);
const { DEFAULT_SYMBOLS_5 } = require("../lib/symbols");
const { rsiVariantOutSuffix } = require("../lib/runWalkforwardMain");

const VARIANTS = ["a", "b", "c"];
const TIERS = ["scalping", "intraday", "swing"];
const VARIANT_LABELS = {
  a: "A baseline 30-70",
  b: "B gate OFF",
  c: "C wide 20-80",
};

function outRoot(tier, variant) {
  const suffix = rsiVariantOutSuffix(variant === "a" ? null : variant);
  return path.join(REPO_ROOT, `tmp/tf-${tier}-walkforward${suffix}`);
}

function readCell(outDir, winId, symbol) {
  const statsPath = path.join(outDir, `window-${String(winId).padStart(2, "0")}`, symbol, "stats.json");
  if (!fs.existsSync(statsPath)) return null;
  try {
    const stats = JSON.parse(fs.readFileSync(statsPath, "utf8"));
    const row = stats.perSymbol?.[0] || {};
    return {
      trades: row.totalTrades ?? stats.totalTrades ?? 0,
      winRate: parseFloat(row.winRate ?? stats.winRate ?? 0) || 0,
      returnPct: parseFloat(row.totalReturn ?? stats.totalReturn ?? 0) || 0,
      profitFactor: parseFloat(row.profitFactor ?? stats.profitFactor ?? 0) || 0,
      passed: row.perTypeStats?.ablation?.passed ?? null,
      rejChecklist: row.perTypeStats?.ablation?.rejChecklist ?? null,
    };
  } catch {
    return null;
  }
}

function aggregateVariant(tier, variant, windows, symbols) {
  const dir = outRoot(tier, variant);
  let totalTrades = 0;
  let totalWins = 0;
  let totalReturn = 0;
  let cells = 0;
  let passedSignals = 0;
  let rejChecklist = 0;
  const missing = [];

  for (const win of windows) {
    for (const symbol of symbols) {
      const cell = readCell(dir, win.id, symbol);
      if (!cell) {
        missing.push(`W${win.id}/${symbol}`);
        continue;
      }
      cells += 1;
      totalTrades += cell.trades;
      totalWins += Math.round((cell.winRate / 100) * cell.trades);
      totalReturn += cell.returnPct;
      if (cell.passed != null) passedSignals += cell.passed;
      if (cell.rejChecklist != null) rejChecklist += cell.rejChecklist;
    }
  }

  return {
    dir,
    cells,
    missing,
    totalTrades,
    winRate: totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0,
    avgReturnPct: cells > 0 ? totalReturn / cells : 0,
    sumReturnPct: totalReturn,
    passedSignals,
    rejChecklist,
  };
}

function printTable(rows) {
  console.log("\n| Tier | Variant | Cells | Trades | Win% | Avg NET%/cell | Σ NET% | Passed | RSI rej |");
  console.log("|------|---------|-------|--------|------|---------------|--------|--------|---------|");
  for (const r of rows) {
    console.log(
      `| ${r.tier} | ${r.variant} | ${r.cells}/${r.expectedCells} | ${r.totalTrades} | `
      + `${r.winRate.toFixed(1)} | ${r.avgReturnPct.toFixed(2)} | ${r.sumReturnPct.toFixed(2)} | `
      + `${r.passedSignals} | ${r.rejChecklist} |`,
    );
    if (r.missing.length) {
      console.log(`|      | missing: ${r.missing.slice(0, 8).join(", ")}${r.missing.length > 8 ? "…" : ""} |`);
    }
  }
}

function pickWinner(rowsByTier) {
  const verdict = {};
  for (const [tier, rows] of Object.entries(rowsByTier)) {
    const complete = rows.filter((r) => r.cells >= r.expectedCells * 0.6);
    if (complete.length < 2) {
      verdict[tier] = "inconclusive (incomplete data)";
      continue;
    }
    const byReturn = [...complete].sort((a, b) => b.sumReturnPct - a.sumReturnPct);
    const best = byReturn[0];
    const second = byReturn[1];
    const margin = best.sumReturnPct - second.sumReturnPct;
    if (margin < 1.0 && Math.abs(best.totalTrades - second.totalTrades) < 5) {
      verdict[tier] = `inconclusive (top ${best.variantLabel} vs ${second.variantLabel}, Δ=${margin.toFixed(2)}%)`;
    } else {
      verdict[tier] = `${best.variantLabel} leads (Σ NET ${best.sumReturnPct.toFixed(2)}%, ${best.totalTrades} trades)`;
    }
  }
  return verdict;
}

function main() {
  const windows = RSI_ABLATION_WINDOWS;
  const allRows = [];
  const rowsByTier = {};

  for (const tier of TIERS) {
    const symbols = tier === "scalping" ? ["BTCUSDT"] : DEFAULT_SYMBOLS_5;
    const expectedCells = windows.length * symbols.length;
    rowsByTier[tier] = [];

    for (const variant of VARIANTS) {
      const agg = aggregateVariant(tier, variant, windows, symbols);
      const row = {
        tier,
        variant: variant.toUpperCase(),
        variantLabel: VARIANT_LABELS[variant],
        expectedCells,
        ...agg,
      };
      allRows.push(row);
      rowsByTier[tier].push(row);
    }
  }

  printTable(allRows);

  const verdict = pickWinner(rowsByTier);
  console.log("\n## Verdict by tier");
  for (const [tier, v] of Object.entries(verdict)) {
    console.log(`- **${tier}**: ${v}`);
  }

  const outPath = path.join(REPO_ROOT, "tmp/tf-rsi-ablation-summary.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    windows: RSI_ABLATION_WINDOWS,
    rows: allRows,
    verdict,
  }, null, 2));
  console.log(`\nSummary JSON → ${outPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { aggregateVariant, main, outRoot };
