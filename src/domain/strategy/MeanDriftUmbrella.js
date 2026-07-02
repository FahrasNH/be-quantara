const MeanReversionStrategy = require("./MeanReversionStrategy.js");

/**
 * Mean Drift Umbrella (MD_MR)
 *
 * Implementasi Mean Reversion dengan 2 komponen:
 *   - Component A (Scalping): 5m entry, tight stops, micro-profit targets
 *   - Component B (Intraday): 15m entry, wider stops, standard profit targets
 *
 * Architecture:
 * - Single MeanReversionStrategy instance
 * - Auto-select component based on candle data
 * - Voting: weighted by component confidence
 */
class MeanDriftUmbrella {
  constructor() {
    this.name = "Mean Drift (MD_MR)";
    this.key = "MD_MR";
    this.shortName = "MD";
    this.components = {
      A: new MeanReversionStrategy(),  // Component A + B wrapped in single strategy
    };
  }

  /**
   * Voting-based entry decision
   * @param {Array} candles
   * @param {Object} config
   * @returns signal object
   */
  detectSignal(candles, config = {}) {
    const {
      minVotes = 1,  // At least 1 component must agree (allow single component entry)
      minConfidence = 50,
    } = config;

    if (!candles || candles.length === 0) {
      return { signal: null, confidence: 0, reason: "No candles" };
    }

    // Get signal from MeanReversionStrategy
    const strat = this.components.A;
    const result = strat.detectSignal(candles, config);

    if (!result.signal || result.confidence < minConfidence) {
      return {
        signal: null,
        confidence: 0,
        component: null,
        reason: result.reason || "Below confidence threshold",
      };
    }

    // Return the component choice from MeanReversionStrategy
    return {
      signal: result.signal,
      component: result.component,
      confidence: result.confidence,
      reason: result.reason,
    };
  }

  /**
   * Get risk/reward config based on selected component
   */
  getRiskConfig(candles, signal, config = {}) {
    const strat = this.components.A;
    return strat.getRiskConfig(candles, signal, config);
  }

  /**
   * Get metadata for UI (strategy info card)
   */
  static getMetadata() {
    return {
      name: "Mean Drift (Mean Reversion)",
      key: "MD_MR",
      tier: "MINT",
      components: [
        {
          id: "A",
          name: "Scalping",
          description: "5m entry, RSI < 28, BB(1.5σ) touch → 1:2.5 RR, 5-15m hold",
          timeframe: "5m",
        },
        {
          id: "B",
          name: "Intraday",
          description: "15m entry, RSI < 32, BB(2.0σ) touch → 1:2 RR, 30-90m hold",
          timeframe: "15m",
        },
      ],
      indicators: ["BB", "RSI", "VWAP", "z-score"],
      tradeTypes: ["Scalping", "Intraday"],
      winRate: "50-55%",
      profitFactor: "1.8-2.2",
    };
  }
}

module.exports = MeanDriftUmbrella;
