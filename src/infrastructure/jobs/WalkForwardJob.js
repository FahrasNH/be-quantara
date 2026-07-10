/**
 * WalkForwardJob.js — Sprint 4 / WT-3
 *
 * Weekly scheduled job that runs WalkForwardOptimizer for every
 * active (strategy × symbol) combination and saves results as
 * ParameterSuggestion rows (status = 'pending').
 *
 * Features:
 *  - Incremental: skips combos with no new trades since last run
 *  - Checkpoint: saves/loads progress to data/walk-forward-checkpoint.json
 *  - Dry-run: --dryRun flag prevents any DB writes
 *  - Consecutive failure alerting (2+ failures → Telegram)
 *  - Per-combo error isolation: one failure does not stop the whole job
 *
 * Scheduled by performanceAggregationCron.js (Sunday 23:00 UTC).
 *
 * Standalone:
 *   node -e "require('./src/infrastructure/jobs/WalkForwardJob').runStandalone()"
 *   node -e "require('./src/infrastructure/jobs/WalkForwardJob').runStandalone({ dryRun: true })"
 */

"use strict";

const fs      = require("fs");
const path    = require("path");
const prisma  = require("../db/prismaClient");
const { notifyError, notifyInfo } = require("../notifications/TelegramNotifier");
const optimizer = require("../../domain/WalkForwardOptimizer");

const CHECKPOINT_FILE = path.resolve(
  __dirname, "../../../data/walk-forward-checkpoint.json"
);

const SUGGESTION_TTL_DAYS = 7;
const SIGNIFICANT_IMPROVEMENT_THRESHOLD = 0.05; // +5% Sharpe
const LOG_EVERY_N_COMBOS = 10;

// ── Consecutive failure tracking ─────────────────────────────────────────────
let _consecutiveFailures = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg, ...args) {
  console.log(`[WalkForwardJob] ${msg}`, ...args);
}

function logError(msg, err) {
  console.error(`[WalkForwardJob] ${msg}`, err?.message ?? err);
}

async function alertJobFailure(err) {
  try {
    await notifyError(`⚠️ [WalkForwardJob] Job failed\n\n<code>${err?.message ?? err}</code>`);
  } catch (_e) { /* swallow */ }
}

function expiresAt() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + SUGGESTION_TTL_DAYS);
  return d;
}

// ── Checkpoint ────────────────────────────────────────────────────────────────

class WalkForwardJob {
  async saveCheckpoint(progress) {
    try {
      const dir = path.dirname(CHECKPOINT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(progress, null, 2));
    } catch (err) {
      logError("Failed to save checkpoint:", err);
    }
  }

  async loadCheckpoint() {
    try {
      if (!fs.existsSync(CHECKPOINT_FILE)) return null;
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8"));
    } catch (_e) {
      return null;
    }
  }

