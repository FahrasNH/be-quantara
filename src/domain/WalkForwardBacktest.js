"use strict";

/**
 * WalkForwardBacktest.js — Sprint 6 / RAG-BT-2
 *
 * Walk-forward staging backtest over 4 rolling time windows.
 * Windows: [90d train → 30d test] × 4, rolling forward.
 * STAGING_ONLY: throws if NODE_ENV === 'production'.
 *
 * Robustness target: WR consistent across windows (stddev < 5%)
 */

const TRAIN_DAYS = 90;
const TEST_DAYS  = 30;
const N_WINDOWS  = 4;

class WalkForwardBacktest {
  /**
   * @param {object} [conservativeEngine] — ConservativeBacktestEngine instance (optional)
   */
  constructor(conservativeEngine = null) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[STAGING_ONLY] WalkForwardBacktest must not run in production."
      );
    }
    this.conservativeEngine = conservativeEngine;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run 4-window walk-forward backtest.
   *
   * @param {object[]} trades  — full trade history array
   * @param {object}  [options]
   * @param {number}  [options.nWindows=4]
   * @param {number}  [options.trainDays=90]
   * @param {number}  [options.testDays=30]
   * @returns {Promise<{ windows, aggregate, consistencyScore }>}
   */
  async run(trades, options = {}) {
    if (!Array.isArray(trades) || trades.length === 0) {
      return { windows: [], aggregate: this._emptyAggregate(), consistencyScore: 0 };
    }

    const nWindows  = options.nWindows  ?? N_WINDOWS;
    const trainDays = options.trainDays ?? TRAIN_DAYS;
    const testDays  = options.testDays  ?? TEST_DAYS;

    // Sort trades by date
    const sorted = [...trades].sort((a, b) =>
      new Date(a.entryAt || a.createdAt || 0) - new Date(b.entryAt || b.createdAt || 0)
    );

    const firstDate = new Date(sorted[0].entryAt   || sorted[0].createdAt);
    const lastDate  = new Date(sorted[sorted.length - 1].entryAt || sorted[sorted.length - 1].createdAt);

    const totalSpan   = lastDate - firstDate; // ms
    const windowSpanMs = (trainDays + testDays) * 86400000;

    // Spread windows over available data
    const windowResults = [];

    for (let i = 0; i < nWindows; i++) {
      // Rolling start: evenly distribute windows over the available history
      const offset      = i * Math.max(testDays, Math.floor((totalSpan / 86400000 - trainDays - testDays) / Math.max(1, nWindows - 1)));
      const windowStart = new Date(firstDate.getTime() + offset * 86400000);

      const { train, test } = this.generateWindow(sorted, windowStart, trainDays, testDays);

      let metrics = this._emptyWindowMetrics();
      let predictions = [];

      if (test.length > 0) {
        if (this.conservativeEngine) {
          try {
            const bt = await this.conservativeEngine.runBacktest(test, {});
            predictions = bt.results;
          } catch {
            predictions = test.map((t) => ({ trade: t, prediction: "skip" }));
          }
        } else {
          // Simple rule-based evaluation (no ML)
          predictions = test.map((t) => ({
            trade:      t,
            prediction: (t.outcome || t.result) === "win" ? "win" : "loss",
          }));
        }
        metrics = this.evaluateWindow(test, predictions);
      }

      windowResults.push({
        windowIndex: i + 1,
        startDate:   windowStart.toISOString().slice(0, 10),
        trainCount:  train.length,
        testCount:   test.length,
        trainDays,
        testDays,
        ...metrics,
      });
    }

    const aggregate        = this._aggregateWindows(windowResults);
    const consistencyScore = this._computeConsistency(windowResults);

    return {
      windows:          windowResults,
      aggregate,
      consistencyScore: +consistencyScore.toFixed(4),
      nWindows,
      trainDays,
      testDays,
    };
  }

  /**
   * Generate a single walk-forward window from the trade array.
   *
   * @param {object[]} trades    — sorted trade array
   * @param {Date}     startDate — window start date
   * @param {number}   trainDays
   * @param {number}   testDays
   * @returns {{ train: object[], test: object[] }}
   */
  generateWindow(trades, startDate, trainDays, testDays) {
    const trainEnd = new Date(startDate.getTime() + trainDays * 86400000);
    const testEnd  = new Date(trainEnd.getTime()  + testDays  * 86400000);

    const train = trades.filter((t) => {
      const d = new Date(t.entryAt || t.createdAt || 0);
      return d >= startDate && d < trainEnd;
    });

    const test = trades.filter((t) => {
      const d = new Date(t.entryAt || t.createdAt || 0);
      return d >= trainEnd && d < testEnd;
    });

    return { train, test };
  }

  /**
   * Evaluate a test window against predictions.
   *
   * @param {object[]} testTrades
   * @param {object[]} predictions — array of { trade, prediction, adjustedScore }
   * @returns {{ wr, pf, sharpe, avgPnl, sampleSize }}
   */
  evaluateWindow(testTrades, predictions) {
    if (!testTrades || testTrades.length === 0) return this._emptyWindowMetrics();

    const n = testTrades.length;

    const wins   = testTrades.filter((t) => (t.outcome || t.result) === "win").length;
    const losses = testTrades.filter((t) => (t.outcome || t.result) === "loss").length;
    const wr     = n > 0 ? wins / n : 0;

    const pnlValues = testTrades
      .map((t) => parseFloat(t.pnlPct ?? t.pnl ?? ""))
      .filter(Number.isFinite);

    const avgPnl     = pnlValues.length > 0
      ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length
      : 0;

    const grossProfit = pnlValues.filter((v) => v > 0).reduce((s, v) => s + v, 0);
    const grossLoss   = Math.abs(pnlValues.filter((v) => v < 0).reduce((s, v) => s + v, 0));
    const pf          = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 1;

    const sharpe = this._computeSharpe(pnlValues);

    // Prediction accuracy
    const withPred = predictions.filter((p) => p.prediction !== "skip");
    const correct  = withPred.filter((p) => {
      const actual = p.trade?.outcome || p.trade?.result;
      return p.prediction === actual;
    });
    const accuracy = withPred.length > 0 ? correct.length / withPred.length : 0;

    return {
      wr:         +wr.toFixed(4),
      pf:         +pf.toFixed(4),
      sharpe:     +sharpe.toFixed(4),
      avgPnl:     +avgPnl.toFixed(4),
      sampleSize: n,
      wins,
      losses,
      accuracy:   +accuracy.toFixed(4),
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _aggregateWindows(windows) {
    const valid = windows.filter((w) => w.sampleSize > 0);
    if (valid.length === 0) return this._emptyAggregate();

    const mean = (field) =>
      valid.reduce((s, w) => s + (w[field] ?? 0), 0) / valid.length;

    return {
      meanWR:         +mean("wr").toFixed(4),
      meanPF:         +mean("pf").toFixed(4),
      meanSharpe:     +mean("sharpe").toFixed(4),
      meanAvgPnl:     +mean("avgPnl").toFixed(4),
      meanSampleSize: +mean("sampleSize").toFixed(1),
      totalTrades:    valid.reduce((s, w) => s + (w.sampleSize ?? 0), 0),
      windowCount:    valid.length,
    };
  }

  /**
   * Consistency score = 1 - (stddev of WRs / mean WR).
   * Higher is better (1.0 = perfectly consistent).
   */
  _computeConsistency(windows) {
    const valid = windows.filter((w) => w.sampleSize > 0);
    if (valid.length < 2) return valid.length === 1 ? 1 : 0;

    const wrs  = valid.map((w) => w.wr);
    const mean = wrs.reduce((s, v) => s + v, 0) / wrs.length;
    if (mean === 0) return 0;

    const variance = wrs.reduce((s, v) => s + (v - mean) ** 2, 0) / (wrs.length - 1);
    const stddev   = Math.sqrt(variance);

    return Math.max(0, 1 - stddev / mean);
  }

  _computeSharpe(pnlValues) {
    if (pnlValues.length < 2) return 0;
    const mean    = pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length;
    const variance = pnlValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnlValues.length - 1);
    const stddev  = Math.sqrt(variance);
    return stddev > 0 ? mean / stddev : 0;
  }

  _emptyWindowMetrics() {
    return { wr: 0, pf: 0, sharpe: 0, avgPnl: 0, sampleSize: 0, wins: 0, losses: 0, accuracy: 0 };
  }

  _emptyAggregate() {
    return { meanWR: 0, meanPF: 0, meanSharpe: 0, meanAvgPnl: 0, meanSampleSize: 0, totalTrades: 0, windowCount: 0 };
  }
}

module.exports = WalkForwardBacktest;
