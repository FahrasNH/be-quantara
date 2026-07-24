"use strict";

const fs = require("fs");
const path = require("path");

const { windowDir } = require("./paths");

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

/**
 * @param {Array<{ symbol: string, pass: boolean }>} cells
 * @param {number} minPassesPerSymbol — e.g. 3 of 5 windows NET≥0
 */
function buildVerdict(cells, minPassesPerSymbol, promoteHint) {
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
    ok: pass >= minPassesPerSymbol,
  }));
  const allSymbolsOk = symbolResults.length > 0 && symbolResults.every((s) => s.ok);
  const gate = promoteHint || "walk-forward gate";
  const verdict = allSymbolsOk && passCount === total
    ? `PROMOTE — all window×symbol cells NET≥0; update ${gate}`
    : allSymbolsOk
      ? `PROMOTE — each symbol passes majority windows; review outliers before ${gate}`
      : `BLOCK — walk-forward gate not cleared; keep dry-run only`;
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

function printVerdict(summary, minPassesPerSymbol) {
  const { passCount, total, symbolResults, verdict } = summary;
  console.log(`\nPass count (NET≥0): ${passCount}/${total}`);
  console.log(`Per-symbol (need ≥${minPassesPerSymbol}/${total / symbolResults.length || 5} windows NET≥0):`);
  for (const s of symbolResults) {
    console.log(`  ${s.symbol}: ${s.pass}/${s.total} ${s.ok ? "✓" : "✗"}`);
  }
  console.log(`\nVerdict: ${verdict}`);
}

function collectSummary(outRoot, windows, symbols, minPassesPerSymbol, promoteHint) {
  const cells = [];
  for (const win of windows) {
    for (const symbol of symbols) {
      const outDir = windowDir(outRoot, win.id, symbol);
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
  return { cells, ...buildVerdict(cells, minPassesPerSymbol, promoteHint) };
}

module.exports = {
  readNetReturn,
  formatNet,
  buildVerdict,
  printSummaryTable,
  printVerdict,
  collectSummary,
};
