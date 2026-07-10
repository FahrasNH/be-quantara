#!/usr/bin/env node
"use strict";

/**
 * train-win-predictor.js — Sprint 5 / RL-3
 *
 * Trains the WinPredictor model using walk-forward validation on historical trades.
 * Saves the best model to data/models/win-predictor.json.
 *
 * Data sources (in order):
 *   1. Prisma "Trade" with entryContext + exitContext
 *   2. Engine `trades` table via ml-engine-dataset.json (from bootstrap script)
 *   3. Engine `trades` table live query (fallback)
 *
 * Usage: node scripts/ml/train-win-predictor.js
 * npm script: ml:train-win-predictor
 */

require("dotenv").config();

const path           = require("path");
const fs             = require("fs");
const prisma         = require("../../src/infrastructure/db/prismaClient");
const FeatureEngineer = require("../../src/domain/FeatureEngineer");
const WinPredictor   = require("../../src/domain/WinPredictor");
const { _pool }      = require("../../src/infrastructure/db/database");
const {
  fetchClosedEngineTrades,
  buildMlArtifactsFromEngineRows,
} = require("../../src/domain/engineTradeMlAdapter");

const MODEL_PATH   = path.join(__dirname, "../../data/models/win-predictor.json");
const REPORT_PATH  = path.join(__dirname, "../../data/models/training-report.json");
const DATASET_PATH = path.join(__dirname, "../../data/ml-engine-dataset.json");

async function loadPrismaDataset(featureEngineer) {
  const trades = await prisma.trade.findMany({
    where:  {
      entryContext: { not: null },
      exitContext:  { not: null },
      status:       "CLOSED",
    },
    select: {
      id:              true,
      symbol:          true,
      side:            true,
      firedByStrategy: true,
      entryContext:    true,
      exitContext:     true,
      enteredAt:       true,
    },
    orderBy: { enteredAt: "asc" },
  });

  const dataset = [];
  let skipped = 0;
  for (const trade of trades) {
    try {
      const entryCtx = parseJson(trade.entryContext);
      const exitCtx  = parseJson(trade.exitContext);
      const label = exitCtx?.pnlPct > 0 || exitCtx?.pnl > 0 ? 1 : 0;
      const features = featureEngineer.buildFeatureVector(entryCtx, {
        strategyKey: trade.firedByStrategy || "ADAPTIVE_FUSION",
        symbol:      trade.symbol,
        side:        trade.side,
      });
      dataset.push({ features, label, timestamp: trade.enteredAt });
    } catch {
      skipped++;
    }
  }
  return { dataset, skipped, source: "prisma-trade" };
}

