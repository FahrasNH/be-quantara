"use strict";

const StrategyBase = require("../base/StrategyBase");

/**
 * Runtime marker for the dry-run news experiment.
 * BotEngine owns the async news/Grok tick; this class supplies the registry
 * contract and deliberately never emits a synchronous technical signal.
 */
class GrokNewsTradingStrategy extends StrategyBase {
  constructor(config = {}) {
    super({
      name: "GROK_NEWS_TRADING",
      label: "Grok News Trading (dry-run only)",
      description: "Dry-run-only Tier A/B news reaction strategy. Grok decides entry, SL, and TP only after a fresh high-impact event.",
      version: "1.0.0",
      ...config,
    });
  }

  detectSignal() {
    return null;
  }

  getRiskConfig() {
    return {
      riskPerTrade: 0.01,
      maxDailyLossPct: 0.03,
      maxTradesPerDay: 4,
      cooldownAfterLoss: 60,
      leverage: 1,
      minConfidenceEntry: 8,
      minConfidenceTpSl: 7,
    };
  }

  getTimeframeConfig() {
    return {
      interval: "15m",
      higherTf: "1h",
      checkInterval: 300_000,
      multiTimeframes: ["5m", "15m", "1h", "4h"],
    };
  }

  rankByMarketConditions() {
    return 100;
  }

  canActivate(balance) {
    if (!(Number(balance) >= 20)) return { allowed: false, reason: "Min balance $20" };
    return { allowed: true, reason: "Dry-run news experiment" };
  }

  validateEntry(price, atr) {
    if (!(Number(price) > 0)) return { valid: false, reason: "Harga tidak valid" };
    if (!(Number(atr) > 0)) return { valid: false, reason: "ATR tidak tersedia" };
    return { valid: true, reason: "News/Grok validation is handled by BotEngine" };
  }
}

module.exports = GrokNewsTradingStrategy;
