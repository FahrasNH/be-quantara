#!/usr/bin/env node
/**
 * feature-importance.js — Sprint 2 / PA-2
 *
 * Computes Pearson correlation between entryContext features and trade outcome
 * (win=1 / loss=0) per (strategy, regime) bucket.
 *
 * Outputs:
 *   data/feature-importance.json
 *
 * Usage:
 *   node scripts/analytics/feature-importance.js [--strategy AF_SMC] [--days 90]
 */

"use strict";

const path = require("path");
const fs   = require("fs");
const { Pool } = require("pg");

// ── CLI args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}
const STRATEGY_FILTER = getArg("--strategy") ?? null;
const DAYS_FILTER     = getArg("--days") ? parseInt(getArg("--days"), 10) : null;

// ── DB connection ──────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Paths ──────────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(__dirname, "../../data");
const OUTPUT_PATH = path.join(DATA_DIR, "feature-importance.json");

// ── Stat helpers ───────────────────────────────────────────────────────────────

/** Pearson correlation between two equal-length arrays. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  if (denom === 0) return 0;
  return num / denom;
}

// ── Feature list to analyse ────────────────────────────────────────────────────
const FEATURES = [
  "atr",
  "atrPct",
  "adx",
  "rsi",
  "bbWidth",
  "volumeRatio",
  "confidenceScore",
  "ema9",
  "ema21",
  "ema50",
];

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  let query = `
    SELECT
      t."pnlPercent",
      t."entryContext",
      COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy", 'UNKNOWN') AS strategy,
      COALESCE(
        t."entryContext"->'market'->>'regime',
        t."entryContext"->>'htfRegime',
        'unknown'
      ) AS regime
    FROM "Trade" t
    WHERE t."status" = 'CLOSED'
      AND t."entryContext" IS NOT NULL
  `;
  const queryParams = [];

  if (STRATEGY_FILTER) {
    queryParams.push(STRATEGY_FILTER);
    query += ` AND COALESCE(t."entryContext"->>'strategyKey', t."firedByStrategy") = $${queryParams.length}`;
  }
  if (DAYS_FILTER) {
    queryParams.push(DAYS_FILTER);
    query += ` AND t."exitedAt" >= NOW() - ($${queryParams.length} || ' days')::interval`;
  }

  console.log("[feature-importance] Fetching trades...");
  let rows;
  try {
    const res = await pool.query(query, queryParams);
    rows = res.rows;
  } catch (err) {
    console.error("[feature-importance] DB query failed:", err.message);
    process.exit(1);
  }

  console.log(`[feature-importance] Processing ${rows.length} trades`);

  // Group by (strategy, regime)
  const buckets = new Map();
  for (const row of rows) {
    const key = `${row.strategy}||${row.regime}`;
    if (!buckets.has(key)) buckets.set(key, { strategy: row.strategy, regime: row.regime, rows: [] });
    buckets.get(key).rows.push(row);
  }

  const output = [];

  for (const { strategy, regime, rows: bucketRows } of buckets.values()) {
    const n = bucketRows.length;
    if (n < 5) continue; // not enough sample

    // Build outcome array (win=1, loss=0)
    const outcomes = bucketRows.map(r => (r.pnlPercent > 0 ? 1 : 0));

    const featureResults = [];
    for (const feat of FEATURES) {
      const vals = bucketRows.map(r => {
        const ec = r.entryContext;
        if (!ec || typeof ec !== "object") return null;
        const v = ec[feat];
        return (v != null && !isNaN(Number(v))) ? Number(v) : null;
      });

      // Filter out nulls (pair-wise)
      const xs = [], ys = [];
      for (let i = 0; i < n; i++) {
        if (vals[i] != null) { xs.push(vals[i]); ys.push(outcomes[i]); }
      }

      if (xs.length < 5) continue;

      const corr = pearson(xs, ys);
      featureResults.push({
        name:        feat,
        correlation: +corr.toFixed(4),
        sampleSize:  xs.length,
      });
    }

    // Sort by absolute correlation descending
    featureResults.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    output.push({ strategy, regime, features: featureResults });
  }

  // Sort buckets by strategy
  output.sort((a, b) => a.strategy.localeCompare(b.strategy));

  // Persist
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`[feature-importance] Saved: ${OUTPUT_PATH}`);

  // Log top 5 insights
  console.log("\n── Top 5 Insights ──────────────────────────────────────────────");
  let insightCount = 0;
  for (const bucket of output) {
    for (const feat of bucket.features.slice(0, 1)) {
      if (insightCount >= 5) break;
      console.log(
        `  ${bucket.strategy} in ${bucket.regime}: ${feat.name} correlation ${feat.correlation} (n=${feat.sampleSize})`
      );
      insightCount++;
    }
    if (insightCount >= 5) break;
  }

  await pool.end();
}

main().catch(err => {
  console.error("[feature-importance] Fatal:", err);
  process.exit(1);
});
