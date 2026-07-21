"use strict";

/**
 * MLShadowService.js — Sprint 5 / RL-4, enhanced Sprint 6 / RAG-SHADOW-1
 *
 * Shadow mode: logs ML predictions alongside real trades for evaluation.
 * All predictions are fire-and-forget (<10ms). Provides weekly analysis reports
 * and promotion readiness checks.
 *
 * Sprint 6 additions:
 * - computeAUC(predictions) — standalone AUC from logged predictions
 * - checkReadinessThresholds() — AUC>=0.65, Accuracy>=50%, Precision>=55%
 * - Auto-log to console every 100 predictions
 * - Auto-start support via MLShadowService.autoStart()
 */

const prisma = require("../../../infrastructure/db/prismaClient");

const DEFAULT_THRESHOLD = 0.6;

// Sprint 6: promoted readiness thresholds
const THRESHOLDS = {
  auc:       0.65,
  accuracy:  0.50,
  precision: 0.55,
  tradeCount: 1000,
};

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
    this._predictionCount = 0; // in-process counter for auto-log every 100
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

      // Auto-log every 100 predictions (Sprint 6)
      this._predictionCount++;
      if (this._predictionCount % 100 === 0) {
        this._logAutoStatus().catch(() => {});
      }

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

    const auc = this.computeAUC(logs);

    const accuracy = (tp + tn) / logs.length;
    const mlWR     = labels.filter(Boolean).length / logs.length;
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
   * Sprint 6: Compute AUC (Area Under ROC Curve) from an array of shadow log entries.
   * Uses rank-based trapezoidal AUC computation (no external library needed).
   *
   * @param {Array<{pWin: number, actualOutcome: string}>} predictions
   * @returns {number} AUC value in [0, 1]
   */
  computeAUC(predictions) {
    if (!Array.isArray(predictions) || predictions.length === 0) return 0.5;

    const pairs = predictions
      .filter((p) => p.actualOutcome === "win" || p.actualOutcome === "loss")
      .map((p) => ({
        y: p.actualOutcome === "win" ? 1 : 0,
        s: typeof p.pWin === "number" ? p.pWin : 0.5,
      }));

    if (pairs.length === 0) return 0.5;

    const pos = pairs.filter((p) => p.y === 1).length;
    const neg = pairs.length - pos;

    if (pos === 0 || neg === 0) return 0.5;

    // Sort by score descending
    pairs.sort((a, b) => b.s - a.s);

    let cumPos = 0, cumNeg = 0, prevFpr = 0, prevTpr = 0, auc = 0;
    for (const { y } of pairs) {
      if (y) cumPos++; else cumNeg++;
      const tpr = cumPos / pos;
      const fpr = cumNeg / neg;
      auc += Math.abs(fpr - prevFpr) * (tpr + prevTpr) / 2;
      prevFpr = fpr;
      prevTpr = tpr;
    }

    return Math.min(1, Math.max(0, auc));
  }

  /**
   * Sprint 6: Check all Sprint 6 readiness thresholds.
   * AUC >= 0.65, Accuracy >= 50%, Precision >= 55%.
   *
   * @returns {Promise<{ auc, accuracy, precision, tradeCount, ready, failures }>}
   */
  async checkReadinessThresholds() {
    const thirtyDaysAgo = new Date(Date.now() - 90 * 86400000); // 90-day window for sprint 6

    const logs = await prisma.mLShadowLog.findMany({
      where: {
        createdAt:     { gte: thirtyDaysAgo },
        actualOutcome: { not: null },
      },
      orderBy: { createdAt: "asc" },
    });

    const tradeCount = logs.length;

    if (tradeCount === 0) {
      return {
        auc: 0, accuracy: 0, precision: 0,
        tradeCount: 0, ready: false,
        failures: ["No trades logged yet"],
      };
    }

    // AUC
    const auc = this.computeAUC(logs);

    // Accuracy = (TP + TN) / total
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const log of logs) {
      const pred   = log.prediction === "win" ? 1 : 0;
      const actual = log.actualOutcome === "win" ? 1 : 0;
      if (pred === 1 && actual === 1) tp++;
      else if (pred === 1 && actual === 0) fp++;
      else if (pred === 0 && actual === 0) tn++;
      else fn++;
    }

    const accuracy  = (tp + tn) / tradeCount;
    const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;

    const failures = [];
    if (auc < THRESHOLDS.auc)
      failures.push(`AUC ${auc.toFixed(3)} < ${THRESHOLDS.auc} required`);
    if (accuracy < THRESHOLDS.accuracy)
      failures.push(`Accuracy ${(accuracy * 100).toFixed(1)}% < ${THRESHOLDS.accuracy * 100}% required`);
    if (precision < THRESHOLDS.precision)
      failures.push(`Precision ${(precision * 100).toFixed(1)}% < ${THRESHOLDS.precision * 100}% required`);
    if (tradeCount < THRESHOLDS.tradeCount)
      failures.push(`Trade count ${tradeCount} < ${THRESHOLDS.tradeCount} required`);

    const ready = failures.length === 0;

    return {
      auc:        +auc.toFixed(4),
      accuracy:   +accuracy.toFixed(4),
      precision:  +precision.toFixed(4),
      tradeCount,
      ready,
      failures,
      thresholds: THRESHOLDS,
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

    const mlPredWins = logs.filter((l) => l.prediction === "win");
    const rl3WinRate = mlPredWins.length > 0
      ? mlPredWins.filter((l) => l.actualOutcome === "win").length / mlPredWins.length
      : 0;

    const ms1WinRate = logs.filter((l) => l.actualOutcome === "win").length / logs.length;

    const recommendation = rl3WinRate > ms1WinRate + 0.05 ? "promote_rl3" : "keep_ms1";

    return { rl3WinRate, ms1WinRate, rl3Sharpe: 0, ms1Sharpe: 0, recommendation };
  }

  // ── Sprint 6: Auto-log helper ─────────────────────────────────────────────

  async _logAutoStatus() {
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
      const logs = await prisma.mLShadowLog.findMany({
        where:   { createdAt: { gte: thirtyDaysAgo }, actualOutcome: { not: null } },
        orderBy: { createdAt: "asc" },
        take:    500,
      });
      const n   = await prisma.mLShadowLog.count();
      const auc = logs.length > 0 ? this.computeAUC(logs) : 0.5;
      console.log(`[MLShadow] ${n} predictions logged, AUC=${auc.toFixed(2)} (last 30d sample: ${logs.length})`);
    } catch {
      // non-critical — suppress errors
    }
  }

  // ── Sprint 6: Static auto-start factory ──────────────────────────────────

  /**
   * Create and start a singleton MLShadowService using lazy-loaded dependencies.
   * Safe to call at server boot — dependencies are loaded lazily.
   *
   * @returns {MLShadowService|null}
   */
  static autoStart() {
    try {
      const WinPredictor    = require("../domain/WinPredictor");
      const FeatureEngineer = require("../domain/FeatureEngineer");

      const wp = new WinPredictor();
      wp.load().catch(() => {}); // async, fire-and-forget

      // VectorStore/pgvector is optional — shadow log writes must not depend on it.
      let vs = null;
      try {
        const VectorStore = require("../../../infrastructure/db/VectorStore");
        const { _pool }   = require("../../../infrastructure/db/database");
        if (_pool) vs = new VectorStore(_pool);
      } catch {
        vs = null;
      }

      const fe      = new FeatureEngineer();
      const service = new MLShadowService(wp, vs, fe);

      console.log("[MLShadowService] Auto-started in shadow mode");
      return service;
    } catch (err) {
      console.warn(`[MLShadowService] autoStart failed (non-fatal): ${err.message}`);
      return null;
    }
  }
}

module.exports = MLShadowService;
