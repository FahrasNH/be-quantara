/**
 * ParameterDeployService.js — Sprint 4 / WT-4
 *
 * Atomic parameter deployment and rollback for walk-forward suggestions.
 *
 * Feature flag:
 *   PARAMETER_AUTO_TUNING=enabled|disabled
 *   PARAMETER_AUTO_TUNING_<STRATEGY_KEY>=disabled  (per-strategy override)
 *
 * Interface:
 *   applyParameters(suggestionId, userId, options)  → atomic deploy
 *   rollback(strategyKey, symbol, userId)           → revert to previous version
 *   checkAutoRollback(strategyKey, symbol)          → monitor post-deploy PnL
 *   sanityCheck(strategyKey, symbol, params)        → pre-deploy validation
 *   getDeployHistory(strategyKey, symbol, limit)    → audit trail
 */

"use strict";

const prisma    = require("../../infrastructure/db/prismaClient");
const optimizer = require("../../domain/WalkForwardOptimizer");
const { notifyError, notifyInfo } = require("../../infrastructure/notifications/TelegramNotifier");

const AUTO_ROLLBACK_PNL_DROP_THRESHOLD = 0.10; // 10% cumulative PnL drop
const AUTO_ROLLBACK_TRADE_WINDOW       = 50;   // check last N trades after apply
const SANITY_CHECK_DAYS                = 30;
const SANITY_MIN_WR                    = 0.35;
const SANITY_MIN_PF                    = 1.2;

// ── Feature flag helpers ──────────────────────────────────────────────────────

function isAutoTuningEnabled(strategyKey = null) {
  const globalFlag = (process.env.PARAMETER_AUTO_TUNING ?? "enabled").toLowerCase();
  if (globalFlag === "disabled") return false;

  if (strategyKey) {
    const perStrategy = process.env[`PARAMETER_AUTO_TUNING_${strategyKey}`];
    if (perStrategy && perStrategy.toLowerCase() === "disabled") return false;
  }

  return true;
}

// ── Main service ──────────────────────────────────────────────────────────────

