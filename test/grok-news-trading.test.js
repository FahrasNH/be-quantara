"use strict";

const assert = require("assert");
const GrokNewsTradingService = require("../src/modules/research/services/GrokNewsTradingService");
const { GrokNewsTradingPromptBuilder } = require("../src/modules/research/services/GrokNewsTradingPromptBuilder");

const news = [{
  id: "cpi-1",
  title: "US CPI inflation data cools",
  description: "Consumer price index report",
  source: "TestWire",
  publishedAt: "2026-10-06T23:55:00.000Z",
  ageMinutes: 5,
  eventType: "CPI_INFLATION",
  eventLabel: "CPI / Data Inflasi",
}];

const ctx = {
  symbol: "BTCUSDT",
  price: 98_000,
  atr: 500,
  atrMinMult: 1,
  minRiskReward: 1.5,
  minConfidenceEntry: 8,
  minConfidenceTpSl: 7,
  hasOpenPosition: false,
  news,
};

const validTrade = {
  symbol: "BTCUSDT",
  side: "LONG",
  entry: "MARKET",
  take_profit: 100_000,
  stop_loss: 97_000,
  confidence: 8,
  event_type: "CPI_INFLATION",
  news_id: "cpi-1",
  reasoning: "Fresh CPI surprise with actionable reaction",
};

const valid = GrokNewsTradingService.validateTrade(validTrade, ctx);
assert.strictEqual(valid.valid, true);
assert.strictEqual(valid.entryAllowed, true);
assert.strictEqual(valid.newsId, "cpi-1");
assert.strictEqual(valid.riskReward, 2);

assert.strictEqual(
  GrokNewsTradingService.validateTrade({ ...validTrade, news_id: "invented" }, ctx).valid,
  false,
);
assert.strictEqual(
  GrokNewsTradingService.validateTrade({ ...validTrade, entry: undefined }, ctx).rejected,
  "entry_required",
);
assert.strictEqual(
  GrokNewsTradingService.validateTrade({ ...validTrade, entry: 98_000 }, ctx).rejected,
  "entry_must_be_market",
);
assert.strictEqual(
  GrokNewsTradingService.validateTrade({ ...validTrade, take_profit: 98_100 }, ctx).rejected,
  "risk_reward_too_low",
);
assert.strictEqual(
  GrokNewsTradingService.validateTrade(validTrade, { ...ctx, news: [] }).rejected,
  "no_fresh_macro_news",
);

const prompt = GrokNewsTradingPromptBuilder.build({
  ...ctx,
  multiTfCandles: {},
});
assert.strictEqual(prompt.hasRequiredSections, true);
assert.match(prompt.text, /NEWS IS A HARD PREREQUISITE/);
assert.match(prompt.text, /cpi-1/);
assert.strictEqual(prompt.payload.news_required, true);
assert.strictEqual(prompt.payload.min_risk_reward, 1.5);

async function runMockDecision() {
  const fixture = JSON.stringify({ trades: [validTrade], position_actions: [] });
  const originalEnabled = GrokNewsTradingService.isEnabled;
  const originalClient = GrokNewsTradingService._client;
  GrokNewsTradingService.isEnabled = () => true;
  GrokNewsTradingService._client = {
    isConfigured: true,
    chat: async () => fixture,
  };
  try {
    const decision = await GrokNewsTradingService.requestTradeDecision(ctx);
    assert.strictEqual(decision.entryAllowed, true);
    assert.strictEqual(decision.eventType, "CPI_INFLATION");
    assert.strictEqual(decision.newsId, "cpi-1");
  } finally {
    GrokNewsTradingService.isEnabled = originalEnabled;
    GrokNewsTradingService._client = originalClient;
  }
}

runMockDecision().then(() => {
  console.log("grok-news-trading.test.js: all assertions passed");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
