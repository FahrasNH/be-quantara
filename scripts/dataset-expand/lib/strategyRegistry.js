"use strict";

/**
 * 12 canonical strategy keys ↔ folder slugs for dataset-expand scripts.
 * SSOT: strategySupportedTypes.js + runBacktestJob TYPE_TF ladder.
 */

const { STRATEGY_SUPPORTED_TYPES } = require("../../../src/shared/constants/strategySupportedTypes");

const DATASET_EXPAND_STRATEGIES = [
  { key: "SMART_MONEY_CONCEPTS", slug: "smart-money-concepts", umbrella: "AF" },
  { key: "WYCKOFF", slug: "wyckoff", umbrella: "AF" },
  { key: "VOLUME_SPREAD_ANALYSIS", slug: "volume-spread-analysis", umbrella: "AF" },
  { key: "TREND_FOLLOWING", slug: "trend-following", umbrella: "TS" },
  { key: "MARKET_STRUCTURE", slug: "market-structure", umbrella: "TS" },
  { key: "AUCTION_MARKET_THEORY", slug: "auction-market-theory", umbrella: "TS" },
  { key: "MEAN_REVERSION", slug: "mean-reversion", umbrella: "MD" },
  { key: "SUPPLY_AND_DEMAND", slug: "supply-and-demand", umbrella: "MD" },
  { key: "STATISTICAL_ARBITRAGE", slug: "statistical-arbitrage", umbrella: "MD" },
  { key: "BREAKOUT_RETEST", slug: "breakout-retest", umbrella: "BS" },
  { key: "ICT_STYLE_TRADING", slug: "ict-style-trading", umbrella: "BS" },
  { key: "LIQUIDATION_SQUEEZE", slug: "liquidation-squeeze", umbrella: "BS" },
];

const SLUG_BY_KEY = Object.fromEntries(DATASET_EXPAND_STRATEGIES.map((s) => [s.key, s.slug]));
const KEY_BY_SLUG = Object.fromEntries(DATASET_EXPAND_STRATEGIES.map((s) => [s.slug, s.key]));

const TRADE_TYPES = ["Scalping", "Intraday", "Swing"];
const TRADE_TYPE_FILE = {
  Scalping: "scalping",
  Intraday: "intraday",
  Swing: "swing",
};

function isAfStrategy(strategyKey) {
  return DATASET_EXPAND_STRATEGIES.find((s) => s.key === strategyKey)?.umbrella === "AF";
}

function naturalTypeOrder(strategyKey) {
  return STRATEGY_SUPPORTED_TYPES[strategyKey] || TRADE_TYPES;
}

module.exports = {
  DATASET_EXPAND_STRATEGIES,
  SLUG_BY_KEY,
  KEY_BY_SLUG,
  TRADE_TYPES,
  TRADE_TYPE_FILE,
  isAfStrategy,
  naturalTypeOrder,
};
