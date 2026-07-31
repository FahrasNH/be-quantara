#!/usr/bin/env node
"use strict";

/**
 * Pre-flight RAG gate diagnostic — run on VPS (or laptop with tunneled DATABASE_URL).
 *
 * Usage:
 *   npm run ml:diag
 *   npm run ml:diag -- --strategy ADAPTIVE_FUSION --symbol BTCUSDT
 *   npm run ml:diag -- --strategy TREND_SURGE --symbol ETHUSDT
 *   npm run ml:diag -- --strategy TREND_FOLLOWING --symbol BTCUSDT
 */

require("dotenv").config();

const fs = require("fs");
const { WIN_PREDICTOR_PATH } = require("../../src/modules/ml/constants/modelPaths");
const { resolveRagStrategyFilterKeys } = require("../../src/config/strategies");
const WinPredictor = require("../../src/modules/ml/domain/WinPredictor");
const FeatureEngineer = require("../../src/modules/ml/domain/FeatureEngineer");
const VectorStore = require("../../src/infrastructure/db/VectorStore");
const { _pool } = require("../../src/infrastructure/db/database");
const {
  dbHostHint,
  formatDbConnectionError,
  preflightRagDatabase,
  queryEmbeddingCounts,
} = require("./rag-db-helpers");

function parseArgs() {
  const out = { strategy: "ADAPTIVE_FUSION", symbol: "BTCUSDT" };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--strategy=")) out.strategy = a.split("=")[1].toUpperCase();
    else if (a === "--strategy") out.strategy = String(process.argv[++i] || "").toUpperCase();
    else if (a.startsWith("--symbol=")) out.symbol = a.split("=")[1].toUpperCase();
    else if (a === "--symbol") out.symbol = String(process.argv[++i] || "").toUpperCase();
  }
  return out;
}

async function main() {
  const { strategy, symbol } = parseArgs();
  const filterKeys = resolveRagStrategyFilterKeys(strategy);
  const isUmbrella = filterKeys.length > 1;

  console.log(`\n=== RAG Diagnostic (${strategy} → ${filterKeys.join(", ")}) ===`);
  console.log(`DATABASE_URL host: ${dbHostHint()}`);

  let pgvector = false;
  let embeddingCount = 0;
  let byStrategy = [];
  let componentCounts = {};

  const preflight = await preflightRagDatabase(_pool);
  pgvector = true;
  console.log(`DB OK — pgvector ${preflight.pgvectorVersion}`);
  const counts = await queryEmbeddingCounts(_pool, filterKeys);
  embeddingCount = counts.embeddingCount;
  byStrategy = counts.byStrategy;
  componentCounts = counts.componentCounts;

  const modelExists = fs.existsSync(WIN_PREDICTOR_PATH);
  const wp = new WinPredictor();
  await wp.load().catch(() => {});
  const hasModel = !!(wp.model && (
    (Array.isArray(wp.model.stumps) && wp.model.stumps.length > 0)
    || (Number(wp.model.tradeCount) >= 5)
  ));

  const vs = new VectorStore(_pool);
  const fe = new FeatureEngineer();
  const sampleCtx = { rsi: 55, side: "LONG", confidence: 0.7, regime: "TRENDING" };
  const sampleKey = filterKeys[0] || strategy;
  const tradeMeta = { strategyKey: sampleKey, symbol, side: "LONG" };

  let lgbScore = null;
  let neighborCount = 0;
  let outcomeCount = 0;
  let findError = null;

  try {
    const features = fe.buildFeatureVector(sampleCtx, tradeMeta);
    if (hasModel) lgbScore = wp.predict(features).pWin;

    const similar = await vs.findSimilar(features, 20, {
      symbol,
      strategyKey: isUmbrella ? filterKeys : sampleKey,
      beforeDate: new Date().toISOString(),
    });
    neighborCount = similar.length;
    outcomeCount = similar.filter((s) => {
      const m = s.metadata;
      if (!m) return false;
      if (m.outcome === "win" || m.outcome === "loss") return true;
      const pnl = m.pnlPct ?? m.pnl ?? m.pnlNet;
      return typeof pnl === "number" && Number.isFinite(pnl) && pnl !== 0;
    }).length;
  } catch (err) {
    findError = err.message;
  }

  console.log("\n--- Summary ---");
  console.log(`pgvector: ${pgvector} | embeddings: ${embeddingCount} | model: ${hasModel} (exists=${modelExists})`);
  if (isUmbrella) {
    console.log(`Component counts (${strategy}):`, componentCounts);
  }
  console.log(`Filter keys:`, filterKeys);
  console.log(`Top strategyKey buckets:`, byStrategy.slice(0, 8));
  console.log(`Sample findSimilar (${symbol}, key=${sampleKey}): neighbors=${neighborCount}, outcomes=${outcomeCount}, lgb=${lgbScore}`);
  if (findError) console.log(`findSimilar error: ${findError}`);

  if (!pgvector) console.log("\nFIX: npx prisma migrate deploy (pgvector missing)");
  if (embeddingCount < 5) {
    console.log("FIX: npm run ml:deploy:dev  (or ml:deploy:staging) — seed embeddings on VPS");
  }
  if (!hasModel) console.log("FIX: commit data/models/win-predictor.json + pm2 reload");
  if (neighborCount === 0 && embeddingCount > 0) {
    console.log("FIX: strategyKey/symbol filter mismatch — embeddings must use component keys, not umbrella");
    console.log("     e.g. TREND_FOLLOWING not TREND_SURGE; SMART_MONEY_CONCEPTS not ADAPTIVE_FUSION");
  }

  const ok = (hasModel || embeddingCount >= 5) && (neighborCount > 0 || embeddingCount === 0);
  await _pool.end().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nFatal:", err?.message || err);
  if (/connect|ECONNREFUSED|relation/i.test(String(err?.message || ""))) {
    console.error(formatDbConnectionError(err));
  }
  try { await _pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
