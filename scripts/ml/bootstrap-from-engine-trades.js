#!/usr/bin/env node
"use strict";

/**
 * bootstrap-from-engine-trades.js
 *
 * Bootstrap RAG/ML from the real engine `trades` table (not Prisma "Trade"):
 *   1. Read closed trades + indicators JSON
 *   2. Upsert TradeEmbedding via pgvector
 *   3. Write training dataset JSON for train-win-predictor.js
 *
 * Usage:
 *   node scripts/ml/bootstrap-from-engine-trades.js [--limit=5000] [--min=5]
 * npm: ml:bootstrap-engine-trades
 */

require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const FeatureEngineer = require("../../src/domain/FeatureEngineer");
const VectorStore     = require("../../src/infrastructure/db/VectorStore");
const { _pool }       = require("../../src/infrastructure/db/database");
const {
  fetchClosedEngineTrades,
  buildMlArtifactsFromEngineRows,
} = require("../../src/domain/engineTradeMlAdapter");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);
const LIMIT = parseInt(args.limit ?? "5000", 10);
const MIN   = parseInt(args.min ?? "5", 10);
const DRY   = args["dry-run"] === true || args["dry-run"] === "true";

const DATASET_PATH = path.join(__dirname, "../../data/ml-engine-dataset.json");
const REPORT_PATH  = path.join(__dirname, "../../data/ml-bootstrap-report.json");

async function main() {
  console.log("[bootstrap-engine-trades] Loading closed trades from engine store…");

  const { rows, warning } = await fetchClosedEngineTrades(_pool, { limit: LIMIT, minRows: 0 });
  console.log(`[bootstrap-engine-trades] Found ${rows.length} closed trades`);
  if (warning) console.warn(`[bootstrap-engine-trades] ${warning}`);

  if (rows.length < MIN) {
    console.error(
      `[bootstrap-engine-trades] Need at least ${MIN} closed trades. ` +
      "Start staging bots (paper/live) and re-run after trades accumulate."
    );
    process.exit(1);
  }

  const fe = new FeatureEngineer();
  const { dataset, embeddings, skipped } = buildMlArtifactsFromEngineRows(rows, fe);
  console.log(`[bootstrap-engine-trades] Built ${dataset.length} samples (${skipped} skipped)`);

  if (dataset.length < MIN) {
    console.error("[bootstrap-engine-trades] Insufficient valid samples after parsing indicators.");
    process.exit(1);
  }

  let embeddingCount = 0;
  let hasVector = false;

  if (!DRY) {
    const vs = new VectorStore(_pool);
    hasVector = await vs.checkAvailability();
    if (hasVector) {
      const batchSize = 50;
      for (let i = 0; i < embeddings.length; i += batchSize) {
        await vs.batchUpsert(embeddings.slice(i, i + batchSize));
      }
      embeddingCount = embeddings.length;
      console.log(`[bootstrap-engine-trades] Upserted ${embeddingCount} TradeEmbedding rows`);
    } else {
      console.warn("[bootstrap-engine-trades] pgvector unavailable — embeddings not stored");
    }

    const dataDir = path.dirname(DATASET_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(DATASET_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      tradeCount:  dataset.length,
      samples: dataset.map((d) => ({
        features:  Array.from(d.features),
        label:     d.label,
        timestamp: d.timestamp,
        tradeId:   d.tradeId,
      })),
    }, null, 2));
    console.log(`[bootstrap-engine-trades] Dataset saved: ${DATASET_PATH}`);
  } else {
    console.log("[bootstrap-engine-trades] DRY RUN — no DB writes");
    embeddingCount = embeddings.length;
  }

  const report = {
    generatedAt:    new Date().toISOString(),
    dryRun:         DRY,
    closedTrades:   rows.length,
    datasetSamples: dataset.length,
    embeddings:     embeddingCount,
    hasVector,
    skipped,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`[bootstrap-engine-trades] Report: ${REPORT_PATH}`);
  console.log("[bootstrap-engine-trades] Done. Next: npm run ml:train-win-predictor");
  process.exit(0);
}

main().catch((err) => {
  console.error("[bootstrap-engine-trades] Fatal:", err);
  process.exit(1);
});
