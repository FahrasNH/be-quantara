#!/usr/bin/env node
/**
 * backfill-regime.js — Sprint 2 / RC-2
 *
 * Backfills regime classification into Trade.entryContext for historical trades
 * that were created before the RegimeClassifierEngine existed.
 *
 * Usage:
 *   node scripts/backfill-regime.js           # live run
 *   node scripts/backfill-regime.js --dry-run # preview only, no DB writes
 *
 * npm script: scripts:backfill-regime
 */

"use strict";

const path   = require("path");
const fs     = require("fs");
const prisma = require("../src/infrastructure/db/prismaClient");
const { RegimeClassifierEngine } = require("#core/signal-engine/RegimeClassifierEngine.js");

// ── CLI flags ──────────────────────────────────────────────────────────────────
const DRY_RUN   = process.argv.includes("--dry-run");
const BATCH_SZ  = 100;

// ── Paths ──────────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "../data");
const REPORT_PATH     = path.join(DATA_DIR, "backfill-regime-report.json");
const CHECKPOINT_PATH = path.join(DATA_DIR, "backfill-regime-checkpoint.json");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      const raw = fs.readFileSync(CHECKPOINT_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch (_e) { /* ignore */ }
  return { lastProcessedId: null, processedCount: 0 };
}

function saveCheckpoint(checkpoint) {
  if (DRY_RUN) return;
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2));
}

function saveReport(report) {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

/**
 * Reconstruct regime indicator inputs from entryContext alone.
 * In production the caller would fetch actual candle data from CCXT,
 * but the indicators we need (EMA9/21/50, ADX, ATR, volume) are already
 * persisted in entryContext by TradeFeatureCollector, so we read them directly.
 */
function buildIndicatorsFromContext(ec) {
  return {
    ema9:   ec.ema9   ?? null,
    ema21:  ec.ema21  ?? null,
    ema50:  ec.ema50  ?? null,
    adx:    ec.adx    ?? null,
    atr:    ec.atr    ?? null,
    // atrAvg: not stored; approximate as atr (gives ratio = 1.0 → no modifier) 
    atrAvg: ec.atrAvg ?? ec.atr ?? null,
    volume: ec.volume24h ?? null,
    // volAvg: approximate via volumeRatio back-calc if possible
    volAvg: (ec.volume24h != null && ec.volumeRatio != null && ec.volumeRatio > 0)
      ? ec.volume24h / ec.volumeRatio
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  ensureDataDir();

  const engine     = new RegimeClassifierEngine();
  const checkpoint = loadCheckpoint();

  const report = {
    startedAt:  new Date().toISOString(),
    dryRun:     DRY_RUN,
    total:      0,
    success:    0,
    failed:     0,
    skipped:    0,
    batches:    0,
    finishedAt: null,
  };

  console.log(`[backfill-regime] Starting${DRY_RUN ? " DRY-RUN" : ""}`);
  console.log(`[backfill-regime] Resuming from: ${checkpoint.lastProcessedId ?? "beginning"} (processed so far: ${checkpoint.processedCount})`);

  let cursor = checkpoint.lastProcessedId;
  let hasMore = true;

  while (hasMore) {
    // Build query: find trades with entryContext but no regime in market sub-object
    const whereClause = {
      entryContext: { not: null },
      status:       "CLOSED",
      ...(cursor ? { id: { gt: cursor } } : {}),
    };

    const batch = await prisma.trade.findMany({
      where:   whereClause,
      orderBy: { id: "asc" },
      take:    BATCH_SZ,
      select:  { id: true, symbol: true, entryContext: true, firedByStrategy: true },
    });

    if (batch.length === 0) {
      hasMore = false;
      break;
    }

    report.batches++;

    // Filter: only those missing market.regime
    const toProcess = batch.filter(t => {
      const ec = t.entryContext;
      if (!ec || typeof ec !== "object") return false;
      // Skip if already has regime
      if (ec.market?.regime) return false;
      if (ec.regime) return false;
      return true;
    });

    const toSkip = batch.length - toProcess.length;
    report.total   += batch.length;
    report.skipped += toSkip;

    if (toProcess.length > 0) {
      // Process batch atomically
      const updates = [];
      const batchErrors = [];

      for (const trade of toProcess) {
        try {
          const ec       = trade.entryContext;
          const symbol   = trade.symbol ?? ec.symbol ?? "UNKNOWN";
          const strategy = trade.firedByStrategy ?? ec.strategyKey ?? "UNKNOWN";

          const indicators = buildIndicatorsFromContext(ec);

          // Invalidate cache before classifying so each trade is fresh
          engine.invalidateCache(symbol);
          const classified = engine.classify(indicators, symbol, "1h");

          const updatedEc = {
            ...ec,
            market: {
              ...(ec.market ?? {}),
              regime:      classified.composite,
              regimeMeta:  {
                primary:    classified.primary,
                modifier:   classified.modifier,
                confidence: classified.confidence,
                classifiedAt: new Date().toISOString(),
              },
            },
          };

          updates.push({ id: trade.id, entryContext: updatedEc });
        } catch (err) {
          console.error(`[backfill-regime] Error building update for ${trade.id}:`, err.message);
          batchErrors.push(trade.id);
          report.failed++;
        }
      }

      if (DRY_RUN) {
        console.log(`[backfill-regime] DRY-RUN batch ${report.batches}: would update ${updates.length} trades`);
        report.success += updates.length;
      } else {
        // Atomic per-batch via transaction
        try {
          await prisma.$transaction(
            updates.map(u =>
              prisma.trade.update({
                where: { id: u.id },
                data:  { entryContext: u.entryContext },
              })
            )
          );
          report.success += updates.length;
          console.log(`[backfill-regime] Batch ${report.batches}: updated ${updates.length} trades (${batchErrors.length} errors)`);
        } catch (txErr) {
          console.error(`[backfill-regime] Batch ${report.batches} transaction FAILED (rollback):`, txErr.message);
          report.failed += updates.length;
        }
      }
    } else {
      console.log(`[backfill-regime] Batch ${report.batches}: ${toSkip} trades already classified, skipped`);
    }

    // Advance cursor to last record in this batch
    cursor = batch[batch.length - 1].id;
    checkpoint.lastProcessedId = cursor;
    checkpoint.processedCount  = (checkpoint.processedCount ?? 0) + batch.length;
    saveCheckpoint(checkpoint);

    if (batch.length < BATCH_SZ) {
      hasMore = false;
    }
  }

  report.finishedAt = new Date().toISOString();
  saveReport(report);

  const pct = report.total > 0 ? ((report.success / report.total) * 100).toFixed(1) : "0.0";
  console.log(`\n[backfill-regime] Done${DRY_RUN ? " (DRY-RUN)" : ""}`);
  console.log(`  Total    : ${report.total}`);
  console.log(`  Success  : ${report.success} (${pct}%)`);
  console.log(`  Failed   : ${report.failed}`);
  console.log(`  Skipped  : ${report.skipped}`);
  console.log(`  Report   : ${REPORT_PATH}`);

  if (!DRY_RUN && report.total > 0 && report.success / report.total < 0.9) {
    console.warn("[backfill-regime] WARNING: success rate < 90%");
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error("[backfill-regime] Fatal error:", err);
  process.exit(1);
});
