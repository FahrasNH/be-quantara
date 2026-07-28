#!/usr/bin/env node
"use strict";

/**
 * Print TradeEmbedding row counts (total + by strategyKey).
 * Replaces fragile inline node -e in deploy-rag-vps.sh.
 *
 * Usage:
 *   npm run ml:embeddings
 *   node scripts/ml/print-embedding-counts.js --umbrella=ADAPTIVE_FUSION
 *   node scripts/ml/print-embedding-counts.js --umbrella=TREND_SURGE
 */

require("dotenv").config();

const { _pool } = require("../../src/infrastructure/db/database");
const { resolveRagStrategyFilterKeys } = require("../../src/config/strategies");
const { preflightRagDatabase, queryEmbeddingCounts } = require("./rag-db-helpers");

function parseArgs() {
  const out = { umbrella: null };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--umbrella=")) out.umbrella = a.split("=")[1].toUpperCase();
    else if (a === "--umbrella") out.umbrella = String(process.argv[++i] || "").toUpperCase();
  }
  return out;
}

async function main() {
  await preflightRagDatabase(_pool);
  const { umbrella } = parseArgs();
  const componentKeys = umbrella ? resolveRagStrategyFilterKeys(umbrella) : [];
  const counts = await queryEmbeddingCounts(_pool, componentKeys);

  const payload = {
    embeddingCount: counts.embeddingCount,
    byStrategy: counts.byStrategy,
  };
  if (componentKeys.length) {
    payload.umbrella = umbrella;
    payload.componentCounts = counts.componentCounts;
  }

  console.log(JSON.stringify(payload, null, 2));
  await _pool.end();
}

main().catch(async (err) => {
  console.error(err?.message || err);
  try { await _pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
