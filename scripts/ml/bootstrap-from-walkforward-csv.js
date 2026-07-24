#!/usr/bin/env node
"use strict";

/**
 * bootstrap-from-walkforward-csv.js — Offline ML bootstrap from walk-forward exports.
 *
 * Builds data/ml-engine-dataset.json when staging DB is unavailable locally.
 * Reads trades.csv from tmp/sprint19-smc-walkforward (or --dir=).
 *
 * Usage:
 *   node scripts/ml/bootstrap-from-walkforward-csv.js
 *   node scripts/ml/bootstrap-from-walkforward-csv.js --dir=tmp/sprint19-smc-walkforward
 * npm: ml:bootstrap-walkforward
 */

const fs = require("fs");
const path = require("path");
const FeatureEngineer = require("#modules/ml/domain/FeatureEngineer.js");
const { ML_ENGINE_DATASET_PATH, REPO_ROOT } = require("#modules/ml/constants/modelPaths.js");

function parseArgs() {
  const out = { dir: path.join(REPO_ROOT, "tmp/sprint19-smc-walkforward"), min: 20 };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--dir=")) out.dir = path.resolve(REPO_ROOT, arg.slice(6));
    else if (arg.startsWith("--min=")) out.min = parseInt(arg.slice(6), 10);
  }
  return out;
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
  const text = fs.readFileSync(filePath, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((ln) => {
    const vals = parseCsvLine(ln);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
}

function num(v, fallback = null) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function csvRowToEntryContext(row) {
  const graded = num(row["Graded Score"], 50);
  const htfAdx = num(row["HTF ADX"]);
  const side = String(row.Side || "LONG").toUpperCase();
  const entryPrice = num(row["Entry Price"], 1);

  return {
    capturedAt:       row["Open Time"] || new Date().toISOString(),
    confidenceScore:  graded,
    entryConfidence:  graded,
    signalQuality:    graded,
    bosScore:         Math.min(100, num(row["Conf Sweep"], 0) * 25),
    chochScore:       Math.min(100, num(row["Conf Disp %"], 0) * 100),
    fvgScore:         Math.min(100, num(row["Conf FVG"], 0) * 100),
    liquidityScore:   Math.min(100, num(row["Sweep Strength"], 0) * 20),
    votingScore:      graded,
    atr:              num(row.ATR, 0),
    atrPct:           entryPrice > 0 ? +((num(row.ATR, 0) / entryPrice) * 100).toFixed(4) : 0,
    adx:              htfAdx,
    rsi:              50,
    bbWidth:          num(row["BB Width"], 0),
    volumeRatio:      num(row["Volume Ratio"], 1),
    fundingRate:      num(row["Funding Rate At Entry"]),
    strategyKey:      row.Strategy || "SMART_MONEY_CONCEPTS",
    tradeType:        row.Component || "Scalping",
    pairTier:         "LIQUID",
    leverage:         1,
    regime:           htfAdx != null && htfAdx > 25 ? "trend_up" : "ranging",
    htfRegime:        side === "LONG" ? "trending_up" : "trending_down",
    source:           "walkforward-csv",
  };
}

function findTradeCsvFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === "trades.csv") files.push(full);
    }
  };
  walk(rootDir);
  return files.sort();
}

function main() {
  const { dir, min } = parseArgs();
  const csvFiles = findTradeCsvFiles(dir);

  if (csvFiles.length === 0) {
    console.error(`[bootstrap-walkforward] No trades.csv under ${dir}`);
    console.error("[bootstrap-walkforward] Run scripts/walkforward/smart-money-concepts/scalping-research.js first.");
    process.exit(1);
  }

  const fe = new FeatureEngineer();
  const samples = [];
  let skipped = 0;

  for (const csvPath of csvFiles) {
    const rows = loadCsv(csvPath);
    for (const row of rows) {
      if (row.Result !== "win" && row.Result !== "loss") { skipped++; continue; }
      try {
        const entryContext = csvRowToEntryContext(row);
        const features = fe.buildFeatureVector(entryContext, {
          strategyKey: entryContext.strategyKey,
          symbol:      row.Symbol || "BTCUSDT",
          side:        row.Side || "LONG",
        });
        samples.push({
          features:  Array.from(features),
          label:     row.Result === "win" ? 1 : 0,
          timestamp: row["Open Time"] || new Date().toISOString(),
          tradeId:   row.ID || `${row.Symbol}-${samples.length}`,
          sourceFile: path.relative(REPO_ROOT, csvPath),
        });
      } catch {
        skipped++;
      }
    }
  }

  console.log(`[bootstrap-walkforward] CSV files: ${csvFiles.length}, samples: ${samples.length}, skipped: ${skipped}`);

  if (samples.length < min) {
    console.error(`[bootstrap-walkforward] Need >= ${min} samples, got ${samples.length}`);
    process.exit(1);
  }

  const dataDir = path.dirname(ML_ENGINE_DATASET_PATH);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(ML_ENGINE_DATASET_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source:      "walkforward-csv",
    sourceDir:   path.relative(REPO_ROOT, dir),
    tradeCount:  samples.length,
    samples,
  }, null, 2));

  console.log(`[bootstrap-walkforward] Dataset saved: ${ML_ENGINE_DATASET_PATH}`);
  console.log("[bootstrap-walkforward] Next: npm run ml:train-win-predictor");
}

main();
