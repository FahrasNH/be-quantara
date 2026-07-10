"use strict";

/**
 * ConservativeBacktestEngine.js — Sprint 6 / RAG-BT-1
 *
 * Time-aware RAG backtest engine for staging validation.
 * - Queries pgvector ONLY for trades BEFORE current simulation date (no look-ahead)
 * - Applies -10% conservative discount to all positive RAG-based signals
 * - STAGING_ONLY: throws if NODE_ENV === 'production'
 *
 * Usage:
 *   const engine = new ConservativeBacktestEngine(vectorStore, featureEngineer, winPredictor)
 *   const result = await engine.runBacktest(trades, options)
 */

const CONSERVATIVE_DISCOUNT = 0.9; // -10% on positive scores

class ConservativeBacktestEngine {
  /**
   * @param {object} vectorStore       — VectorStore instance (pgvector)
   * @param {object} featureEngineer   — FeatureEngineer instance
   * @param {object} [winPredictor]    — WinPredictor instance (optional)
   */
  constructor(vectorStore, featureEngineer, winPredictor = null) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[STAGING_ONLY] ConservativeBacktestEngine must not run in production. " +
        "Set NODE_ENV to 'staging' or 'test'."
      );
    }
    this.vectorStore     = vectorStore;
    this.featureEngineer = featureEngineer;
    this.winPredictor    = winPredictor;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run a full conservative backtest over a set of historical trades.
   *
   * @param {object[]} trades  — array of trade records with { entryAt, outcome, pnlPct, ... }
   * @param {object}  [options]
   * @param {boolean} [options.verbose=false]
   * @returns {Promise<{ results, metrics, ragUsed }>}
   */
  async runBacktest(trades, options = {}) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { results: [], metrics: this._emptyMetrics(), ragUsed: false };
    }

    const sorted = [...trades].sort((a, b) =>
      new Date(a.entryAt || a.createdAt || 0) - new Date(b.entryAt || b.createdAt || 0)
    );

    const results = [];
    let ragUsed   = false;

    for (const trade of sorted) {
      const simDate = new Date(trade.entryAt || trade.createdAt || Date.now());

      // Build historical context — only trades BEFORE this simulation date
      const historicalContext = sorted.filter((t) => {
        const tDate = new Date(t.entryAt || t.createdAt || 0);
        return tDate < simDate;
      });

      try {
        const sim = await this.simulateTrade(trade, historicalContext);
        results.push({ trade, ...sim });
        if (sim.ragScore !== null) ragUsed = true;
      } catch (err) {
        results.push({
          trade,
          prediction:    "skip",
          adjustedScore: 0,
          confidence:    0,
          ragScore:      null,
          error:         err.message,
        });
      }
    }

    const metrics = this._computeMetrics(results);
    return { results, metrics, ragUsed };
  }

  /**
   * Simulate a single trade decision using time-filtered historical context.
   *
   * @param {object}   trade            — the trade to evaluate
   * @param {object[]} historicalContext — trades strictly before trade.entryAt
   * @returns {Promise<{ prediction, adjustedScore, confidence, ragScore, lgbScore }>}
   */
  async simulateTrade(trade, historicalContext) {
    let lgbScore  = null;
    let ragScore  = null;
    let confidence = 0;

    // ── LGB / WinPredictor score ─────────────────────────────────────────────
    if (this.winPredictor?.model && this.featureEngineer) {
      try {
        const entryContext  = trade.entryContext || trade;
        const tradeMetadata = {
          strategyKey: trade.strategyKey,
          symbol:      trade.symbol,
          regime:      trade.regime,
        };
        const features = this.featureEngineer.buildFeatureVector(entryContext, tradeMetadata);
        const { pWin }  = this.winPredictor.predict(features);
        lgbScore        = pWin;
      } catch {
        lgbScore = null;
      }
    }

    // ── RAG similarity score (time-aware) ────────────────────────────────────
    if (this.vectorStore && this.featureEngineer && historicalContext.length >= 5) {
      try {
        const entryContext = trade.entryContext || trade;
        const features     = this.featureEngineer.buildFeatureVector(entryContext, {
          strategyKey: trade.strategyKey,
          symbol:      trade.symbol,
        });

        // Time-aware filter: only look at historical context
        const maxDate = new Date(trade.entryAt || trade.createdAt || Date.now());
        const similar = await this.vectorStore.findSimilar(features, 20, {
          symbol:   trade.symbol,
          beforeDate: maxDate.toISOString(),
        });

        if (similar.length > 0) {
          const wins     = similar.filter((t) => t.metadata?.outcome === "win").length;
          const withOutcome = similar.filter(
            (t) => t.metadata?.outcome === "win" || t.metadata?.outcome === "loss"
          ).length;
          if (withOutcome > 0) {
            ragScore   = wins / withOutcome;
            confidence = Math.min(1, similar.length / 20);
          }
        }
      } catch {
        ragScore = null;
      }
    }

    // ── Blend and apply conservative discount ────────────────────────────────
    let rawScore;
    if (lgbScore !== null && ragScore !== null) {
      rawScore = 0.5 * lgbScore + 0.5 * ragScore;
    } else if (lgbScore !== null) {
      rawScore = lgbScore;
    } else if (ragScore !== null) {
      rawScore = ragScore;
    } else {
      // No ML signal — use simple rule-based heuristic
      rawScore = 0.5;
    }

    const adjustedScore = this.applyConservativeDiscount(rawScore);
    const prediction    = adjustedScore >= 0.5 ? "win" : "loss";

    return {
      prediction,
      adjustedScore,
      rawScore,
      confidence,
      ragScore,
      lgbScore,
    };
  }

  /**
   * Apply -10% conservative discount to positive signals.
   * Negative/neutral signals (≤ 0) are unchanged.
   *
   * @param {number} score — raw score [0, 1]
   * @returns {number} adjusted score
   */
  applyConservativeDiscount(score) {
    if (!Number.isFinite(score)) return 0.5;
    // Discount positive signals (above neutral 0.5)
    if (score > 0.5) {
      const excess   = score - 0.5;
      return 0.5 + excess * CONSERVATIVE_DISCOUNT;
    }
    return score; // non-positive excess → no change
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _computeMetrics(results) {
    const withPrediction = results.filter((r) => r.prediction !== "skip");
    if (withPrediction.length === 0) return this._emptyMetrics();

    const n = withPrediction.length;

    // Win rate: compare prediction vs actual outcome
    const correct = withPrediction.filter((r) => {
      const actual = r.trade.outcome || r.trade.result;
      return r.prediction === actual;
    });

    // Backtest metrics (using actual outcomes)
    const wins   = withPrediction.filter((r) =>
      (r.trade.outcome || r.trade.result) === "win"
    ).length;
    const losses = withPrediction.filter((r) =>
      (r.trade.outcome || r.trade.result) === "loss"
    ).length;

    const winRate = n > 0 ? wins / n : 0;

    // PnL-based metrics
    const pnlValues = withPrediction
      .map((r) => parseFloat(r.trade.pnlPct ?? r.trade.pnl ?? ""))
      .filter(Number.isFinite);

    const avgPnl = pnlValues.length > 0
      ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length
      : 0;

    const grossProfit = pnlValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss   = Math.abs(pnlValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const sharpe = this._computeSharpe(pnlValues);

    // Conservative metrics (applying discount to final reported numbers)
    const conservativeWR    = winRate * CONSERVATIVE_DISCOUNT + winRate * (1 - CONSERVATIVE_DISCOUNT) * 0.5;
    const conservativePF    = profitFactor * CONSERVATIVE_DISCOUNT;
    const conservativeAvgPnl = avgPnl * CONSERVATIVE_DISCOUNT;

    const accuracy = n > 0 ? correct.length / n : 0;

    return {
      tradeCount:         n,
      winCount:           wins,
      lossCount:          losses,
      winRate:            +winRate.toFixed(4),
      profitFactor:       +profitFactor.toFixed(4),
      sharpe:             +sharpe.toFixed(4),
      avgPnl:             +avgPnl.toFixed(4),
      accuracy:           +accuracy.toFixed(4),
      conservative: {
        winRate:      +conservativeWR.toFixed(4),
        profitFactor: +conservativePF.toFixed(4),
        avgPnl:       +conservativeAvgPnl.toFixed(4),
      },
      discountFactor: CONSERVATIVE_DISCOUNT,
    };
  }

  _computeSharpe(pnlValues) {
    if (pnlValues.length < 2) return 0;
    const mean   = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
    const variance = pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnlValues.length - 1);
    const stddev = Math.sqrt(variance);
    return stddev > 0 ? mean / stddev : 0;
  }

  _emptyMetrics() {
    return {
      tradeCount: 0, winCount: 0, lossCount: 0,
      winRate: 0, profitFactor: 0, sharpe: 0, avgPnl: 0, accuracy: 0,
      conservative: { winRate: 0, profitFactor: 0, avgPnl: 0 },
      discountFactor: CONSERVATIVE_DISCOUNT,
    };
  }
}

module.exports = ConservativeBacktestEngine;
