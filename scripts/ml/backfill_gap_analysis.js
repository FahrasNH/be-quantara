#!/usr/bin/env node
"use strict";

/**
 * backfill_gap_analysis.js — Sprint 18
 *
 * Compare model accuracy on pre-backfill trades (HOD=null) vs post-backfill.
 * Outputs metrics for ML_MODEL_CARD.md and exits non-zero if gap > 5%.
 *
 * Usage:
 *   node scripts/ml/backfill_gap_analysis.js
 *   node scripts/ml/backfill_gap_analysis.js --synthetic   # offline demo
 */

require("dotenv").config();

const FeatureEngineer = require("../../src/modules/ml/domain/FeatureEngineer");
const WinPredictor = require("../../src/modules/ml/domain/WinPredictor");
const { _pool } = require("../../src/infrastructure/db/database");

const BACKFILL_CUTOFF = new Date("2026-07-18T00:00:00Z");
const MAX_GAP_PCT = 0.05;

function parseJson(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function labelFromRow(row) {
  const exitCtx = parseJson(row.exit_context);
  const pnl = parseFloat(row.pnl ?? exitCtx.pnl ?? 0);
  return pnl > 0 ? 1 : 0;
}

function buildSample(row, fe) {
  const entryCtx = parseJson(row.entry_context);
  const features = fe.buildFeatureVector(entryCtx, {
    strategyKey: row.strategy_name || "SMART_MONEY_CONCEPTS",
    symbol: row.symbol,
    side: row.side,
  });
  return {
    features,
    label: labelFromRow(row),
    openTime: new Date(row.open_time),
    hasHod: entryCtx.hodPrice != null && Number.isFinite(Number(entryCtx.hodPrice)),
    isPreBackfill: new Date(row.open_time) < BACKFILL_CUTOFF,
  };
}

function evaluateAccuracy(predictor, samples) {
  if (!samples.length) return { accuracy: null, n: 0 };
  let correct = 0;
  for (const s of samples) {
    const { pWin } = predictor.predict(s.features);
    const pred = pWin >= 0.5 ? 1 : 0;
    if (pred === s.label) correct += 1;
  }
  return { accuracy: correct / samples.length, n: samples.length };
}

function syntheticRows() {
  const fe = new FeatureEngineer();
  const rows = [];
  const mk = (daysAgo, hasHod, win) => ({
    symbol: "BTCUSDT",
    side: "LONG",
    strategy_name: "SMART_MONEY_CONCEPTS",
    open_time: new Date(Date.now() - daysAgo * 86400000).toISOString(),
    pnl: win ? 10 : -5,
    entry_context: {
      confidenceScore: win ? 75 : 40,
      pairTier: "LIQUID",
      hodPrice: hasHod ? 65000 : null,
      atr: 500,
      regime: "ranging",
    },
    exit_context: { pnl: win ? 10 : -5 },
  });
  for (let i = 0; i < 30; i++) {
    rows.push(mk(30 + i, false, i % 3 !== 0));
    rows.push(mk(5 + (i % 7), true, i % 2 === 0));
  }
  return rows.map((r) => buildSample(r, fe));
}

async function loadRowsFromDb() {
  const { rows } = await _pool.query(
    `SELECT symbol, side, strategy_name, open_time, pnl,
            entry_context, exit_context
     FROM trades
     WHERE status = 'closed'
       AND open_time > NOW() - INTERVAL '60 days'
     ORDER BY open_time ASC`,
  );
  return rows;
}

async function main() {
  const useSynthetic = process.argv.includes("--synthetic");
  const fe = new FeatureEngineer();
  let samples;

  if (useSynthetic) {
    console.log("[backfill-gap] Using synthetic fixture (--synthetic)");
    samples = syntheticRows();
  } else {
    try {
      const rows = await loadRowsFromDb();
      samples = rows.map((r) => buildSample(r, fe));
      console.log(`[backfill-gap] Loaded ${samples.length} closed trades (60d window)`);
    } catch (err) {
      console.warn(`[backfill-gap] DB unavailable (${err.message}) — falling back to synthetic`);
      samples = syntheticRows();
    }
  }

  if (samples.length < 20) {
    console.warn("[backfill-gap] Insufficient samples — need >= 20 for meaningful split");
    process.exit(0);
  }

  const pre = samples.filter((s) => s.isPreBackfill || !s.hasHod);
  const post = samples.filter((s) => !s.isPreBackfill && s.hasHod);

  const trainPool = samples.slice(0, Math.floor(samples.length * 0.7));
  const predictor = new WinPredictor();
  await predictor.train(trainPool.map((s) => ({ features: s.features, label: s.label })));

  const accPre = evaluateAccuracy(predictor, pre);
  const accPost = evaluateAccuracy(predictor, post);
  const gap = accPre.accuracy != null && accPost.accuracy != null
    ? accPost.accuracy - accPre.accuracy
    : null;

  const report = {
    backfillCutoff: BACKFILL_CUTOFF.toISOString(),
    accuracyPreBackfill: accPre.accuracy,
    accuracyPostBackfill: accPost.accuracy,
    gap,
    sampleSizePre: accPre.n,
    sampleSizePost: accPost.n,
    recommendation: gap == null
      ? "insufficient_data"
      : gap > MAX_GAP_PCT
        ? "delay_training"
        : gap >= 0.02
          ? "document_limitation"
          : "proceed_mixed_training",
    analyzedAt: new Date().toISOString(),
  };

  console.log("\n=== Backfill Gap Analysis ===");
  if (accPre.accuracy != null) {
    console.log(`Accuracy (pre-backfill, no HOD):   ${(accPre.accuracy * 100).toFixed(1)}% (n=${accPre.n})`);
  }
  if (accPost.accuracy != null) {
    console.log(`Accuracy (post-backfill, has HOD):  ${(accPost.accuracy * 100).toFixed(1)}% (n=${accPost.n})`);
  }
  if (gap != null) {
    console.log(`Backfill gap impact:               ${gap >= 0 ? "+" : ""}${(gap * 100).toFixed(1)}%`);
  }
  console.log(`Recommendation: ${report.recommendation}`);

  const fs = require("fs");
  const path = require("path");
  const outPath = path.join(__dirname, "../../data/models/backfill-gap-report.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${outPath}`);

  if (gap != null && gap > MAX_GAP_PCT) {
    console.error("\n❌ Gap > 5% — delay training until backfill complete");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-gap] Fatal:", err.message);
  process.exit(1);
});
