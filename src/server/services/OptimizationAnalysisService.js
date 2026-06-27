/**
 * OptimizationAnalysisService.js
 * Service untuk menganalisis performa backtest dan memberikan rekomendasi optimasi
 */

const BacktestLoader = require("./BacktestLoader");
const BacktestHistoryService = require("./BacktestHistoryService");

class OptimizationAnalysisService {
  /**
   * Analisis backtest dan berikan rekomendasi
   */
  static async analyzeBacktest(symbol, backtest_id = null, opts = {}) {
    try {
      const { metricsOverride = null } = opts;
      let backtest;

      if (metricsOverride && typeof metricsOverride === "object") {
        backtest = { symbol, metrics: metricsOverride };
      } else {
        backtest = await this._getBacktestData(symbol, backtest_id);
      }

      const metrics = this._normalizeMetrics(backtest.metrics);

      // Hitung scores dan rekomendasi
      const overallScore = this._calculateOverallScore(metrics);
      const recommendations = this._generateRecommendations(metrics);
      const opportunities = this._identifyOpportunities(metrics);
      const comparison = this._performanceComparison(metrics);
      const riskAssessment = this._assessRisk(metrics);

      return {
        overall_score: overallScore,
        recommendations,
        opportunities,
        comparison,
        risk_assessment: riskAssessment,
      };
    } catch (err) {
      console.error(`[OptimizationAnalysis] Error: ${err.message}`);
      throw err;
    }
  }

  /** Normalisasi metrik FE (camelCase) dan BE (snake_case) */
  static _normalizeMetrics(raw = {}) {
    const winRate = parseFloat(raw.win_rate_pct ?? raw.winRate ?? 0);
    let maxDd = parseFloat(raw.max_drawdown_pct ?? raw.maxDrawdown ?? 0);
    if (maxDd > 0) maxDd = -maxDd;

    return {
      win_rate_pct: winRate,
      profit_factor: parseFloat(raw.profit_factor ?? raw.profitFactor ?? 0),
      max_drawdown_pct: maxDd,
      roi_pct: parseFloat(raw.roi_pct ?? raw.totalReturn ?? 0),
      sharpe_ratio: parseFloat(raw.sharpe_ratio ?? raw.sharpe ?? 0),
      total_trades: parseInt(raw.total_trades ?? raw.totalTrades ?? 0, 10) || 0,
      expectancy: parseFloat(raw.expectancy ?? 0),
      average_r: parseFloat(raw.average_r ?? raw.averageR ?? 0),
    };
  }

  /**
   * Hitung overall performance score (0-100)
   */
  static _calculateOverallScore(metrics) {
    let score = 0;
    let count = 0;

    // Win rate scoring (0-25 points)
    if (metrics.win_rate_pct !== undefined) {
      const wr = metrics.win_rate_pct;
      score += Math.min(25, (wr / 100) * 25);
      count++;
    }

    // Profit factor scoring (0-25 points)
    if (metrics.profit_factor !== undefined) {
      const pf = metrics.profit_factor;
      score += Math.min(25, (pf / 2) * 25);
      count++;
    }

    // Sharpe ratio scoring (0-20 points)
    if (metrics.sharpe_ratio !== undefined) {
      const sr = metrics.sharpe_ratio;
      score += Math.min(20, (sr / 2) * 20);
      count++;
    }

    // Drawdown scoring (0-15 points)
    if (metrics.max_drawdown_pct !== undefined) {
      const dd = Math.abs(metrics.max_drawdown_pct);
      score += Math.max(0, 15 - (dd / 10) * 15);
      count++;
    }

    // ROI scoring (0-15 points)
    if (metrics.roi_pct !== undefined) {
      const roi = metrics.roi_pct;
      score += Math.min(15, (roi / 100) * 15);
      count++;
    }

    return count > 0 ? (score / count) : 0;
  }

