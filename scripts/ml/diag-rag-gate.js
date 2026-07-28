#!/usr/bin/env node
"use strict";

/**
 * Pre-flight RAG gate diagnostic — run on VPS (or laptop with DATABASE_URL).
 *
 * Usage:
 *   npm run ml:diag
 *   npm run ml:diag -- --strategy TREND_FOLLOWING --symbol BTCUSDT
 */

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const DEBUG_LOG = path.join(__dirname, "../../../.cursor/debug-816643.log");
const INGEST = "http://127.0.0.1:7388/ingest/342b9c62-4dc5-4962-a9c1-f9c519fa2002";
const SESSION = "816643";

const TS_KEYS = ["TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY"];

function parseArgs() {
  const out = { strategy: "TREND_FOLLOWING", symbol: "BTCUSDT" };
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--strategy=")) out.strategy = a.split("=")[1];
    else if (a === "--strategy") out.strategy = process.argv[++i];
    else if (a.startsWith("--symbol=")) out.symbol = a.split("=")[1];
    else if (a === "--symbol") out.symbol = process.argv[++i];
  }
  return out;
}

function emit(payload) {
  const line = JSON.stringify({ sessionId: SESSION, timestamp: Date.now(), ...payload });
  console.log(line);
  try {
    fs.appendFileSync(DEBUG_LOG, `${line}\n`);
  } catch { /* laptop-only path */ }
  fetch(INGEST, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": SESSION },
    body: line,
  }).catch(() => {});
}

async function main() {
  const { strategy, symbol } = parseArgs();
  const { WIN_PREDICTOR_PATH } = require("../../src/modules/ml/constants/modelPaths");
  const { resolveRagStrategyFilterKeys } = require("../../src/config/strategies");
  const WinPredictor = require("../../src/modules/ml/domain/WinPredictor");
  const FeatureEngineer = require("../../src/modules/ml/domain/FeatureEngineer");
  const VectorStore = require("../../src/infrastructure/db/VectorStore");
  const { _pool } = require("../../src/infrastructure/db/database");

  const filterKeys = resolveRagStrategyFilterKeys(strategy);
  const modelExists = fs.existsSync(WIN_PREDICTOR_PATH);
  const wp = new WinPredictor();
  const loaded = await wp.load().catch(() => false);
  const hasModel = !!(wp.model && (
    (Array.isArray(wp.model.stumps) && wp.model.stumps.length > 0)
    || (Number(wp.model.tradeCount) >= 5)
  ));

  let pgvector = false;
  let embeddingCount = 0;
  let byStrategy = [];
  let tsCounts = {};

  try {
    const ext = await _pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector' LIMIT 1");
    pgvector = (ext.rows?.length ?? 0) > 0;
    if (pgvector) {
      const cnt = await _pool.query('SELECT COUNT(*)::int AS n FROM "TradeEmbedding"');
      embeddingCount = cnt.rows?.[0]?.n ?? 0;
      const by = await _pool.query(
        `SELECT metadata->>'strategyKey' AS k, COUNT(*)::int AS n
         FROM "TradeEmbedding" GROUP BY 1 ORDER BY n DESC`
      );
      byStrategy = by.rows || [];
      for (const k of TS_KEYS) {
        const row = await _pool.query(
          `SELECT COUNT(*)::int AS n FROM "TradeEmbedding" WHERE metadata->>'strategyKey' = $1`,
          [k]
        );
        tsCounts[k] = row.rows?.[0]?.n ?? 0;
      }
    }
  } catch (err) {
    emit({
      hypothesisId: "A",
      location: "diag-rag-gate.js:db",
      message: "DB query failed",
      data: { error: err.message, databaseUrlSet: !!process.env.DATABASE_URL },
    });
    await _pool.end().catch(() => {});
    process.exit(1);
  }

  emit({
    hypothesisId: "A",
    location: "diag-rag-gate.js:preflight",
    message: "RAG preflight counts",
    data: { pgvector, embeddingCount, byStrategy, tsCounts, filterKeys, strategy, symbol },
  });

  emit({
    hypothesisId: "B",
    location: "diag-rag-gate.js:model",
    message: "WinPredictor load",
    data: { modelPath: WIN_PREDICTOR_PATH, modelExists, loaded, hasModel, stumps: wp.model?.stumps?.length ?? 0 },
  });

  const vs = new VectorStore(_pool);
  const available = await vs.checkAvailability();
  const fe = new FeatureEngineer();
  const sampleCtx = {
    rsi: 55,
    side: "LONG",
    confidence: 0.7,
    regime: "TRENDING",
  };
  const tradeMeta = { strategyKey: filterKeys[0] || strategy, symbol, side: "LONG" };
  let lgbScore = null;
  let neighborCount = 0;
  let outcomeCount = 0;
  let findError = null;

  try {
    const features = fe.buildFeatureVector(sampleCtx, tradeMeta);
    if (hasModel) lgbScore = wp.predict(features).pWin;

    const similar = await vs.findSimilar(features, 20, {
      symbol,
      strategyKey: filterKeys.length > 1 ? filterKeys : (filterKeys[0] || strategy),
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

  emit({
    hypothesisId: "C-D-E",
    location: "diag-rag-gate.js:simulate",
    message: "Sample findSimilar",
    data: {
      available,
      filterKeys,
      lgbScore,
      neighborCount,
      outcomeCount,
      findError,
      ragMinSupport: parseInt(process.env.RAG_MIN_SUPPORT || "10", 10) || 10,
    },
  });

  const ok = (hasModel || embeddingCount >= 5) && (neighborCount > 0 || embeddingCount === 0);
  console.log("\n=== RAG Diagnostic Summary ===");
  console.log(`pgvector: ${pgvector} | embeddings: ${embeddingCount} | model: ${hasModel}`);
  console.log(`TS component counts:`, tsCounts);
  console.log(`Filter keys for ${strategy}:`, filterKeys);
  console.log(`Sample findSimilar (${symbol}): neighbors=${neighborCount}, outcomes=${outcomeCount}, lgb=${lgbScore}`);
  if (!pgvector) console.log("FIX: npx prisma migrate deploy (pgvector missing)");
  if (embeddingCount < 5) console.log("FIX: npm run ml:deploy:dev (seed embeddings on VPS)");
  if (!hasModel) console.log("FIX: commit data/models/win-predictor.json + pm2 reload");
  if (neighborCount === 0 && embeddingCount > 0) {
    console.log("FIX: strategyKey/symbol filter mismatch — check byStrategy keys above");
  }

  await _pool.end().catch(() => {});
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  emit({ hypothesisId: "X", location: "diag-rag-gate.js:fatal", message: err.message, data: {} });
  console.error(err);
  process.exit(1);
});
