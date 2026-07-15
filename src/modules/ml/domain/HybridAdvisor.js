"use strict";

/**
 * HybridAdvisor.js — Sprint 5 / RL-6
 *
 * Blends MetaSelectorEngine (MS-1, rule-based) scores with WinPredictor (RL-3, ML) scores.
 * Supports three phases via environment variables:
 *
 *   Phase 1 SHADOW:   WEIGHT_RL3=0.0, ML_ADVISOR_MODE=shadow   (log only, no influence)
 *   Phase 2 ADVISORY: WEIGHT_RL3=0.2, ML_ADVISOR_MODE=advisory (show in UI)
 *   Phase 3 ACTIVE:   WEIGHT_RL3=0.5, ML_ADVISOR_MODE=active   (influence selection)
 *
 * Auto-revert: if last 50 trades show Sharpe drop > 20% → reset WEIGHT_RL3=0.0 + Telegram alert.
 */

const prisma = require("../../../infrastructure/db/prismaClient");
const { notifyError } = require("../../../infrastructure/notifications/TelegramNotifier");

const DEFAULT_WEIGHT_RL3 = parseFloat(process.env.WEIGHT_RL3 ?? "0.0");
const VALID_MODES        = ["shadow", "advisory", "active"];

class HybridAdvisor {
  /**
   * @param {object} metaSelector — MetaSelectorEngine instance
   * @param {import('./WinPredictor')} winPredictor
   * @param {import('./FeatureEngineer')} featureEngineer
   */
  constructor(metaSelector, winPredictor, featureEngineer) {
    this.metaSelector    = metaSelector;
    this.winPredictor    = winPredictor;
    this.featureEngineer = featureEngineer;
    this._weightRL3      = DEFAULT_WEIGHT_RL3;
    this._autoReverted   = false;
  }

  // ── Weight management ─────────────────────────────────────────────────────

  getMode() {
    const m = (process.env.ML_ADVISOR_MODE || "shadow").toLowerCase();
    return VALID_MODES.includes(m) ? m : "shadow";
  }

  getWeights() {
    return { rl3: this._weightRL3, ms1: 1 - this._weightRL3 };
  }

  setWeights(rl3Weight) {
    const w = parseFloat(rl3Weight);
    if (!Number.isFinite(w) || w < 0 || w > 1) {
      throw new Error(`HybridAdvisor: weight must be 0.0-1.0, got ${rl3Weight}`);
    }
    this._weightRL3 = w;
  }

  // ── Core recommendation ───────────────────────────────────────────────────

  /**
   * Blend MS-1 + RL-3 recommendations.
   *
   * @param {string} symbol
   * @param {object} indicators — raw market indicators
   * @param {string[]} availableStrategies
   * @param {object} entryContext — for RL-3 feature generation
   * @returns {{ recommendations, mode, weights, regime }}
   */
  async recommend(symbol, indicators, availableStrategies, entryContext = {}) {
    const mode    = this.getMode();
    const weights = this.getWeights();

    // Always get MS-1 recommendations
    let ms1Recs = [];
    let regime  = entryContext.regime || null;

    try {
      const ms1Result = await this.metaSelector.recommend(symbol, indicators, availableStrategies);
      ms1Recs = ms1Result.recommendations || ms1Result || [];
      regime  = ms1Result.regime || regime;
    } catch (err) {
      console.warn(`[HybridAdvisor] MetaSelector failed: ${err.message}`);
    }

    // If weight is 0 or mode is shadow, return pure MS-1
    if (weights.rl3 === 0 || mode === "shadow") {
      return {
        recommendations: ms1Recs,
        mode,
        weights,
        regime,
        source: "ms1_only",
      };
    }

    // Get RL-3 scores for each strategy
    const featureVector = this.featureEngineer.buildFeatureVector(entryContext, {
      symbol,
      strategyKey: availableStrategies[0],
    });

    // Build per-strategy RL-3 scores
    const rl3Scores = {};
    if (this.winPredictor?.model) {
      for (const stratKey of availableStrategies) {
        const stratVec = this.featureEngineer.buildFeatureVector(entryContext, { symbol, strategyKey: stratKey });
        const { pWin } = this.winPredictor.predict(stratVec);
        rl3Scores[stratKey] = pWin * 100; // normalize to 0-100 like MS-1
      }
    } else {
      // No model loaded → fall back to MS-1
      return {
        recommendations: ms1Recs,
        mode,
        weights,
        regime,
        source: "ms1_fallback_no_rl3_model",
      };
    }

    // Blend scores
    const ms1Map = {};
    for (const rec of ms1Recs) {
      ms1Map[rec.strategyKey] = rec.score ?? rec.combinedScore ?? 50;
    }

    const blended = availableStrategies.map((stratKey) => {
      const ms1Score = ms1Map[stratKey] ?? 50;
      const rl3Score = rl3Scores[stratKey] ?? 50;
      const hybridScore = weights.rl3 * rl3Score + (1 - weights.rl3) * ms1Score;

      const ms1Rec = ms1Recs.find((r) => r.strategyKey === stratKey) || {};
      return {
        ...ms1Rec,
        strategyKey: stratKey,
        score:       Math.round(hybridScore),
        ms1Score:    Math.round(ms1Score),
        rl3Score:    Math.round(rl3Score),
        hybridScore: Math.round(hybridScore),
      };
    });

    blended.sort((a, b) => b.hybridScore - a.hybridScore);
    const top3 = blended.slice(0, 3);

    return {
      recommendations: top3,
      mode,
      weights,
      regime,
      source: "hybrid",
    };
  }

