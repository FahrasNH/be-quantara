#!/usr/bin/env node
"use strict";

/**
 * generate-ml-features.js — Sprint 5 / RL-2
 *
 * Backfill script: generate 60-dim feature vectors for ALL trades that have
 * entryContext and store them in VectorStore (TradeEmbedding).
 *
 * Usage: node scripts/ml/generate-ml-features.js
 * npm script: scripts:generate-ml-features
 */

require("dotenv").config();

const path           = require("path");
const fs             = require("fs");
const prisma         = require("../../src/infrastructure/db/prismaClient");
const FeatureEngineer = require("#modules/ml/domain/FeatureEngineer.js");
const VectorStore    = require("../../src/infrastructure/db/VectorStore");
const { _pool }      = require("../../src/infrastructure/db/database");

const OUTPUT_PATH = path.join(__dirname, "../../data/ml-features-report.json");

async function main() {
  console.log("[generate-ml-features] Starting feature generation...");

  const featureEngineer = new FeatureEngineer();
  const vectorStore     = new VectorStore(_pool);

  const available = await vectorStore.checkAvailability();
  if (!available) {
    console.warn("[generate-ml-features] pgvector not available — embeddings will not be stored");
  }

  // Query all trades with entryContext
  const trades = await prisma.trade.findMany({
    where:   { entryContext: { not: null } },
    select:  {
      id:           true,
      symbol:       true,
      side:         true,
      firedByStrategy: true,
      entryContext: true,
      exitContext:  true,
      enteredAt:    true,
    },
    orderBy: { enteredAt: "asc" },
  });

  console.log(`[generate-ml-features] Found ${trades.length} trades with entryContext`);

  let processed = 0;
  let failed    = 0;
  const nullCounts = new Array(60).fill(0);
  const batchSize  = 50;
  const batch      = [];

  for (const trade of trades) {
    try {
      const entryCtx = typeof trade.entryContext === "string"
        ? JSON.parse(trade.entryContext)
        : trade.entryContext;

      // Check for data leakage
      const leakage = featureEngineer.checkLeakage(entryCtx);
      if (leakage.length > 0) {
        console.warn(`[generate-ml-features] Leakage detected in trade ${trade.id}: ${leakage.join(", ")}`);
      }

      const tradeMetadata = {
        strategyKey: trade.firedByStrategy || "ADAPTIVE_FUSION",
        symbol:      trade.symbol,
        side:        trade.side,
      };

      const vector = featureEngineer.buildFeatureVector(entryCtx, tradeMetadata);

      // Track null/zero features
      for (let i = 0; i < vector.length; i++) {
        if (vector[i] === 0) nullCounts[i]++;
      }

      // Compute outcome
      const exitCtx = typeof trade.exitContext === "string"
        ? JSON.parse(trade.exitContext || "{}")
        : trade.exitContext;
      const outcome = exitCtx?.pnlPct > 0 || exitCtx?.pnl > 0 ? "win" : (exitCtx ? "loss" : null);

      const metadata = {
        strategyKey:  trade.firedByStrategy,
        symbol:       trade.symbol,
        regime:       entryCtx?.regime,
        outcome,
        timestamp:    trade.enteredAt?.toISOString(),
      };

      if (available) {
        batch.push({ tradeId: trade.id, vector, metadata });
        if (batch.length >= batchSize) {
          await vectorStore.batchUpsert(batch);
          batch.length = 0;
        }
      }

      processed++;
    } catch (err) {
      console.warn(`[generate-ml-features] Failed for trade ${trade.id}: ${err.message}`);
      failed++;
    }
  }

  // Flush remaining batch
  if (available && batch.length > 0) {
    await vectorStore.batchUpsert(batch);
  }

  // Compute null rate per feature
  const featureNames = featureEngineer.getFeatureNames();
  const avgNullRatePerFeature = featureNames.map((name, i) => ({
    name,
    nullRate: trades.length > 0 ? nullCounts[i] / trades.length : 0,
  }));

  // Compute simple correlation matrix (top 10 pairs)
  console.log("\n[generate-ml-features] Computing feature correlations...");
  const topCorrelations = await computeTopCorrelations(trades, featureEngineer);

  const report = {
    total:      trades.length,
    processed,
    failed,
    avgNullRatePerFeature,
    topCorrelatedPairs: topCorrelations,
    generatedAt: new Date().toISOString(),
    vectorDim: 60,
  };

  // Ensure output directory exists
  const outDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n[generate-ml-features] Done. Processed: ${processed}, Failed: ${failed}`);
  console.log(`[generate-ml-features] Report saved: ${OUTPUT_PATH}`);

  await prisma.$disconnect();
  process.exit(0);
}

async function computeTopCorrelations(trades, featureEngineer) {
  if (trades.length < 10) return [];
  const sampleSize = Math.min(500, trades.length);
  const sample = trades.slice(0, sampleSize);

  const vectors = [];
  for (const trade of sample) {
    try {
      const entryCtx = typeof trade.entryContext === "string"
        ? JSON.parse(trade.entryContext)
        : trade.entryContext;
      const v = featureEngineer.buildFeatureVector(entryCtx, {
        strategyKey: trade.firedByStrategy,
        symbol: trade.symbol,
        side: trade.side,
      });
      vectors.push(Array.from(v));
    } catch { /* skip */ }
  }

  if (vectors.length < 5) return [];

  const n = vectors.length;
  const dim = 60;
  const featureNames = featureEngineer.getFeatureNames();

  // Compute means
  const means = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) means[i] += v[i] / n;

  // Compute stds
  const stds = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) stds[i] += (v[i] - means[i]) ** 2 / n;
  for (let i = 0; i < dim; i++) stds[i] = Math.sqrt(stds[i]);

  // Compute top correlations (only upper triangle)
  const corrs = [];
  for (let i = 0; i < dim; i++) {
    for (let j = i + 1; j < dim; j++) {
      if (stds[i] < 1e-9 || stds[j] < 1e-9) continue;
      let cov = 0;
      for (const v of vectors) cov += (v[i] - means[i]) * (v[j] - means[j]) / n;
      const corr = cov / (stds[i] * stds[j]);
      corrs.push({ feature1: featureNames[i], feature2: featureNames[j], correlation: Math.abs(corr) });
    }
  }

  corrs.sort((a, b) => b.correlation - a.correlation);
  return corrs.slice(0, 10);
}

main().catch((err) => {
  console.error("[generate-ml-features] Fatal:", err);
  process.exit(1);
});