class ParameterDeployService {
  /**
   * Apply a ParameterSuggestion atomically.
   * Runs sanity check first; rejects if it fails.
   *
   * @param {string} suggestionId
   * @param {string} userId
   * @param {{ force?: boolean }} options
   * @returns {{ success, parameterId, previousId, appliedAt, error? }}
   */
  async applyParameters(suggestionId, userId, options = {}) {
    if (!isAutoTuningEnabled()) {
      return { success: false, error: "PARAMETER_AUTO_TUNING is disabled" };
    }

    // 1. Load suggestion
    const suggestion = await prisma.parameterSuggestion.findUnique({
      where: { id: suggestionId },
    });

    if (!suggestion) {
      return { success: false, error: "Suggestion not found" };
    }
    if (suggestion.status !== "pending") {
      return { success: false, error: `Suggestion is not pending (status=${suggestion.status})` };
    }
    if (suggestion.expiresAt < new Date()) {
      await prisma.parameterSuggestion.update({
        where: { id: suggestionId },
        data:  { status: "expired" },
      });
      return { success: false, error: "Suggestion has expired" };
    }
    if (!suggestion.sampleSizeValid && !options.force) {
      return {
        success: false,
        error:   `Sample size insufficient (${suggestion.sampleSize} trades < 30). Use force=true to override.`,
      };
    }

    // 2. Pre-deploy sanity check
    const sanity = await this.sanityCheck(
      suggestion.strategyKey,
      suggestion.symbol,
      suggestion.suggestedParams,
    );

    if (!sanity.pass) {
      await prisma.parameterSuggestion.update({
        where: { id: suggestionId },
        data:  { status: "rejected", rejectedAt: new Date() },
      });
      return {
        success: false,
        error:   `Sanity check failed: ${sanity.reason}`,
        metrics: sanity.metrics,
      };
    }

    // 3. Load previous ParameterVersion (for rollback chain)
    const previousVersion = await prisma.parameterVersion.findFirst({
      where:   { strategyKey: suggestion.strategyKey, symbol: suggestion.symbol },
      orderBy: { appliedAt: "desc" },
      select:  { id: true, params: true },
    });

    // 4. Atomic transaction
    let parameterId, appliedAt;
    try {
      const result = await prisma.$transaction(async (tx) => {
        // a. Create ParameterVersion
        const version = await tx.parameterVersion.create({
          data: {
            strategyKey: suggestion.strategyKey,
            symbol:      suggestion.symbol,
            params:      suggestion.suggestedParams,
            source:      "walk_forward",
            appliedBy:   userId,
            previousId:  previousVersion?.id ?? null,
          },
        });

        // b. Update ParameterSuggestion status
        await tx.parameterSuggestion.update({
          where: { id: suggestionId },
          data:  { status: "applied", appliedAt: new Date(), appliedBy: userId },
        });

        // c. Update configOverrides for matching bots
        const bots = await tx.bot.findMany({
          where:  { symbol: suggestion.symbol, strategyKey: suggestion.strategyKey },
          select: { id: true, configOverrides: true },
        });

        for (const bot of bots) {
          const current = (bot.configOverrides ?? {});
          const updated = {
            ...current,
            [suggestion.strategyKey]: suggestion.suggestedParams,
          };
          await tx.bot.update({
            where: { id: bot.id },
            data:  { configOverrides: updated },
          });
        }

        return version;
      });

      parameterId = result.id;
      appliedAt   = result.appliedAt;
    } catch (err) {
      throw new Error(`Atomic transaction failed: ${err.message}`);
    }

    // 5. Notify
    try {
      await notifyInfo(
        `✅ [Parameters] <b>${suggestion.strategyKey}/${suggestion.symbol}</b> applied\n` +
        `Applied by: ${userId}\nSharpe: ${suggestion.validMetrics?.sharpe?.toFixed(3) ?? "?"}`
      );
    } catch (_e) { /* best-effort */ }

    return {
      success:     true,
      parameterId,
      previousId:  previousVersion?.id ?? null,
      appliedAt,
    };
  }

  /**
   * Rollback to the previous ParameterVersion.
   *
   * @param {string} strategyKey
   * @param {string} symbol
   * @param {string} userId
   * @returns {{ success, rolledBackTo, previousVersion }}
   */
  async rollback(strategyKey, symbol, userId) {
    // 1. Load current (most-recent) version
    const current = await prisma.parameterVersion.findFirst({
      where:   { strategyKey, symbol },
      orderBy: { appliedAt: "desc" },
    });

    if (!current) {
      return { success: false, error: "No parameter version found to roll back from" };
    }

    // 2. Load previous via chain
    const previous = current.previousId
      ? await prisma.parameterVersion.findUnique({ where: { id: current.previousId } })
      : null;

    if (!previous) {
      return { success: false, error: "No previous parameter version available for rollback" };
    }

    // 3. Atomic rollback
    const rollbackVersion = await prisma.$transaction(async (tx) => {
      const v = await tx.parameterVersion.create({
        data: {
          strategyKey,
          symbol,
          params:     previous.params,
          source:     "rollback",
          appliedBy:  userId,
          previousId: current.id,
        },
      });

      // Update configOverrides on bots
      const bots = await tx.bot.findMany({
        where:  { symbol, strategyKey },
        select: { id: true, configOverrides: true },
      });

      for (const bot of bots) {
        const updated = {
          ...(bot.configOverrides ?? {}),
          [strategyKey]: previous.params,
        };
        await tx.bot.update({
          where: { id: bot.id },
          data:  { configOverrides: updated },
        });
      }

      return v;
    });

    // 4. Telegram alert
    try {
      await notifyError(
        `🔄 [Parameters] Rolled back <b>${strategyKey}/${symbol}</b>\n` +
        `Rolled back by: ${userId}\nRestored version: ${previous.id}`
      );
    } catch (_e) { /* best-effort */ }

    return {
      success:         true,
      rolledBackTo:    rollbackVersion.id,
      previousVersion: previous.id,
    };
  }

