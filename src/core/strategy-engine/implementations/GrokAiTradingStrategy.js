/**
 * GrokAiTradingStrategy.js — delegasi keputusan entry/TP/SL ke Grok (xAI).
 */

const StrategyBase = require("../base/StrategyBase");
const GrokTradingService = require("../../../server/services/GrokTradingService");

class GrokAiTradingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "GROK_AI_TRADING",
      label: "Grok AI Trading (experimental)",
      description: "EXPERIMENTAL VAULT bonus: entry/TP/SL via Grok (xAI). Prefer GrokConfirm overlay on canonical strategies.",
      version: "1.0.0",
      ...config,
    });
    this._lastDecision = null;
  }

  /**
   * Sync stub — BotEngine memakai path khusus _tickGrokAi().
   */
  detectSignal() {
    return null;
  }

  async detectSignalAsync(ctx) {
    const decision = await GrokTradingService.requestTradeDecision(ctx);
    this._lastDecision = decision;
    const minEntry = ctx.minConfidenceEntry ?? 8;
    if (!decision || !decision.entryAllowed || decision.confidence < minEntry) return null;
    return decision.side;
  }

  getLastDecision() {
    return this._lastDecision;
  }

  getRiskConfig() {
    return {
      riskPerTrade: 0.01,
      maxTradesPerDay: 20,
      cooldownAfterLoss: 30,
      leverage: 2,
      minConfidenceEntry: 8,
      minConfidenceTpSl: 7,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "15m",
      higherTf: "1h",
      checkInterval: 600_000,
      multiTimeframes: ["1m", "5m", "15m", "30m", "1h", "4h"],
    };
  }

  rankByMarketConditions() {
    return 50;
  }

  canActivate(balance) {
    if (balance < 20) return { allowed: false, reason: "Min balance $20" };
    return { allowed: true, reason: "OK" };
  }

  validateEntry(price, atr) {
    if (!atr || atr <= 0) return { valid: false, reason: "ATR tidak tersedia" };
    if (!price || price <= 0) return { valid: false, reason: "Harga tidak valid" };
    return { valid: true, reason: "OK" };
  }
}

module.exports = GrokAiTradingStrategy;
