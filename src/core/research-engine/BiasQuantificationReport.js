"use strict";

/**
 * BiasQuantificationReport.js — Sprint 6 / RAG-BT-3
 *
 * Quantifies optimism bias between backtest metrics and live metrics.
 * Generates calibrated disclosure statements for users.
 */

class BiasQuantificationReport {
  /**
   * Generate a full bias report comparing backtest vs live metrics.
   *
   * @param {object} backtestMetrics — { winRate, profitFactor, sharpe, avgPnl, tradeCount }
   * @param {object} liveMetrics     — { winRate, profitFactor, sharpe, avgPnl, tradeCount }
   * @returns {{ biasReport, disclosureStatement, calibratedExpectation }}
   */
  generate(backtestMetrics, liveMetrics) {
    const biasReport = this._computeBiasReport(backtestMetrics, liveMetrics);
    const calibratedExpectation = this._computeCalibratedExpectation(backtestMetrics, biasReport);
    const disclosureStatement   = this.generateDisclosure(biasReport, backtestMetrics, liveMetrics, calibratedExpectation);

    return { biasReport, disclosureStatement, calibratedExpectation };
  }

  /**
   * Compute optimism bias: (backtestWR - liveWR) / liveWR * 100.
   *
   * @param {number} backtestWR — backtest win rate [0, 1]
   * @param {number} liveWR     — live win rate [0, 1]
   * @returns {number} biasPercent (e.g. 5.77 = 5.77% optimism bias)
   */
  computeOptimismBias(backtestWR, liveWR) {
    if (!Number.isFinite(backtestWR) || !Number.isFinite(liveWR)) return 0;
    if (liveWR === 0) return backtestWR > 0 ? 100 : 0;
    return ((backtestWR - liveWR) / liveWR) * 100;
  }