  /**
   * Generate rekomendasi berdasarkan metrics
   */
  static _generateRecommendations(metrics) {
    const recommendations = [];

    // Win rate analysis
    if (metrics.win_rate_pct < 40) {
      recommendations.push({
        title: "Improve Entry Signals",
        priority: "critical",
        description:
          "Your win rate is below 40%. Consider refining entry signals to reduce false entries.",
        expected_impact: 15,
      });
    } else if (metrics.win_rate_pct < 50) {
      recommendations.push({
        title: "Optimize Entry Conditions",
        priority: "high",
        description:
          "Win rate is below 50%. Tighten entry criteria to improve entry quality.",
        expected_impact: 10,
      });
    }

    // Profit factor analysis
    if (metrics.profit_factor < 1.0) {
      recommendations.push({
        title: "Fix Losing Trades",
        priority: "critical",
        description:
          "Profit factor below 1.0 means losses exceed wins. Review and improve risk management.",
        expected_impact: 25,
      });
    } else if (metrics.profit_factor < 1.5) {
      recommendations.push({
        title: "Increase Profit Factor",
        priority: "high",
        description:
          "Profit factor is low. Implement better stop-loss management or larger profit targets.",
        expected_impact: 12,
      });
    }

    // Drawdown analysis
    if (metrics.max_drawdown_pct < -30) {
      recommendations.push({
        title: "Implement Position Sizing",
        priority: "critical",
        description:
          "Maximum drawdown exceeds 30%. Use position sizing to limit equity swings.",
        expected_impact: 20,
      });
    }

    // Expectancy analysis
    if (metrics.expectancy < 0.01) {
      recommendations.push({
        title: "Improve Trade Selection",
        priority: "high",
        description:
          "Low expectancy per trade. Focus on higher-probability setups.",
        expected_impact: 15,
      });
    }

    // Sharpe ratio analysis
    if ((metrics.sharpe_ratio || 0) < 1.0) {
      recommendations.push({
        title: "Enhance Risk-Adjusted Returns",
        priority: "medium",
        description:
          "Sharpe ratio below 1.0. Balance returns against volatility more effectively.",
        expected_impact: 8,
      });
    }

    return recommendations.slice(0, 5); // Top 5 recommendations
  }

  /**
   * Identifikasi optimization opportunities
   */
  static _identifyOpportunities(metrics) {
    const opportunities = [];

    // Position sizing opportunity
    if (metrics.max_drawdown_pct < -20) {
      opportunities.push({
        name: "Position Sizing Optimization",
        metric_name: "Position Size (%)",
        current_value: 100,
        recommended_value: 75,
        potential_gain: 12,
        implementation:
          "Reduce position size by 25% to decrease drawdown volatility while maintaining return potential.",
      });
    }

    // Take profit improvement
    if (metrics.profit_factor < 1.8) {
      opportunities.push({
        name: "Take Profit Adjustment",
        metric_name: "TP Multiplier",
        current_value: 1.0,
        recommended_value: 1.5,
        potential_gain: 18,
        implementation:
          "Increase take profit targets by 50% to capture larger moves while maintaining the same win rate.",
      });
    }

    // Stop loss tightening
    if (metrics.average_r && metrics.average_r < 1.5) {
      opportunities.push({
        name: "Stop Loss Optimization",
        metric_name: "SL Multiplier",
        current_value: 1.0,
        recommended_value: 0.75,
        potential_gain: 10,
        implementation:
          "Tighten stop losses by 25% to improve risk-reward ratio without sacrificing win rate.",
      });
    }

    // Trade frequency opportunity
    if (metrics.total_trades < 50) {
      opportunities.push({
        name: "Increase Trade Frequency",
        metric_name: "Trades per Period",
        current_value: (metrics.total_trades || 1) / 20,
        recommended_value: ((metrics.total_trades || 1) / 20) * 1.5,
        potential_gain: 8,
        implementation:
          "Identify additional entry signals to increase trade frequency and compound returns.",
      });
    }

    // Time frame optimization
    if (metrics.win_rate_pct > 50 && metrics.profit_factor > 1.5) {
      opportunities.push({
        name: "Timeframe Expansion",
        metric_name: "Success Rate (%)",
        current_value: 85,
        recommended_value: 95,
        potential_gain: 5,
        implementation:
          "Your strategy is performing well. Consider expanding to additional timeframes or symbols.",
      });
    }

    return opportunities;
  }