  /**
   * Auto-rollback trigger: called by monitoring.
   * If PnL drops > 10% in the last 50 trades after a parameter change → rollback.
   *
   * @param {string} strategyKey
   * @param {string} symbol
   * @returns {{ triggered: boolean, reason?, result? }}
   */
  async checkAutoRollback(strategyKey, symbol) {
    if (!isAutoTuningEnabled(strategyKey)) {
      return { triggered: false, reason: "auto-tuning disabled" };
    }

    // Find most recent applied parameter change
    const latest = await prisma.parameterVersion.findFirst({
      where:   { strategyKey, symbol, source: "walk_forward" },
      orderBy: { appliedAt: "desc" },
    });

    if (!latest) {
      return { triggered: false, reason: "no walk_forward version found" };
    }

    // Load last N trades after the parameter was applied
    const trades = await prisma.trade.findMany({
      where: {
        symbol,
        firedByStrategy: strategyKey,
        status:    "CLOSED",
        enteredAt: { gte: latest.appliedAt },
      },
      orderBy: { enteredAt: "asc" },
      take:    AUTO_ROLLBACK_TRADE_WINDOW,
      select:  { pnlPercent: true },
    });

    if (trades.length < 10) {
      return { triggered: false, reason: "insufficient trades for auto-rollback check" };
    }

    const totalPnl    = trades.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0);
    const avgPnl      = totalPnl / trades.length;
    const pnlDropPct  = Math.abs(Math.min(0, avgPnl));

    if (pnlDropPct < AUTO_ROLLBACK_PNL_DROP_THRESHOLD) {
      return { triggered: false, reason: `PnL drop ${(pnlDropPct * 100).toFixed(1)}% below threshold` };
    }

    // Trigger auto-rollback
    const result = await this.rollback(strategyKey, symbol, "system:auto-rollback");

    return { triggered: true, reason: `PnL drop ${(pnlDropPct * 100).toFixed(1)}% exceeded ${AUTO_ROLLBACK_PNL_DROP_THRESHOLD * 100}%`, result };
  }

  /**
   * Pre-deploy sanity check: simulate on last SANITY_CHECK_DAYS of trades.
   * @returns {{ pass: boolean, metrics, reason }}
   */
  async sanityCheck(strategyKey, symbol, params) {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - SANITY_CHECK_DAYS);

    const trades = await prisma.trade.findMany({
      where: {
        symbol,
        firedByStrategy: strategyKey,
        status:    "CLOSED",
        enteredAt: { gte: since },
      },
      select: { pnl: true, pnlPercent: true, side: true, entryContext: true, enteredAt: true },
    });

    if (trades.length === 0) {
      return { pass: true, metrics: null, reason: "no trades in sanity window (pass by default)" };
    }

    const metrics = optimizer.simulateTrades(trades, strategyKey, params);

    const pass = metrics.winRate >= SANITY_MIN_WR && metrics.profitFactor >= SANITY_MIN_PF;
    const reason = pass
      ? "OK"
      : `WR=${(metrics.winRate * 100).toFixed(1)}% (min ${SANITY_MIN_WR * 100}%), PF=${metrics.profitFactor.toFixed(2)} (min ${SANITY_MIN_PF})`;

    return { pass, metrics, reason };
  }

  /**
   * Get deploy history for a strategy+symbol pair.
   * @returns {Promise<object[]>}
   */
  async getDeployHistory(strategyKey, symbol, limit = 20) {
    return prisma.parameterVersion.findMany({
      where:   { strategyKey, symbol: symbol ?? undefined },
      orderBy: { appliedAt: "desc" },
      take:    limit,
    });
  }
}

module.exports = new ParameterDeployService();
module.exports.ParameterDeployService = ParameterDeployService;
module.exports.isAutoTuningEnabled    = isAutoTuningEnabled;
