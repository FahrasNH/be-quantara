"use strict";

const assert = require("assert");
const {
  CryptoNewsClient,
  classifyMacroEvent,
  _cache,
} = require("../src/infrastructure/news/CryptoNewsClient");

assert.strictEqual(classifyMacroEvent({ title: "FOMC minutes show officials split" }).type, "FED_MINUTES");
assert.strictEqual(classifyMacroEvent({ title: "Fed announces interest rate decision" }).type, "FOMC_RATE_DECISION");
assert.strictEqual(classifyMacroEvent({ title: "US CPI inflation data cools" }).type, "CPI_INFLATION");
assert.strictEqual(classifyMacroEvent({ title: "NFP non-farm payrolls and unemployment report" }).type, "NFP_UNEMPLOYMENT");
assert.strictEqual(classifyMacroEvent({ title: "Bitcoin technical breakout" }), null);

async function run() {
  _cache.clear();
  const now = Date.parse("2026-10-07T00:00:00.000Z");
  const articles = [
    {
      id: "minutes-1",
      title: "FOMC minutes show officials split",
      description: "Fresh Fed meeting minutes",
      source: "TestWire",
      link: "https://example.test/minutes-1",
      pubDate: "2026-10-06T23:55:00.000Z",
    },
    {
      id: "stale-1",
      title: "CPI inflation data from last week",
      source: "TestWire",
      pubDate: "2026-10-06T00:00:00.000Z",
    },
  ];
  const client = new CryptoNewsClient({
    baseUrl: "https://news.test/api",
    queries: ["macro"],
    maxAgeMinutes: 180,
    now: () => now,
    http: {
      get: async (path, options) => {
        assert.strictEqual(path, "https://news.test/api/search");
        assert.strictEqual(options.params.q, "macro");
        return { data: { articles } };
      },
    },
  });

  const news = await client.getHighImpactNews({ symbol: "BTCUSDT" });
  assert.strictEqual(news.length, 1);
  assert.strictEqual(news[0].id, "minutes-1");
  assert.strictEqual(news[0].eventType, "FED_MINUTES");
  assert.strictEqual(news[0].ageMinutes, 5);
}

run().then(() => {
  console.log("crypto-news-client.test.js: all assertions passed");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
