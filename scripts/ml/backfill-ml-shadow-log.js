#!/usr/bin/env node
"use strict";

/**
 * backfill-ml-shadow-log.js — Populate MLShadowLog from engine `trades` table.
 *
 * MLShadowLog is written live by BotEngineMlHook on open/close. Historical trades
 * (pre-hook, backtest-only, or hook failures) live in `trades` but not MLShadowLog.
 * ml-shadow-report.js reads MLShadowLog only (with actualOutcome set).
 *
 * Usage:
 *   node scripts/ml/backfill-ml-shadow-log.js [--days=30] [--limit=5000] [--dry-run]
 * npm: ml:backfill-shadow-log
 */

require("dotenv").config();

const prisma = require("../../src/infrastructure/db/prismaClient");
const WinPredictor = require("#modules/ml/domain/WinPredictor.js");
const FeatureEngineer = require("#modules/ml/domain/FeatureEngineer.js");
const { _pool } = require("../../src/infrastructure/db/database");
const {
  safeParseJSON,
  indicatorsSnapshotToEntryContext,
  buildExitContextFromEngineRow,
  normalizeStrategyKey,
} = require("#modules/analytics/domain/engineTradeMlAdapter.js");

const DEFAULT_THRESHOLD = parseFloat(process.env.ML_WIN_THRESHOLD || "0.6");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const DAYS  = parseInt(args.days ?? "30", 10);
const LIMIT = parseInt(args.limit ?? "5000", 10);
const DRY   = args["dry-run"] === true || args["dry-run"] === "true";

function resolveEntryContext(row) {
  const entryCtxRaw = row.entry_context
    ? safeParseJSON(row.entry_context)
    : null;
  if (entryCtxRaw && typeof entryCtxRaw === "object" && Object.keys(entryCtxRaw).length > 0) {
    return entryCtxRaw;
  }

  const ind = safeParseJSON(row.indicators);
  const strategyKey = normalizeStrategyKey(
    row.strategy_name ?? ind.strategy ?? ind.firedByStrategy ?? ind.winningComponent
  );
  return indicatorsSnapshotToEntryContext(ind, {
    strategyKey,
    symbol:     row.symbol,
    side:       row.side,
    entryPrice: row.entry_price,
    openTime:   row.open_time,
    marketCond: ind.afMarketCond,
    htfTrend:   ind.htfTrend,
    pairTier:   row.pair_tier ?? "LIQUID",
  });
}

/**
 * Build one MLShadowLog row from a closed engine trade (pure, testable).
 */
function buildShadowLogPayload(row, { pWin, threshold = DEFAULT_THRESHOLD }) {
  const entryContext = resolveEntryContext(row);
  const exitContext  = buildExitContextFromEngineRow(row);
  const strategyKey  = normalizeStrategyKey(
    row.strategy_name
    ?? entryContext.strategyKey
    ?? entryContext.winningComponent
  );
  const prediction = pWin >= threshold ? "win" : "loss";
  const openTime = row.open_time instanceof Date
    ? row.open_time
    : new Date(row.open_time);

  return {
    tradeId:       String(row.id),
    pWin,
    threshold,
    prediction,
    actualOutcome: exitContext.outcome,
    strategyKey,
    symbol:        row.symbol,
    regime:        entryContext.regime ?? entryContext.htfRegime ?? null,
    features:      null, // filled by caller after feature vector build
    createdAt:     openTime,
  };
}

async function fetchClosedEngineTradesForBackfill({ days, limit }) {
  const { rows } = await _pool.query(
    `SELECT id, symbol, side, entry_price, open_time, close_time,
            pnl, pnl_pct, reason, strategy_name, indicators, status,
            entry_context, pair_tier
       FROM trades
      WHERE status = 'closed'
        AND close_time IS NOT NULL
        AND status IS DISTINCT FROM 'cancelled'
        AND open_time > NOW() - ($1 || ' days')::interval
      ORDER BY open_time ASC
      LIMIT $2`,
    [String(days), limit]
  );
  return rows;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   ML Shadow Log Backfill (engine trades → log)   ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`  Days: ${DAYS}  Limit: ${LIMIT}  Dry-run: ${DRY}\n`);

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const rows = await fetchClosedEngineTradesForBackfill({ days: DAYS, limit: LIMIT });
  console.log(`[backfill-shadow] Found ${rows.length} closed engine trades (last ${DAYS}d)`);

  if (rows.length === 0) {
    console.log("[backfill-shadow] Nothing to backfill.");
    await prisma.$disconnect();
    return;
  }

  const tradeIds = rows.map((r) => String(r.id));
  const existing = await prisma.mLShadowLog.findMany({
    where:  { tradeId: { in: tradeIds } },
    select: { tradeId: true },
  });
  const existingSet = new Set(existing.map((e) => e.tradeId));
  const pending = rows.filter((r) => !existingSet.has(String(r.id)));
  console.log(`[backfill-shadow] Already logged: ${existingSet.size}  Pending: ${pending.length}`);

  if (pending.length === 0) {
    console.log("[backfill-shadow] MLShadowLog is up to date for this window.");
    await prisma.$disconnect();
    return;
  }

  const wp = new WinPredictor();
  await wp.load();
  const fe = new FeatureEngineer();

  let inserted = 0;
  let skipped  = 0;

  for (const row of pending) {
    try {
      const entryContext = resolveEntryContext(row);
      const strategyKey  = normalizeStrategyKey(
        row.strategy_name ?? entryContext.strategyKey ?? entryContext.winningComponent
      );
      const features = fe.buildFeatureVector(entryContext, {
        strategyKey,
        symbol: row.symbol,
        side:   row.side,
        regime: entryContext.regime ?? entryContext.htfRegime,
      });
      const { pWin } = wp.predict(features);
      const payload  = buildShadowLogPayload(row, { pWin, threshold: DEFAULT_THRESHOLD });
      payload.features = Array.from(features);

      if (DRY) {
        inserted += 1;
        continue;
      }

      await prisma.mLShadowLog.create({ data: payload });
      inserted += 1;
    } catch (err) {
      skipped += 1;
      console.warn(`[backfill-shadow] Skip trade #${row.id}: ${err.message}`);
    }
  }

  const withOutcome = await prisma.mLShadowLog.count({
    where: {
      createdAt:     { gte: new Date(Date.now() - DAYS * 86400000) },
      actualOutcome: { not: null },
    },
  });

  console.log(`\n[backfill-shadow] ${DRY ? "Would insert" : "Inserted"}: ${inserted}  Skipped: ${skipped}`);
  console.log(`[backfill-shadow] MLShadowLog with outcome (last ${DAYS}d): ${withOutcome}`);
  console.log("[backfill-shadow] Next: node scripts/ml/ml-shadow-report.js --days 30");

  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[backfill-shadow] Fatal:", err.message || err);
    process.exit(1);
  });
}

module.exports = {
  buildShadowLogPayload,
  resolveEntryContext,
  DEFAULT_THRESHOLD,
};
