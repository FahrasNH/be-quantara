"use strict";

/**
 * MLShadowService.js — Sprint 5 / RL-4
 *
 * Shadow mode: logs ML predictions alongside real trades for evaluation.
 * All predictions are fire-and-forget (<10ms). Provides weekly analysis reports
 * and promotion readiness checks.
 */

const prisma = require("../../infrastructure/db/prismaClient");

const DEFAULT_THRESHOLD = 0.6;

class MLShadowService {
  /**
   * @param {import('../domain/WinPredictor')} winPredictor
   * @param {import('../infrastructure/db/VectorStore')} vectorStore
   * @param {import('../domain/FeatureEngineer')} featureEngineer
   */
  constructor(winPredictor, vectorStore, featureEngineer) {
    this.winPredictor   = winPredictor;
    this.vectorStore    = vectorStore;
    this.featureEngineer = featureEngineer;
    this.threshold       = parseFloat(process.env.ML_WIN_THRESHOLD || DEFAULT_THRESHOLD);
  }

  // ── Prediction logging ────────────────────────────────────────────────────

  /**
   * Log shadow prediction at trade entry (fire-and-forget, <10ms path).
   * @param {string} tradeId
   * @param {object} entryContext
   * @param {object} tradeMetadata — { strategyKey, symbol, regime }
   */
  async logPrediction(tradeId, entryContext, tradeMetadata = {}) {
    try {
      const features = this.featureEngineer.buildFeatureVector(entryContext, tradeMetadata);
      const { pWin } = this.winPredictor.predict(features);

      const prediction = pWin >= this.threshold ? "win" : "loss";

      await prisma.mLShadowLog.create({
        data: {
          tradeId:     tradeId || null,
          pWin,
          threshold:   this.threshold,
          prediction,
          strategyKey: tradeMetadata.strategyKey || null,
          symbol:      tradeMetadata.symbol      || null,
          regime:      tradeMetadata.regime      || entryContext?.regime || null,
          features:    Array.from(features),
        },
      });

      // Also store in VectorStore for similarity search (best-effort)
      if (tradeId && this.vectorStore) {
        this.vectorStore.upsertEmbedding(tradeId, features, {
          strategyKey: tradeMetadata.strategyKey,
          symbol:      tradeMetadata.symbol,
          regime:      tradeMetadata.regime || entryContext?.regime,
          timestamp:   new Date().toISOString(),
        }).catch(() => {});
      }
    } catch (err) {
      console.warn(`[MLShadowService] logPrediction failed: ${err.message}`);
    }
  }

