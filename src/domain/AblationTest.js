"use strict";

/**
 * AblationTest.js — Sprint 6 / RAG-BT-4
 *
 * Compares 4 model variants to quantify component contributions.
 *
 * Variants:
 *   A: Baseline   — pure rule-based (no ML, no RAG)
 *   B: LGB alone  — WinPredictor only, no RAG similarity
 *   C: RAG alone  — SimilarTradeAdvisor only, no WinPredictor
 *   D: LGB + RAG  — HybridAdvisor (full)
 *
 * STAGING_ONLY: throws if NODE_ENV === 'production'.
 */

class AblationTest {
  /**
   * @param {object} [winPredictor]        — WinPredictor instance
   * @param {object} [similarTradeAdvisor] — SimilarTradeAdvisor instance
   * @param {object} [featureEngineer]     — FeatureEngineer instance
   */
  constructor(winPredictor = null, similarTradeAdvisor = null, featureEngineer = null) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[STAGING_ONLY] AblationTest must not run in production."
      );
    }
    this.winPredictor        = winPredictor;
    this.similarTradeAdvisor = similarTradeAdvisor;
    this.featureEngineer     = featureEngineer;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run ablation test across all 4 variants.
   *
   * @param {object[]} trades — trade records with { entryAt, outcome, pnlPct, ... }
   * @returns {Promise<{ baseline, lgbOnly, ragOnly, hybrid, synergyPct, variants }>}
   */
  async run(trades) {
    if (!Array.isArray(trades) || trades.length === 0) {
      const empty = this._emptyVariantMetrics();
      return {
        baseline: empty, lgbOnly: empty, ragOnly: empty, hybrid: empty,
        synergyPct: 0, variants: [],
      };
    }

    const [baseline, lgbOnly, ragOnly, hybrid] = await Promise.all([
      this.evaluateVariant(trades, "baseline"),
      this.evaluateVariant(trades, "lgbOnly"),
      this.evaluateVariant(trades, "ragOnly"),
      this.evaluateVariant(trades, "hybrid"),
    ]);

    const synergyPct = this._computeSynergy(lgbOnly, ragOnly, hybrid);

    return {
      baseline,
      lgbOnly,
      ragOnly,
      hybrid,
      synergyPct: +synergyPct.toFixed(2),
      variants: [
        { name: "A: Baseline",  key: "baseline", ...baseline },
        { name: "B: LGB Only",  key: "lgbOnly",  ...lgbOnly  },
        { name: "C: RAG Only",  key: "ragOnly",  ...ragOnly  },
        { name: "D: LGB + RAG", key: "hybrid",   ...hybrid   },
      ],
    };
  }

  /**
   * Evaluate a single variant over all trades.
   *
   * @param {object[]} trades
   * @param {'baseline'|'lgbOnly'|'ragOnly'|'hybrid'} variant
   * @returns {Promise<{ wr, pf, avgPnl, sampleSize, accuracy }>}
   */
  async evaluateVariant(trades, variant) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return this._emptyVariantMetrics();
    }

    const predictions = await this._predictAll(trades, variant);
    return this._computeVariantMetrics(trades, predictions);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  async _predictAll(trades, variant) {
    const predictions = [];

    for (const trade of trades) {
      let prediction = "loss";
      let score      = 0.5;

      try {
        if (variant === "baseline") {
          // Pure rule-based: use win rate from metadata or default 50%
          score      = 0.5;
          prediction = "loss"; // conservative baseline predicts loss
        } else if (variant === "lgbOnly") {
          score      = await this._lgbScore(trade);
          prediction = score >= 0.5 ? "win" : "loss";
        } else if (variant === "ragOnly") {
          score      = await this._ragScore(trade, trades);
          prediction = score >= 0.5 ? "win" : "loss";
        } else if (variant === "hybrid") {
          const lgb = await this._lgbScore(trade);
          const rag = await this._ragScore(trade, trades);
          score      = 0.5 * lgb + 0.5 * rag;
          prediction = score >= 0.5 ? "win" : "loss";
        }
      } catch {
        score      = 0.5;
        prediction = "loss";
      }

      predictions.push({ trade, prediction, score });
    }

    return predictions;
  }

  async _lgbScore(trade) {
    if (!this.winPredictor?.model || !this.featureEngineer) return 0.5;
    try {
      const features = this.featureEngineer.buildFeatureVector(
        trade.entryContext || trade,
        { strategyKey: trade.strategyKey, symbol: trade.symbol }
      );
      const { pWin } = this.winPredictor.predict(features);
      return Number.isFinite(pWin) ? pWin : 0.5;
    } catch {
      return 0.5;
    }
  }

  async _ragScore(trade, allTrades) {
    if (!this.similarTradeAdvisor) return 0.5;
    try {
      const entryContext  = trade.entryContext || trade;
      const tradeMetadata = {
        strategyKey: trade.strategyKey,
        symbol:      trade.symbol,
        regime:      trade.regime,
      };
      const analysis = await this.similarTradeAdvisor.findSimilarAndAnalyze(
        entryContext, tradeMetadata, { k: 15 }
      );
      return Number.isFinite(analysis.winRate) ? analysis.winRate : 0.5;
    } catch {
      return 0.5;
    }
  }

  _computeVariantMetrics(trades, predictions) {
    const n = trades.length;
    if (n === 0) return this._emptyVariantMetrics();

    const wins   = trades.filter((t) => (t.outcome || t.result) === "win").length;
    const losses = trades.filter((t) => (t.outcome || t.result) === "loss").length;
    const wr     = n > 0 ? wins / n : 0;

    const pnlValues = trades
      .map((t) => parseFloat(t.pnlPct ?? t.pnl ?? ""))
      .filter(Number.isFinite);

    const avgPnl = pnlValues.length > 0
      ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length
      : 0;

    const grossProfit = pnlValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss   = Math.abs(pnlValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const pf          = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 1;

    // Prediction accuracy vs actual
    const correct = predictions.filter((p) => {
      const actual = p.trade?.outcome || p.trade?.result;
      return actual && p.prediction === actual;
    });
    const accuracy = predictions.length > 0 ? correct.length / predictions.length : 0;

    return {
      wr:         +wr.toFixed(4),
      pf:         +pf.toFixed(4),
      avgPnl:     +avgPnl.toFixed(4),
      sampleSize: n,
      wins,
      losses,
      accuracy:   +accuracy.toFixed(4),
    };
  }

  /**
   * Synergy % = (hybridWR - max(lgbWR, ragWR)) / max(lgbWR, ragWR) * 100
   */
  _computeSynergy(lgbOnly, ragOnly, hybrid) {
    const best    = Math.max(lgbOnly.wr, ragOnly.wr);
    if (best === 0) return 0;
    return ((hybrid.wr - best) / best) * 100;
  }

  _emptyVariantMetrics() {
    return { wr: 0, pf: 0, avgPnl: 0, sampleSize: 0, wins: 0, losses: 0, accuracy: 0 };
  }
}

module.exports = AblationTest;