  /**
   * Compare current vs optimized performance
   */
  static _performanceComparison(metrics) {
    const current = metrics.roi_pct || 0;
    const opportunities = this._identifyOpportunities(metrics);
    const totalPotential = opportunities.reduce((sum, opp) => sum + (opp.potential_gain || 0), 0);
    const optimized = current + (current * totalPotential) / 100;

    return {
      current: current,
      optimized: optimized,
      gain: optimized - current,
    };
  }

  /**
   * Assess risk across different dimensions
   */
  static _assessRisk(metrics) {
    const dd = Math.abs(metrics.max_drawdown_pct || 0);
    const wr = metrics.win_rate_pct || 0;
    const pf = metrics.profit_factor || 0;

    let level = "Moderate";
    if (dd > 30 || wr < 40 || pf < 1) level = "High";
    else if (dd < 15 && wr > 55 && pf >= 1.5) level = "Low";

    const summary = `Drawdown ${dd.toFixed(1)}%, win rate ${wr.toFixed(1)}%, profit factor ${pf.toFixed(2)}`;

    return {
      level,
      summary,
      drawdown_risk: Math.min(100, Math.max(0, dd * 2)),
      concentration_risk: metrics.total_trades > 100 ? 20 : 50,
      win_rate_variance: wr < 50 ? 60 : 30,
      expectancy_risk: metrics.expectancy && metrics.expectancy < 0.05 ? 70 : 20,
      volatility_risk: metrics.roi_pct && metrics.roi_pct > 100 ? 65 : 35,
    };
  }

  /**
   * Map stats dari FE backtest session → metrik analisis
   */
  static mapSessionStats(stats = {}) {
    const winRate = parseFloat(stats.winRate ?? stats.win_rate_pct ?? 0);
    const maxDd = parseFloat(stats.maxDrawdown ?? stats.max_drawdown_pct ?? 0);
    return {
      win_rate_pct: winRate,
      profit_factor: parseFloat(stats.profitFactor ?? stats.profit_factor ?? 0),
      max_drawdown_pct: maxDd > 0 ? -maxDd : maxDd,
      roi_pct: parseFloat(stats.totalReturn ?? stats.roi_pct ?? 0),
      sharpe_ratio: parseFloat(stats.sharpe ?? stats.sharpe_ratio ?? 0),
      total_trades: parseInt(stats.totalTrades ?? stats.total_trades ?? 0, 10) || 0,
      expectancy: parseFloat(stats.expectancy ?? 0),
      average_r: parseFloat(stats.averageR ?? stats.average_r ?? 0),
    };
  }

  /**
   * Get backtest data dari file atau database
   */
  static async _getBacktestData(symbol, backtest_id = null) {
    if (backtest_id) {
      const backtest = await BacktestHistoryService.getById(backtest_id);
      if (!backtest) {
        const err = new Error(`Backtest ${backtest_id} not found`);
        err.statusCode = 404;
        throw err;
      }
      return backtest;
    }

    if (symbol) {
      const history = await BacktestHistoryService.getHistory(symbol.toUpperCase(), 1);
      if (history?.length) return history[0];
    }

    const summary = await BacktestLoader.loadSummary(symbol);
    if (!summary) {
      const err = new Error(`No backtest data found for ${symbol}`);
      err.statusCode = 404;
      throw err;
    }
    return { symbol, metrics: summary.metrics || {} };
  }
}

module.exports = OptimizationAnalysisService;
