"use strict";

const assert = require("assert");
const {
  CryptoNewsClient,
  DEFAULT_MACRO_QUERIES,
  DEFAULT_MACRO_FALLBACK_FEEDS,
  classifyMacroEvent,
  _cache,
} = require("../src/infrastructure/news/CryptoNewsClient");
const { NEWS_EVENT_TYPE_LIST, NEWS_EVENT_TIERS } = require("../src/config/newsEventTypes");

assert.deepStrictEqual(DEFAULT_MACRO_QUERIES, [
  "FOMC",
  "Federal Reserve",
  "CPI",
  "PCE",
  "NFP",
  "GDP",
  "PMI",
  "retail sales",
  "jobless claims",
  "ETF",
  "SEC",
  "hack",
  "stablecoin",
  "liquidation",
]);
assert.deepStrictEqual(DEFAULT_MACRO_FALLBACK_FEEDS.map((feed) => feed.path), ["/news", "/breaking"]);
assert.strictEqual(classifyMacroEvent({ title: "FOMC minutes show officials split" }).type, "FED_MINUTES");
assert.strictEqual(classifyMacroEvent({ title: "Fed announces interest rate decision" }).type, "FOMC_RATE_DECISION");
assert.strictEqual(classifyMacroEvent({ title: "Powell FOMC press conference today" }).type, "FED_PRESS_CONFERENCE");
assert.strictEqual(classifyMacroEvent({ title: "Fed dot plot shifts higher" }).type, "FED_PROJECTIONS");
assert.strictEqual(classifyMacroEvent({ title: "US CPI inflation data cools" }).type, "CPI_INFLATION");
assert.strictEqual(classifyMacroEvent({ title: "Core PCE inflation rises" }).type, "PCE_INFLATION");
assert.strictEqual(classifyMacroEvent({ title: "NFP non-farm payrolls and unemployment report" }).type, "NFP_UNEMPLOYMENT");
assert.strictEqual(classifyMacroEvent({ title: "Inflation data surprises markets" }).type, "CPI_INFLATION");
assert.strictEqual(classifyMacroEvent({ title: "October rate pause now expected" }).type, "FOMC_RATE_DECISION");
assert.strictEqual(classifyMacroEvent({ title: "SEC approves spot Bitcoin ETF" }).type, "REGULATORY_SHOCK");
assert.strictEqual(classifyMacroEvent({ title: "Bitcoin ETF outflows hit a record" }).type, "ETF_FLOW_SHOCK");
assert.strictEqual(classifyMacroEvent({ title: "USDT depeg fears spread" }).type, "STABLECOIN_DEPEG");
assert.strictEqual(classifyMacroEvent({ title: "Major crypto exchange suffers hack" }).type, "SECURITY_INCIDENT");
assert.strictEqual(classifyMacroEvent({ title: "Bitcoin long liquidations surge" }).type, "LIQUIDATION_EVENT");
assert.strictEqual(classifyMacroEvent({ title: "Federal Reserve Governor speech on rates" }).type, "FED_SPEECH");
assert.strictEqual(classifyMacroEvent({ title: "US GDP growth slows" }).type, "GDP_GROWTH");
assert.strictEqual(classifyMacroEvent({ title: "ISM manufacturing PMI falls" }).type, "PMI_ACTIVITY");
assert.strictEqual(classifyMacroEvent({ title: "US retail sales miss forecasts" }).type, "RETAIL_SALES");
assert.strictEqual(classifyMacroEvent({ title: "Initial jobless claims rise" }).type, "JOBLESS_CLAIMS");
assert.strictEqual(classifyMacroEvent({ title: "Bitcoin technical breakout" }), null);
assert.strictEqual(classifyMacroEvent({ title: "US stock ETF inflows rise" }), null);
assert.strictEqual(classifyMacroEvent({ title: "Stock exchange suffers a hack" }), null);
assert.strictEqual(classifyMacroEvent({ title: "Stock market liquidations surge" }), null);
assert.deepStrictEqual(Object.keys(NEWS_EVENT_TIERS), NEWS_EVENT_TYPE_LIST);

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
        if (path.endsWith("/news") || path.endsWith("/breaking")) {
          return { data: { articles: [] } };
        }
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
  assert.strictEqual(news[0].eventTier, "A");
  assert.strictEqual(news[0].ageMinutes, 5);
  assert.strictEqual(client.lastDiagnostics.successfulSearches, 1);

  _cache.clear();
  const batchedQueries = [];
  const batchedClient = new CryptoNewsClient({
    baseUrl: "https://batch.test/api",
    queries: ["q1", "q2", "q3", "q4", "q5"],
    searchBatchSize: 2,
    fallbackFeeds: [],
    http: {
      get: async (path, options) => {
        assert.strictEqual(path, "https://batch.test/api/search");
        batchedQueries.push(options.params.q);
        return { data: { articles: [] } };
      },
    },
  });
  await batchedClient.getHighImpactNews({ force: true });
  await batchedClient.getHighImpactNews({ force: true });
  assert.deepStrictEqual(batchedQueries, ["q1", "q2", "q3", "q4"]);

  _cache.clear();
  const fallbackClient = new CryptoNewsClient({
    baseUrl: "https://fallback.test/api",
    queries: ["macro"],
    maxAgeMinutes: 180,
    now: () => now,
    http: {
      get: async (path) => {
        if (path.endsWith("/search")) return { data: { articles: [] } };
        if (path.endsWith("/news")) {
          return {
            data: {
              articles: [{
                id: "fallback-1",
                title: "Federal Reserve signals a rate pause",
                source: "FallbackWire",
                pubDate: "2026-10-06T23:50:00.000Z",
              }],
            },
          };
        }
        return { data: { articles: [] } };
      },
    },
  });

  const fallbackNews = await fallbackClient.getHighImpactNews({ symbol: "ETHUSDT" });
  assert.strictEqual(fallbackNews.length, 1);
  assert.strictEqual(fallbackNews[0].id, "fallback-1");
  assert.strictEqual(fallbackClient.lastDiagnostics.successfulFeeds, 2);

  _cache.clear();
  let unavailableCalls = 0;
  const unavailableClient = new CryptoNewsClient({
    baseUrl: "https://unavailable.test/api",
    queries: ["macro"],
    http: {
      get: async () => {
        unavailableCalls += 1;
        throw new Error("network down");
      },
    },
  });
  await assert.rejects(
    () => unavailableClient.getHighImpactNews({ symbol: "BTCUSDT" }),
    (err) => err.code === "NEWS_API_UNAVAILABLE",
  );
  await assert.rejects(
    () => unavailableClient.getHighImpactNews({ symbol: "ETHUSDT" }),
    (err) => err.code === "NEWS_API_UNAVAILABLE" && err.diagnostics.cacheHit === true,
  );
  assert.strictEqual(unavailableCalls, 3, "cached API failures must not re-hit the provider");
}

run().then(() => {
  console.log("crypto-news-client.test.js: all assertions passed");
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
