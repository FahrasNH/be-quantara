#!/usr/bin/env node
"use strict";

/**
 * Sprint 19 — SMC 5m walk-forward re-export + Research #1/#3 analysis.
 *
 * Phase 1: Re-run 8 windows (2020–2026) with Sprint 19 columns
 *   (sequence timing + measured MFE/MAE + Conf* passthrough).
 * Phase 2: Analyze exported Full CSVs for Sequence Quality + Exit Quality.
 *
 * Prerequisites (be-bot-trading/.env):
 *   DATASET_EXPAND_API_URL=https://dev.quantara.software
 *   DATASET_EXPAND_EMAIL=...
 *   DATASET_EXPAND_PASSWORD=...
 *
 * Usage:
 *   node scripts/sprint19-smc-walkforward-research.js --dry-run
 *   node scripts/sprint19-smc-walkforward-research.js --export-only
 *   node scripts/sprint19-smc-walkforward-research.js --analyze-only
 *   node scripts/sprint19-smc-walkforward-research.js --window 8
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../.env") });

const REPO_ROOT = path.join(__dirname, "..");
const OUT_ROOT = path.join(REPO_ROOT, "tmp/sprint19-smc-walkforward");
const SCALPING_SCRIPT = path.join(__dirname, "dataset-expand/smart-money-concepts/scalping.js");

const WINDOWS = [
  { id: 1, start: "2020-01-04", end: "2020-04-04" },
  { id: 2, start: "2020-04-03", end: "2021-02-08" },
  { id: 3, start: "2021-02-06", end: "2021-12-14" },
  { id: 4, start: "2022-10-13", end: "2023-08-18" },
  { id: 5, start: "2023-08-18", end: "2024-05-22" },
  { id: 6, start: "2024-05-20", end: "2025-03-26" },
  { id: 7, start: "2025-03-26", end: "2026-01-28" },
  { id: 8, start: "2026-01-28", end: "2026-07-06" },
];

function parseArgs() {
  return {
    dryRun: process.argv.includes("--dry-run"),
    exportOnly: process.argv.includes("--export-only"),
    analyzeOnly: process.argv.includes("--analyze-only"),
    windowFilter: (() => {
      const i = process.argv.indexOf("--window");
      return i !== -1 ? parseInt(process.argv[i + 1], 10) : null;
    })(),
  };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function loadCsv(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return { headers: [], rows: [] };
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((ln) => {
    const vals = parseCsvLine(ln);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function analyzeWindow(winDir) {
  const csvPath = path.join(winDir, "trades.csv");
  const data = loadCsv(csvPath);
  if (!data) return { ok: false, reason: "missing trades.csv" };

  const { headers, rows } = data;
  const closed = rows.filter((r) => r.Result === "win" || r.Result === "loss");
  const confCols = ["Conf Sweep", "Conf FVG", "Conf Disp %", "Conf HTF Align", "Conf Mitigation", "Conf OB Confluence"];
  const seqCols = ["Sweep Age Bars", "Sweep To CHoCH Bars", "CHoCH To Entry Bars"];
  const exitCols = ["MFE", "MAE", "MFE %", "MAE %", "Exit Efficiency"];

  const colFill = (cols) => cols.map((c) => ({
    col: c,
    present: headers.includes(c),
    filled: closed.filter((r) => r[c] != null && r[c] !== "" && r[c] !== "N/A").length,
  }));

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const sweepAges = closed.map((r) => num(r["Sweep Age Bars"])).filter((n) => n != null);
  const exitEff = closed.map((r) => num(r["Exit Efficiency"])).filter((n) => n != null);
  const mfePct = closed.map((r) => num(r["MFE %"])).filter((n) => n != null);
  const maePct = closed.map((r) => num(r["MAE %"])).filter((n) => n != null);
  const wins = closed.filter((r) => r.Result === "win").length;

  return {
    ok: true,
    trades: closed.length,
    winRate: closed.length ? wins / closed.length : 0,
    research1_sequence: {
      columns: colFill(seqCols),
      avgSweepAgeBars: avg(sweepAges),
      avgSweepToChoch: avg(closed.map((r) => num(r["Sweep To CHoCH Bars"])).filter(Boolean)),
      avgChochToEntry: avg(closed.map((r) => num(r["CHoCH To Entry Bars"])).filter(Boolean)),
    },
    research3_exit: {
      columns: colFill(exitCols),
      avgMfePercent: avg(mfePct),
      avgMaePercent: avg(maePct),
      avgExitEfficiency: avg(exitEff),
      pctMeasuredMfe: closed.length
        ? closed.filter((r) => num(r.MFE) != null).length / closed.length
        : 0,
    },
    confColumns: colFill(confCols),
  };
}

function runWindow(win, dryRun) {
  const outDir = path.join(OUT_ROOT, `window-${String(win.id).padStart(2, "0")}`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({
    window: win.id,
    start: win.start,
    end: win.end,
    sprint: 19,
    exportVariant: "full",
    newColumns: ["Sweep Age Bars", "MFE", "MAE", "Exit Efficiency", "Conf *"],
  }, null, 2));

  if (dryRun) {
    console.log(`[dry-run] window ${win.id}: ${win.start} → ${win.end}`);
    return { ok: true, dryRun: true };
  }

  const args = [
    SCALPING_SCRIPT, "--via-api",
    "--symbols", "BTCUSDT",
    "--start", win.start, "--end", win.end,
    "--capital", "1000", "--exchange", "binance",
    "--out", outDir,
  ];
  console.log(`\n══ Export window ${win.id}: ${win.start} → ${win.end} ══`);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
  return { ok: result.status === 0, window: win.id, outDir };
}

function main() {
  const { dryRun, exportOnly, analyzeOnly, windowFilter } = parseArgs();
  const windows = windowFilter ? WINDOWS.filter((w) => w.id === windowFilter) : WINDOWS;

  console.log("Sprint 19 — SMC walk-forward + Research #1/#3");
  console.log(`Output: ${OUT_ROOT}`);

  if (!analyzeOnly) {
    if (!dryRun && !process.env.DATASET_EXPAND_API_URL) {
      console.error("Missing DATASET_EXPAND_API_URL — use --dry-run or set credentials in .env");
      process.exit(1);
    }
    for (const w of windows) {
      const r = runWindow(w, dryRun);
      if (!r.ok) process.exit(1);
    }
  }

  if (!exportOnly || analyzeOnly) {
    const reports = windows.map((w) => {
      const dir = path.join(OUT_ROOT, `window-${String(w.id).padStart(2, "0")}`);
      return { window: w.id, ...analyzeWindow(dir) };
    });
    const outPath = path.join(OUT_ROOT, "research-analysis.json");
    fs.mkdirSync(OUT_ROOT, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), reports }, null, 2));
    console.log(`\nResearch analysis → ${outPath}`);
    for (const r of reports) {
      if (!r.ok) console.log(`  Window ${r.window}: ${r.reason}`);
      else {
        console.log(`  Window ${r.window}: ${r.trades} trades, WR ${(r.winRate * 100).toFixed(1)}%`);
        console.log(`    R#1 avg sweepAge=${r.research1_sequence.avgSweepAgeBars?.toFixed(1) ?? "n/a"}`);
        console.log(`    R#3 avg exitEff=${r.research3_exit.avgExitEfficiency?.toFixed(2) ?? "n/a"} measuredMfe=${(r.research3_exit.pctMeasuredMfe * 100).toFixed(0)}%`);
      }
    }
  }
}

main();