  async clearCheckpoint() {
    try {
      if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE);
    } catch (_e) { /* best-effort */ }
  }

  // ── shouldRecompute ─────────────────────────────────────────────────────────

  /**
   * Returns true if there are any trades for this combo that were entered
   * after the most recent ParameterSuggestion for this strategy+symbol.
   */
  async shouldRecompute(strategyKey, symbol) {
    const latest = await prisma.parameterSuggestion.findFirst({
      where:   { strategyKey, symbol },
      orderBy: { createdAt: "desc" },
      select:  { createdAt: true },
    });

    const since = latest?.createdAt ?? new Date(0);

    const count = await prisma.trade.count({
      where: {
        symbol,
        firedByStrategy: strategyKey,
        status:    "CLOSED",
        enteredAt: { gt: since },
      },
    });

    return count > 0;
  }

  // ── Main run ────────────────────────────────────────────────────────────────

  /**
   * @param {{ dryRun?: boolean }} options
   */
  async run(options = {}) {
    const { dryRun = false } = options;
    const startedAt = new Date();
    log(`Starting walk-forward job ${dryRun ? "(DRY RUN)" : ""} at ${startedAt.toISOString()}`);

    // 1. Expire old pending suggestions
    if (!dryRun) {
      try {
        const expired = await prisma.parameterSuggestion.updateMany({
          where:  { status: "pending", expiresAt: { lt: new Date() } },
          data:   { status: "expired" },
        });
        if (expired.count > 0) log(`Expired ${expired.count} old pending suggestions`);
      } catch (err) {
        logError("Failed to expire old suggestions:", err);
      }
    }

    // 2. Load active (strategy × symbol) combos from running bots
    let combos = [];
    try {
      const bots = await prisma.bot.findMany({
        where:  { running: true },
        select: { strategyKey: true, symbol: true, strategyGroup: true },
      });

      const seen = new Set();
      for (const bot of bots) {
        const strategies = bot.strategyGroup?.length > 0
          ? bot.strategyGroup
          : [bot.strategyKey];
        for (const sk of strategies) {
          if (!sk || sk === "ADAPTIVE_FUSION") continue; // skip legacy key
          const key = `${sk}:${bot.symbol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          combos.push({ strategyKey: sk, symbol: bot.symbol });
        }
      }
    } catch (err) {
      logError("Failed to load bot combos:", err);
      _consecutiveFailures++;
      if (_consecutiveFailures >= 2) await alertJobFailure(err);
      throw err;
    }

    if (combos.length === 0) {
      log("No active bot combos found — skipping");
      await this.clearCheckpoint();
      return { processed: 0, created: 0, skipped: 0, errors: 0, dryRun };
    }

    // 3. Resume from checkpoint if available
    const checkpoint = await this.loadCheckpoint();
    const completedKeys = new Set(checkpoint?.completed ?? []);
    const pending = combos.filter(c => !completedKeys.has(`${c.strategyKey}:${c.symbol}`));
    log(`Combos: ${combos.length} total, ${pending.length} pending (${completedKeys.size} already done)`);

    let processed = 0, created = 0, skipped = 0, errors = 0;

    for (let i = 0; i < pending.length; i++) {
      const { strategyKey, symbol } = pending[i];
      const comboKey = `${strategyKey}:${symbol}`;

      try {
        // Incremental check
        const needsRecompute = await this.shouldRecompute(strategyKey, symbol);
        if (!needsRecompute) {
          log(`Skipping ${comboKey} — no new trades`);
          skipped++;
          completedKeys.add(comboKey);
          continue;
        }

        log(`Optimizing ${comboKey} (${i + 1}/${pending.length})`);
        const result = await optimizer.optimize(strategyKey, symbol);

        processed++;

        if (!result.bestParams) {
          log(`No valid params found for ${comboKey}`);
          completedKeys.add(comboKey);
          continue;
        }

        // 4. Check if significantly better than current baseline
        const currentBest = await prisma.parameterSuggestion.findFirst({
          where:   { strategyKey, symbol, status: "applied" },
          orderBy: { appliedAt: "desc" },
          select:  { validMetrics: true },
        });

        const currentSharpe = currentBest?.validMetrics?.sharpe ?? 0;
        const newSharpe      = result.validationMetrics?.sharpe  ?? 0;
        const improved       = newSharpe - currentSharpe > SIGNIFICANT_IMPROVEMENT_THRESHOLD;

        if (!dryRun) {
          const sampleSize = result.iteration?.trainTrades ?? 0;
          await prisma.parameterSuggestion.create({
            data: {
              strategyKey,
              symbol,
              suggestedParams: result.bestParams,
              currentParams:   currentBest ? {} : null,
              trainMetrics:    result.trainMetrics   ?? {},
              validMetrics:    result.validationMetrics ?? {},
              trainDays:       result.iteration?.trainDays  ?? 90,
              validDays:       result.iteration?.validDays  ?? 30,
              sampleSize,
              sampleSizeValid: sampleSize >= 30,
              status:          "pending",
              expiresAt:       expiresAt(),
            },
          });
          created++;

          if (improved) {
            await notifyInfo(
              `📈 [WalkForward] <b>${strategyKey}/${symbol}</b> improved\n` +
              `Sharpe: ${currentSharpe.toFixed(3)} → ${newSharpe.toFixed(3)} (+${((newSharpe - currentSharpe) * 100).toFixed(1)}%)`
            );
          }
        } else {
          log(`[DRY RUN] Would create suggestion for ${comboKey}: Sharpe=${newSharpe.toFixed(3)}`);
          created++;
        }

      } catch (err) {
        logError(`Error processing ${comboKey}:`, err);
        errors++;
      }

      completedKeys.add(comboKey);

      // Progress log every N combos
      if ((i + 1) % LOG_EVERY_N_COMBOS === 0) {
        log(`Progress: ${i + 1}/${pending.length} — created=${created} skipped=${skipped} errors=${errors}`);
        await this.saveCheckpoint({ completed: [...completedKeys], updatedAt: new Date().toISOString() });
      }
    }

    await this.clearCheckpoint();
    _consecutiveFailures = 0;

    const duration = ((Date.now() - startedAt.getTime()) / 1000).toFixed(1);
    log(`Done in ${duration}s — processed=${processed} created=${created} skipped=${skipped} errors=${errors}`);

    return { processed, created, skipped, errors, dryRun, durationSec: parseFloat(duration) };
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

const instance = new WalkForwardJob();

module.exports = instance;
module.exports.WalkForwardJob = WalkForwardJob;

/**
 * Standalone entry point:
 *   node -e "require('./src/infrastructure/jobs/WalkForwardJob').runStandalone()"
 */
module.exports.runStandalone = async function runStandalone(opts = {}) {
  try {
    const result = await instance.run(opts);
    console.log("[WalkForwardJob] Standalone result:", JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("[WalkForwardJob] Standalone failed:", err.message);
    process.exit(1);
  }
};