  /**
   * Record actual outcome after trade close.
   * @param {string} tradeId
   * @param {'win'|'loss'} outcome
   */
  async recordOutcome(tradeId, outcome) {
    if (!tradeId) return;
    try {
      await prisma.mLShadowLog.updateMany({
        where:  { tradeId },
        data:   { actualOutcome: outcome },
      });

      // Update VectorStore metadata with outcome (best-effort)
      if (this.vectorStore) {
        const logs = await prisma.mLShadowLog.findMany({ where: { tradeId }, take: 1 });
        if (logs.length > 0) {
          const log = logs[0];
          const meta = {
            strategyKey: log.strategyKey,
            symbol:      log.symbol,
            regime:      log.regime,
            outcome,
            timestamp:   log.createdAt?.toISOString(),
          };
          if (log.features) {
            await this.vectorStore.upsertEmbedding(tradeId, log.features, meta).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.warn(`[MLShadowService] recordOutcome failed: ${err.message}`);
    }
  }

  // ── Analysis ───────────────────────────────────────────────────────────────

  /**
   * Generate weekly analysis report.
   * @param {Date|string} weekStart
   * @param {Date|string} weekEnd
   * @returns {{ auc, accuracy, confusionMatrix, sharpeDiff, wRateDiff }}
   */
  async generateWeeklyReport(weekStart, weekEnd) {
    const start = new Date(weekStart);
    const end   = new Date(weekEnd);

    const logs = await prisma.mLShadowLog.findMany({
      where: {
        createdAt:     { gte: start, lte: end },
        actualOutcome: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });

    if (logs.length === 0) {
      return {
        auc: 0.5, accuracy: 0, confusionMatrix: { tp: 0, fp: 0, tn: 0, fn: 0 },
        sharpeDiff: 0, wRateDiff: 0, tradeCount: 0,
      };
    }

    const labels  = logs.map((l) => l.actualOutcome === "win" ? 1 : 0);
    const scores  = logs.map((l) => l.pWin);
    const predWin = logs.map((l) => l.prediction === "win" ? 1 : 0);

    // Confusion matrix
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (let i = 0; i < logs.length; i++) {
      if (predWin[i] === 1 && labels[i] === 1) tp++;
      else if (predWin[i] === 1 && labels[i] === 0) fp++;
      else if (predWin[i] === 0 && labels[i] === 0) tn++;
      else fn++;
    }

    // AUC (simple rank-based)
    const pos = labels.filter(Boolean).length;
    const neg = labels.length - pos;
    let auc = 0.5;
    if (pos > 0 && neg > 0) {
      const pairs = labels.map((y, i) => ({ y, s: scores[i] })).sort((a, b) => b.s - a.s);
      let cumPos = 0, cumNeg = 0, prevFpr = 0, prevTpr = 0;
      for (const { y } of pairs) {
        if (y) cumPos++; else cumNeg++;
        const tpr = cumPos / pos, fpr = cumNeg / neg;
        auc += Math.abs(fpr - prevFpr) * (tpr + prevTpr) / 2;
        prevFpr = fpr; prevTpr = tpr;
      }
    }

    const accuracy = (tp + tn) / logs.length;
    const mlWR     = pos / logs.length;
    const allWR    = labels.filter(Boolean).length / labels.length;

    return {
      auc:            Math.min(1, Math.max(0, auc)),
      accuracy,
      confusionMatrix: { tp, fp, tn, fn },
      sharpeDiff:     0, // requires PnL data — placeholder
      wRateDiff:      mlWR - allWR,
      tradeCount:     logs.length,
      period:         { start: start.toISOString(), end: end.toISOString() },
    };
  }

  /**
   * Check whether the ML model is ready for promotion to advisory mode.
   * @returns {{ ready, reason, tradeCount, auc, sharpeDiff }}
   */
  async checkPromotionReadiness() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
    const report = await this.generateWeeklyReport(thirtyDaysAgo, new Date());

    const ready = report.tradeCount >= 50 && report.auc >= 0.60;
    const reason = !ready
      ? report.tradeCount < 50
        ? `Insufficient data: ${report.tradeCount} trades (need >= 50)`
        : `AUC too low: ${report.auc.toFixed(3)} (need >= 0.60)`
      : "Promotion criteria met";

    return {
      ready,
      reason,
      tradeCount: report.tradeCount,
      auc:        report.auc,
      sharpeDiff: report.sharpeDiff,
    };
  }

  /**
   * Compare ML predictions vs rule-based MetaSelector outcomes.
   * @returns {{ rl3WinRate, ms1WinRate, recommendation }}
   */
  async compareWithRuleBased(weekStart, weekEnd) {
    const start = new Date(weekStart);
    const end   = new Date(weekEnd);

    const logs = await prisma.mLShadowLog.findMany({
      where: { createdAt: { gte: start, lte: end }, actualOutcome: { not: null } },
    });

    if (logs.length === 0) {
      return { rl3WinRate: 0, ms1WinRate: 0, rl3Sharpe: 0, ms1Sharpe: 0, recommendation: "insufficient_data" };
    }

    // ML win rate among trades where ML predicted 'win'
    const mlPredWins = logs.filter((l) => l.prediction === "win");
    const rl3WinRate = mlPredWins.length > 0
      ? mlPredWins.filter((l) => l.actualOutcome === "win").length / mlPredWins.length
      : 0;

    // Overall baseline WR
    const ms1WinRate = logs.filter((l) => l.actualOutcome === "win").length / logs.length;

    const recommendation = rl3WinRate > ms1WinRate + 0.05 ? "promote_rl3" : "keep_ms1";

    return { rl3WinRate, ms1WinRate, rl3Sharpe: 0, ms1Sharpe: 0, recommendation };
  }
}

module.exports = MLShadowService;