  /**
   * Generate a human-readable disclosure statement.
   *
   * @param {object} biasReport
   * @param {object} [backtestMetrics]
   * @param {object} [liveMetrics]
   * @param {object} [calibratedExpectation]
   * @returns {string}
   */
  generateDisclosure(biasReport, backtestMetrics = {}, liveMetrics = {}, calibratedExpectation = {}) {
    const wrBias   = biasReport?.wrBias       != null ? biasReport.wrBias.toFixed(1)   : "N/A";
    const pfBias   = biasReport?.pfBias       != null ? biasReport.pfBias.toFixed(1)   : "N/A";
    const btWR     = backtestMetrics?.winRate != null ? (backtestMetrics.winRate * 100).toFixed(1) : "N/A";
    const liveWR   = liveMetrics?.winRate     != null ? (liveMetrics.winRate * 100).toFixed(1)    : "N/A";
    const expWR    = calibratedExpectation?.winRate != null
      ? (calibratedExpectation.winRate * 100).toFixed(1) : "N/A";
    const severity = biasReport?.severity     ?? "unknown";

    const btCount  = backtestMetrics?.tradeCount ?? 0;
    const liveCount = liveMetrics?.tradeCount ?? 0;

    const disclaimer = severity === "high"
      ? "⚠ HIGH BIAS: Backtest significantly overstates live performance. Use with caution."
      : severity === "medium"
      ? "⚠ MODERATE BIAS: Some overfitting detected. Monitor live performance closely."
      : "✓ LOW BIAS: Backtest metrics are reasonably calibrated to live performance.";

    return `QUANTARA RAG ADVISORY DISCLOSURE
==================================
${disclaimer}

BACKTEST METRICS (Simulated, N=${btCount} trades)
  Win Rate:      ${btWR}%
  Profit Factor: ${backtestMetrics?.profitFactor != null ? backtestMetrics.profitFactor.toFixed(2) : "N/A"}
  Avg PnL:       ${backtestMetrics?.avgPnl != null ? backtestMetrics.avgPnl.toFixed(2) + "%" : "N/A"}

LIVE METRICS (Advisory shadow, N=${liveCount} trades)
  Win Rate:      ${liveWR !== "N/A" ? liveWR + "%" : "No live data yet"}
  Profit Factor: ${liveMetrics?.profitFactor != null ? liveMetrics.profitFactor.toFixed(2) : "N/A"}

BIAS ANALYSIS
  Win Rate Bias:      ${wrBias}% (backtest overstates live WR by ${wrBias}%)
  Profit Factor Bias: ${pfBias}%
  Severity:           ${severity.toUpperCase()}

CALIBRATED EXPECTATIONS (adjusted for observed bias)
  Expected Live Win Rate: ~${expWR}%
  Conservative Range:     ${calibratedExpectation?.range ?? "N/A"}

IMPORTANT LIMITATIONS
  • This is an ADVISORY SIGNAL ONLY — no execution without human approval
  • Backtest simulations use historical data and cannot predict future results
  • Model operates with -10% conservative discount on positive signals
  • Validated via walk-forward (4 windows, 90d train → 30d test each)
  • Shadow mode validation required (1000+ trades, AUC ≥ 0.65) before advisory use

Internal use only — do not distribute without prior review.
Generated: ${new Date().toISOString()}`;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _computeBiasReport(backtestMetrics, liveMetrics) {
    const btWR  = backtestMetrics?.winRate ?? 0;
    const lvWR  = liveMetrics?.winRate     ?? 0;
    const btPF  = backtestMetrics?.profitFactor ?? 1;
    const lvPF  = liveMetrics?.profitFactor     ?? 1;
    const btSh  = backtestMetrics?.sharpe ?? 0;
    const lvSh  = liveMetrics?.sharpe     ?? 0;
    const btPnl = backtestMetrics?.avgPnl ?? 0;
    const lvPnl = liveMetrics?.avgPnl     ?? 0;

    const wrBias  = this.computeOptimismBias(btWR, lvWR);
    const pfBias  = lvPF > 0 ? ((btPF - lvPF) / lvPF) * 100 : 0;
    const shBias  = lvSh !== 0 ? ((btSh - lvSh) / Math.abs(lvSh)) * 100 : 0;
    const pnlBias = lvPnl !== 0 ? ((btPnl - lvPnl) / Math.abs(lvPnl)) * 100 : 0;

    // Severity classification
    let severity;
    if (Math.abs(wrBias) > 30) severity = "high";
    else if (Math.abs(wrBias) > 15) severity = "medium";
    else severity = "low";

    const meanBias = [wrBias, pfBias].reduce((s, v) => s + v, 0) / 2;

    return {
      wrBias:   +wrBias.toFixed(2),
      pfBias:   +pfBias.toFixed(2),
      shBias:   +shBias.toFixed(2),
      pnlBias:  +pnlBias.toFixed(2),
      meanBias: +meanBias.toFixed(2),
      severity,
      btSampleSize:   backtestMetrics?.tradeCount ?? 0,
      liveSampleSize: liveMetrics?.tradeCount ?? 0,
    };
  }

  _computeCalibratedExpectation(backtestMetrics, biasReport) {
    const btWR  = backtestMetrics?.winRate ?? 0;
    const btPF  = backtestMetrics?.profitFactor ?? 1;
    const btPnl = backtestMetrics?.avgPnl ?? 0;

    const biasFactor = 1 - (biasReport.wrBias / 100);

    const calibratedWR  = Math.max(0, Math.min(1, btWR * biasFactor));
    const calibratedPF  = Math.max(0, btPF * biasFactor);
    const calibratedPnl = btPnl * biasFactor;

    // Conservative range: ±2.5% around calibrated WR
    const rangeLow  = Math.max(0, (calibratedWR - 0.025) * 100).toFixed(1);
    const rangeHigh = Math.min(100, (calibratedWR + 0.025) * 100).toFixed(1);

    return {
      winRate:       +calibratedWR.toFixed(4),
      profitFactor:  +calibratedPF.toFixed(4),
      avgPnl:        +calibratedPnl.toFixed(4),
      range:         `${rangeLow}% – ${rangeHigh}%`,
      biasFactor:    +biasFactor.toFixed(4),
    };
  }
}

module.exports = BiasQuantificationReport;