  // ── Auto-revert ────────────────────────────────────────────────────────────

  /**
   * Check if Sharpe ratio dropped > 20% over last 50 closed trades.
   * If so, revert WEIGHT_RL3 to 0.0 and notify via Telegram.
   * @returns {{ reverted, reason, currentWeight }}
   */
  async checkAutoRevert() {
    if (this._weightRL3 === 0) return { reverted: false, reason: "weight already 0", currentWeight: 0 };

    try {
      const logs = await prisma.mLShadowLog.findMany({
        where:   { actualOutcome: { not: null }, prediction: { not: null } },
        orderBy: { createdAt: "desc" },
        take:    50,
      });

      if (logs.length < 20) {
        return { reverted: false, reason: "insufficient data (<20 trades)", currentWeight: this._weightRL3 };
      }

      // Compute ML-guided vs baseline Sharpe (simplified: use win rate as proxy)
      const mlGuided  = logs.filter((l) => l.prediction === "win");
      const allTrades = logs;

      const mlWR  = mlGuided.length > 0
        ? mlGuided.filter((l) => l.actualOutcome === "win").length / mlGuided.length
        : 0;
      const allWR = allTrades.filter((l) => l.actualOutcome === "win").length / allTrades.length;

      // Proxy: Sharpe drop = (baseline_wr - ml_wr) / baseline_wr
      if (allWR > 0 && mlWR < allWR * 0.8) {
        // > 20% relative drop
        this._weightRL3 = 0;
        this._autoReverted = true;

        const reason = `Sharpe proxy drop detected: ML WR ${(mlWR * 100).toFixed(1)}% vs baseline ${(allWR * 100).toFixed(1)}%`;
        notifyError(`[HybridAdvisor] Auto-revert: ${reason}. WEIGHT_RL3 reset to 0.0`).catch(() => {});

        return { reverted: true, reason, currentWeight: 0 };
      }

      return { reverted: false, reason: "performance OK", currentWeight: this._weightRL3 };
    } catch (err) {
      console.warn(`[HybridAdvisor] checkAutoRevert failed: ${err.message}`);
      return { reverted: false, reason: err.message, currentWeight: this._weightRL3 };
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /**
   * Get current hybrid advisor status for API response.
   * @returns {object}
   */
  async getStatus() {
    const { ready, tradeCount, auc } = await this._getPromotionInfo();
    return {
      mode:             this.getMode(),
      weights:          this.getWeights(),
      rl3ModelVersion:  this.winPredictor?.model?.hyperparams ? "v1" : null,
      lastTrainedAt:    this.winPredictor?.model?.trainedAt ?? null,
      promotionReady:   ready,
      promotionInfo:    { tradeCount, auc },
      autoReverted:     this._autoReverted,
    };
  }

  async _getPromotionInfo() {
    try {
      const count = await prisma.mLShadowLog.count({ where: { actualOutcome: { not: null } } });
      return { ready: count >= 50, tradeCount: count, auc: null };
    } catch {
      return { ready: false, tradeCount: 0, auc: null };
    }
  }
}

module.exports = HybridAdvisor;