function loadCachedEngineDataset() {
  if (!fs.existsSync(DATASET_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
    if (!raw?.samples?.length) return null;
    const dataset = raw.samples.map((s) => ({
      features: new Float32Array(s.features),
      label:    s.label,
      timestamp: s.timestamp,
    }));
    return { dataset, skipped: 0, source: "ml-engine-dataset.json" };
  } catch {
    return null;
  }
}

async function loadEngineTradesDataset(featureEngineer) {
  const { rows } = await fetchClosedEngineTrades(_pool, { limit: 5000 });
  const { dataset: built, skipped } = buildMlArtifactsFromEngineRows(rows, featureEngineer);
  const dataset = built.map((d) => ({
    features:  d.features,
    label:     d.label,
    timestamp: d.timestamp,
  }));
  return { dataset, skipped, source: "engine-trades" };
}

async function main() {
  console.log("[train-win-predictor] Loading trades...");

  const featureEngineer = new FeatureEngineer();
  let { dataset, skipped, source } = await loadPrismaDataset(featureEngineer);

  console.log(`[train-win-predictor] Prisma Trade: ${dataset.length} samples`);

  if (dataset.length === 0) {
    const cached = loadCachedEngineDataset();
    if (cached?.dataset?.length) {
      ({ dataset, skipped, source } = cached);
      console.log(`[train-win-predictor] Using cached engine dataset: ${dataset.length} samples`);
    } else {
      const engine = await loadEngineTradesDataset(featureEngineer);
      ({ dataset, skipped, source } = engine);
      console.log(`[train-win-predictor] Engine trades fallback: ${dataset.length} samples (${skipped} skipped)`);
    }
  }

  if (dataset.length === 0) {
    console.warn("[train-win-predictor] No training data. Run: npm run ml:bootstrap-engine-trades");
    console.warn("[train-win-predictor] Saving empty fallback model.");
    const predictor = new WinPredictor();
    await predictor.train([]);
    await predictor.save(MODEL_PATH);
    const report = {
      auc: 0.5, accuracy: 0.5, splits: [], featureImportance: [],
      hyperparams: {}, trainedAt: new Date().toISOString(), tradeCount: 0,
      note: "No training data — run ml:bootstrap-engine-trades after bots accumulate trades",
      source,
    };
    ensureDir(REPORT_PATH);
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`[train-win-predictor] Training from: ${source}`);
  console.log(`[train-win-predictor] Dataset: ${dataset.length} samples (${skipped} skipped)`);
  const winCount = dataset.filter((d) => d.label === 1).length;
  console.log(`[train-win-predictor] Class balance: ${winCount} wins, ${dataset.length - winCount} losses (${(winCount/dataset.length*100).toFixed(1)}% WR)`);

  console.log("\n[train-win-predictor] Running walk-forward validation...");
  const predictor = new WinPredictor();
  const wfResult  = await predictor.walkForwardValidate(dataset, { trainDays: 90, testDays: 30, splits: 4 });

  console.log("[train-win-predictor] Walk-forward results:");
  for (let i = 0; i < wfResult.splits.length; i++) {
    const s = wfResult.splits[i];
    console.log(`  Split ${i+1}: AUC=${s.auc.toFixed(3)}, Accuracy=${(s.accuracy*100).toFixed(1)}%, Train=${s.trainSize}, Test=${s.testSize}`);
  }
  console.log(`  Avg AUC: ${wfResult.avgAuc.toFixed(3)}, Avg Accuracy: ${(wfResult.avgAccuracy*100).toFixed(1)}%`);

  console.log("\n[train-win-predictor] Training final model on full dataset...");
  const splitIdx   = Math.floor(dataset.length * 0.8);
  const trainData  = dataset.slice(0, splitIdx);
  const valData    = dataset.slice(splitIdx);

  const trainResult = await predictor.train(trainData, valData);
  predictor.model.trainedAt   = new Date().toISOString();
  predictor.model.tradeCount  = dataset.length;
  predictor.model.source      = source;

  console.log(`[train-win-predictor] Final model AUC: ${trainResult.auc.toFixed(3)}, Accuracy: ${(trainResult.accuracy*100).toFixed(1)}%`);

  if (trainResult.auc < 0.50) {
    console.warn("[train-win-predictor] WARNING: AUC < 0.50 — model may not be reliable. Saving anyway.");
  }

  ensureDir(MODEL_PATH);
  await predictor.save(MODEL_PATH);
  console.log(`[train-win-predictor] Model saved: ${MODEL_PATH}`);

  const fi = predictor.getFeatureImportance().slice(0, 10);
  console.log("\n[train-win-predictor] Top 10 feature importance:");
  fi.forEach(({ name, importance }, i) => {
    console.log(`  ${i+1}. ${name}: ${(importance * 100).toFixed(2)}%`);
  });

  const report = {
    auc:             trainResult.auc,
    accuracy:        trainResult.accuracy,
    precision:       trainResult.precision,
    recall:          trainResult.recall,
    splits:          wfResult.splits,
    avgAuc:          wfResult.avgAuc,
    avgAccuracy:     wfResult.avgAccuracy,
    featureImportance: fi,
    hyperparams:     predictor.model.hyperparams,
    trainedAt:       predictor.model.trainedAt,
    tradeCount:      dataset.length,
    winRate:         winCount / dataset.length,
    source,
  };

  ensureDir(REPORT_PATH);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[train-win-predictor] Report saved: ${REPORT_PATH}`);

  await prisma.$disconnect();
  process.exit(0);
}

function parseJson(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

main().catch((err) => {
  console.error("[train-win-predictor] Fatal:", err);
  process.exit(1);
});
