"use strict";

const fs = require("fs");
const path = require("path");

const { windowDir } = require("./paths");

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

function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

/** Research #1 (sequence) + #3 (exit quality) per window. */
function analyzeWindow(outRoot, winId) {
  const winDir = windowDir(outRoot, winId);
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

function analyzeAllWindows(outRoot, windows) {
  return windows.map((w) => ({
    window: w.id,
    ...analyzeWindow(outRoot, w.id),
  }));
}

function printResearchReports(reports) {
  for (const r of reports) {
    if (!r.ok) console.log(`  Window ${r.window}: ${r.reason}`);
    else {
      console.log(`  Window ${r.window}: ${r.trades} trades, WR ${(r.winRate * 100).toFixed(1)}%`);
      console.log(`    R#1 avg sweepAge=${r.research1_sequence.avgSweepAgeBars?.toFixed(1) ?? "n/a"}`);
      console.log(`    R#3 avg exitEff=${r.research3_exit.avgExitEfficiency?.toFixed(2) ?? "n/a"} measuredMfe=${(r.research3_exit.pctMeasuredMfe * 100).toFixed(0)}%`);
    }
  }
}

module.exports = {
  analyzeWindow,
  analyzeAllWindows,
  printResearchReports,
};
