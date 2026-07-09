"use strict";

/**
 * SimilarTradeAdvisor.js — Sprint 5 / RL-5
 *
 * Finds similar past trades using VectorStore (pgvector) and computes
 * aggregated statistics (win rate, avg PnL, confidence level).
 */

const FeatureEngineer = require("./FeatureEngineer");

class SimilarTradeAdvisor {
  /**
   * @param {import('../infrastructure/db/VectorStore')} vectorStore
   * @param {FeatureEngineer} featureEngineer
   */
  constructor(vectorStore, featureEngineer) {
    this.vectorStore     = vectorStore;
    this.featureEngineer = featureEngineer || new FeatureEngineer();
  }

  /**
   * Find similar past trades and compute aggregated stats.
   *
   * @param {object} entryContext — current trade entry features
   * @param {object} tradeMetadata — { strategyKey, symbol, side }
   * @param {{ k, regimeFilter, minSimilarTrades }} [options]
   * @returns {object} analysis card
   */
  async findSimilarAndAnalyze(entryContext, tradeMetadata = {}, options = {}) {
    const { k = 20, regimeFilter = true, minSimilarTrades = 5 } = options;

    const featureVector = this.featureEngineer.buildFeatureVector(entryContext, tradeMetadata);

    // Apply regime filter if requested
    const filters = {};
    if (regimeFilter && (entryContext.regime || tradeMetadata.regime)) {
      filters.regime = entryContext.regime || tradeMetadata.regime;
    }
    if (tradeMetadata.symbol) filters.symbol = tradeMetadata.symbol;

    let similar = [];
    try {
      similar = await this.vectorStore.findSimilar(featureVector, k, filters);

      // If too few results with filters, try without regime filter
      if (similar.length < minSimilarTrades && Object.keys(filters).length > 0) {
        const broader = await this.vectorStore.findSimilar(featureVector, k, {});
        if (broader.length > similar.length) similar = broader;
      }
    } catch (err) {
      console.warn(`[SimilarTradeAdvisor] VectorStore unavailable: ${err.message}`);
      return this._emptyResult(entryContext, tradeMetadata, err.message);
    }

    // Compute statistics
    const wins    = similar.filter((t) => t.metadata?.outcome === "win").length;
    const losses  = similar.filter((t) => t.metadata?.outcome === "loss").length;
    const withOutcome = wins + losses;

    const winRate = withOutcome > 0 ? wins / withOutcome : 0;

    // Average PnL (from metadata if available)
    const pnlValues = similar
      .map((t) => parseFloat(t.metadata?.pnlPct ?? t.metadata?.pnl ?? ""))
      .filter(Number.isFinite);
    const avgPnlPct = pnlValues.length > 0
      ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length
      : 0;

    // Average holding hours
    const holdHours = similar
      .map((t) => parseFloat(t.metadata?.holdingHours ?? t.metadata?.avgHoldingHours ?? ""))
      .filter(Number.isFinite);
    const avgHoldingHours = holdHours.length > 0
      ? holdHours.reduce((s, v) => s + v, 0) / holdHours.length
      : 0;

    // Regime match
    const currentRegime = entryContext?.regime || tradeMetadata?.regime;
    const regimeMatchCount = currentRegime
      ? similar.filter((t) => t.metadata?.regime === currentRegime).length
      : similar.length;
    const regimeMatch = similar.length > 0 ? regimeMatchCount / similar.length : 0;

    const confidence = this.computeConfidence(similar.length, regimeMatch);

    const warning = similar.length < minSimilarTrades
      ? `Only ${similar.length} similar trades found — confidence low`
      : null;

    const message = `Found ${similar.length} similar trades, ${Math.round(winRate * 100)}% were winners`;

    return {
      similarCount:     similar.length,
      winRate:          Math.min(1, Math.max(0, winRate)),
      avgPnlPct,
      avgHoldingHours,
      regimeMatch:      Math.min(1, Math.max(0, regimeMatch)),
      confidence,
      message,
      warning,
    };
  }

  /**
   * Format a nicely structured recommendation card.
   * @param {object} analysis — result of findSimilarAndAnalyze
   * @returns {object}
   */
  formatCard(analysis) {
    const { similarCount, winRate, avgPnlPct, confidence, message, warning } = analysis;
    const icon = confidence === "high" ? "strong" : confidence === "medium" ? "moderate" : "weak";
    return {
      ...analysis,
      displayText: `${similarCount} similar trades — ${Math.round(winRate * 100)}% WR, avg ${avgPnlPct >= 0 ? "+" : ""}${avgPnlPct.toFixed(1)}%`,
      confidenceLabel: `${confidence} (${icon} signal)`,
      warning,
    };
  }

  /**
   * Determine confidence level.
   * high: >= 15 trades AND regimeMatch > 70%
   * medium: 5-14 trades OR regimeMatch 40-70%
   * low: < 5 trades
   */
  computeConfidence(similarCount, regimeMatch) {
    if (similarCount < 5) return "low";
    if (similarCount >= 15 && regimeMatch > 0.7) return "high";
    if (similarCount >= 5 && regimeMatch >= 0.4) return "medium";
    return "low";
  }

  _emptyResult(entryContext, tradeMetadata, errorMsg) {
    return {
      similarCount:     0,
      winRate:          0,
      avgPnlPct:        0,
      avgHoldingHours:  0,
      regimeMatch:      0,
      confidence:       "low",
      message:          "No similar trades found",
      warning:          errorMsg || "Similarity search unavailable",
    };
  }
}

module.exports = SimilarTradeAdvisor;
