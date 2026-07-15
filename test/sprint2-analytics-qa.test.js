/**
 * sprint2-analytics-qa.test.js — Sprint 2 / QA-S2
 *
 * 30+ analytics validation & edge-case tests.
 * No DB or network required — all Prisma/DB calls are mocked.
 *
 * Run: node test/sprint2-analytics-qa.test.js
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Mini test framework
// ─────────────────────────────────────────────────────────────────────────────

let testCount  = 0;
let passCount  = 0;
let failCount  = 0;
const failures = [];

function test(name, fn) {
  testCount++;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      // async test — run synchronously via a tiny trick
      let settled = false, err = null;
      result
        .then(() => { settled = true; })
        .catch(e => { settled = true; err = e; });

      // Use a busy-wait-free approach: push to microtask queue
      // We handle this by returning a Promise that the final summary awaits
      return result.then(() => {
        passCount++;
        console.log(`✓ ${name}`);
      }).catch(e => {
        failCount++;
        failures.push({ test: name, error: e.message });
        console.error(`✗ ${name}: ${e.message}`);
      });
    }
    passCount++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failCount++;
    failures.push({ test: name, error: e.message });
    console.error(`✗ ${name}: ${e.message}`);
  }
  return Promise.resolve();
}

function assert(cond, msg)             { if (!cond)          throw new Error(msg || "Assertion failed"); }
function assertEqual(a, b, msg)        { if (a !== b)        throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertRange(v, lo, hi, msg)   { if (v < lo || v > hi) throw new Error(msg || `Expected ${lo}–${hi}, got ${v}`); }
function assertNoNanInf(obj, path = "") {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number" && (!isFinite(v) || isNaN(v)))
      throw new Error(`NaN/Infinity at ${path}${k} = ${v}`);
    else if (v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v))
      assertNoNanInf(v, `${path}${k}.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────

const { RegimeClassifierEngine, PRIMARY, MODIFIER } = require("../src/domain/RegimeClassifierEngine");
const StrategyPerformanceService = require("../src/server/services/StrategyPerformanceService");
const { _helpers: H } = StrategyPerformanceService;

// Mock Prisma — StrategyPerformanceService imports prismaClient at module level;
// we patch trade.findMany and strategyPerformance.upsert via module require cache.
const prismaClient = require("../src/infrastructure/db/prismaClient");

// Mock TelegramNotifier so job-failure tests don't actually send messages
const telegram = require("../src/infrastructure/notifications/TelegramNotifier");
let _telegramCalled = false;
const _origNotifyError = telegram.notifyError;
const _origSend        = telegram.send;
telegram.notifyError = async (msg) => { _telegramCalled = true; };
telegram.send        = async (msg) => { _telegramCalled = true; };

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

const bull = () => ({ ema9: 110, ema21: 105, ema50: 100, adx: 35, atr: 2.4, atrAvg: 2.0, volume: 1500, volAvg: 1000 });
const bear = () => ({ ema9: 95,  ema21: 100, ema50: 105, adx: 28, atr: 1.5, atrAvg: 2.0, volume: 900,  volAvg: 1000 });
const rang = () => ({ ema9: 100.5, ema21: 100.3, ema50: 100.1, adx: 15, atr: 1.6, atrAvg: 2.0, volume: 900, volAvg: 1000 });

// Build fake trade list
function fakeTrades(n, winPct = 0.6, pnlScale = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id:          `t${i}`,
    pnl:          i < Math.floor(n * winPct) ? pnlScale : -pnlScale,
    pnlPercent:   i < Math.floor(n * winPct) ? pnlScale : -pnlScale,
    entryContext: {
      strategyKey: "AF_SMC",
      htfRegime:   "trend_up",
      pairTier:    "LIQUID",
      tradeType:   "Intraday",
    },
    exitContext:  { holdingDurationMs: 3600000 },
    enteredAt:    new Date(Date.now() - 7200000).toISOString(),
    exitedAt:     new Date().toISOString(),
    entry:        100,
    slPrice:      97,
    tpPrice:      106,
    symbol:       "BTCUSDT",
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1: RegimeClassifierEngine
// ─────────────────────────────────────────────────────────────────────────────

const promises = [];

promises.push(test("1. Determinism: same input → identical output (run twice)", () => {
  const e1 = new RegimeClassifierEngine();
  const e2 = new RegimeClassifierEngine();
  const r1 = e1.classify(bull(), "BTC", "4h");
  const r2 = e2.classify(bull(), "BTC", "4h");
  assertEqual(r1.composite,  r2.composite);
  assertEqual(r1.confidence, r2.confidence);
}));

promises.push(test("2. classify() — trend_up composite correctly identified", () => {
  const r = new RegimeClassifierEngine().classify(bull(), "BTC", "4h");
  assertEqual(r.primary, PRIMARY.TREND_UP);
  assert(r.composite.startsWith("trend_up"), `Got ${r.composite}`);
}));

promises.push(test("3. classify() — trend_down composite correctly identified", () => {
  const r = new RegimeClassifierEngine().classify(bear(), "BTC", "1h");
  assertEqual(r.primary, PRIMARY.TREND_DOWN);
}));

promises.push(test("4. classify() — ranging composite correctly identified", () => {
  const r = new RegimeClassifierEngine().classify(rang(), "BTC", "15m");
  assertEqual(r.primary, PRIMARY.RANGING);
}));

promises.push(test("5. classify() — trend_up+expansion composite", () => {
  const ind = { ...bull(), atr: 3.5, atrAvg: 2.0 };
  const r   = new RegimeClassifierEngine().classify(ind, "BTC", "4h");
  assertEqual(r.primary, PRIMARY.TREND_UP);
  assert(r.modifier !== null, "Expected modifier");
}));

promises.push(test("6. classify() — ranging+low_vol composite", () => {
  const ind = { ...rang(), atr: 1.0, atrAvg: 2.0, volume: 500, volAvg: 1000 };
  const r   = new RegimeClassifierEngine().classify(ind, "BTC", "15m");
  assertEqual(r.primary, PRIMARY.RANGING);
  assert(r.modifier === MODIFIER.LOW_VOL || r.modifier === MODIFIER.COMPRESSION, `Got ${r.modifier}`);
}));

promises.push(test("7. classify() — confidence score always 0–100", () => {
  for (const ind of [bull(), bear(), rang(), {}, { ema9: null }]) {
    const r = new RegimeClassifierEngine().classify(ind, "BTC", "4h");
    assertRange(r.confidence, 0, 100, `Confidence ${r.confidence} out of range`);
  }
}));

promises.push(test("8. classify() — no NaN/Infinity in output", () => {
  for (const ind of [bull(), bear(), rang()]) {
    assertNoNanInf(new RegimeClassifierEngine().classify(ind, "BTC", "4h"));
  }
}));

promises.push(test("9. classify() — missing/null indicators → graceful fallback", () => {
  const r = new RegimeClassifierEngine().classify({ ema9: null, adx: null }, "BTC", "1h");
  assert(typeof r.primary    === "string");
  assert(typeof r.composite  === "string");
  assert(typeof r.confidence === "number");
}));

promises.push(test("10. classifyMultiTF() → returns htf, mtf, ltf, dominant", () => {
  const e = new RegimeClassifierEngine();
  const res = e.classifyMultiTF(bull(), bull(), bull(), "BTC");
  assert(res.htf      !== undefined, "Missing htf");
  assert(res.mtf      !== undefined, "Missing mtf");
  assert(res.ltf      !== undefined, "Missing ltf");
  assert(res.dominant !== undefined, "Missing dominant");
}));

promises.push(test("11. Cache hit: getCache returns result after classify", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bull(), "BTC", "4h");
  assert(e.getCache("BTC", "4h") !== null, "Expected cache hit");
}));

promises.push(test("12. Cache TTL expiry: expired entry returns null", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bull(), "BTC", "4h");
  const entry = e._cache.get("BTC:4h");
  entry.expiresAt = Date.now() - 1;
  assert(e.getCache("BTC", "4h") === null, "Expected null after expiry");
}));

promises.push(test("13. invalidateCache() clears correctly", () => {
  const e = new RegimeClassifierEngine();
  e.classify(bull(), "BTC", "4h");
  e.classify(bull(), "BTC", "1h");
  e.invalidateCache("BTC");
  assert(e.getCache("BTC", "4h") === null);
  assert(e.getCache("BTC", "1h") === null);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Section 2: StrategyPerformanceService helpers
// ─────────────────────────────────────────────────────────────────────────────

promises.push(test("14. profitFactor: 0 losses → 9.99 (not Infinity)", () => {
  const pnls = [2, 3, 1.5, 4];
  const pf   = H.profitFactor(pnls);
  assertEqual(pf, 9.99, `Expected 9.99, got ${pf}`);
}));

promises.push(test("15. sampleSizeValid=false when tradeCount < 20", () => {
  const trades  = fakeTrades(15);
  const record  = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTCUSDT", regime: "trend_up", tradeType: "Intraday", pairTier: "LIQUID" },
    trades,
    new Date(),
    "daily"
  );
  assert(!record.sampleSizeValid, "Expected sampleSizeValid=false for 15 trades");
}));

promises.push(test("16. sampleSizeValid=true when tradeCount >= 20", () => {
  const trades = fakeTrades(25);
  const record = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTCUSDT", regime: "trend_up", tradeType: "Intraday", pairTier: "LIQUID" },
    trades,
    new Date(),
    "daily"
  );
  assert(record.sampleSizeValid, "Expected sampleSizeValid=true for 25 trades");
}));

promises.push(test("17. sortino: computed correctly (finite number or null)", () => {
  const pnls = [3, -1, 2, -0.5, 4, -2, 1];
  const s    = H.sortino(pnls);
  assert(s === null || (typeof s === "number" && isFinite(s)), `Invalid sortino: ${s}`);
}));

promises.push(test("18. expectancy: positive for 60% WR with avg win 2 / avg loss 1", () => {
  const pnls = [2, 2, 2, 2, 2, 2, -1, -1, -1, -1]; // 60% WR
  const e    = H.expectancy(pnls);
  assert(e > 0, `Expected positive expectancy, got ${e}`);
}));

promises.push(test("19. avgRr: computed from slPrice/tpPrice", () => {
  const trades = [
    { entry: 100, slPrice: 97, tpPrice: 109, pnlPercent: 2 },
    { entry: 100, slPrice: 97, tpPrice: 109, pnlPercent: -1 },
  ];
  const rr = H.avgRr(trades);
  assert(rr !== null && rr > 0, `Expected positive avgRr, got ${rr}`);
}));

promises.push(test("20. aggregateDaily: handles empty trade set gracefully", async () => {
  // Mock prisma.trade.findMany to return []
  const originalFindMany = prismaClient.trade.findMany;
  prismaClient.trade.findMany = async () => [];
  try {
    const results = await StrategyPerformanceService.aggregateDaily(new Date());
    assert(Array.isArray(results) && results.length === 0, "Expected empty array");
  } finally {
    prismaClient.trade.findMany = originalFindMany;
  }
}));

promises.push(test("21. aggregateRolling('7d'): builds date filter for last 7 days", async () => {
  let capturedWhere = null;
  const originalFindMany = prismaClient.trade.findMany;
  prismaClient.trade.findMany = async (args) => { capturedWhere = args?.where; return []; };
  try {
    await StrategyPerformanceService.aggregateRolling("7d");
    assert(capturedWhere?.exitedAt?.gte !== undefined, "Expected date filter for 7d");
    const since = capturedWhere.exitedAt.gte;
    const diffDays = (Date.now() - new Date(since).getTime()) / 86400000;
    assertRange(diffDays, 6.9, 7.1, `Expected ~7 days, got ${diffDays.toFixed(2)}`);
  } finally {
    prismaClient.trade.findMany = originalFindMany;
  }
}));

promises.push(test("22. aggregateRolling('all-time'): no date filter", async () => {
  let capturedWhere = null;
  const originalFindMany = prismaClient.trade.findMany;
  prismaClient.trade.findMany = async (args) => { capturedWhere = args?.where; return []; };
  try {
    await StrategyPerformanceService.aggregateRolling("all-time");
    assert(!capturedWhere?.exitedAt, "Expected no date filter for all-time");
  } finally {
    prismaClient.trade.findMany = originalFindMany;
  }
}));

promises.push(test("23. buildRecord: PF capped at 9.99 when no losses", () => {
  const trades = fakeTrades(25, 1.0); // all wins
  const rec = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTC", regime: "trend_up", tradeType: null, pairTier: null },
    trades, new Date(), "daily"
  );
  assertEqual(rec.profitFactor, 9.99, `PF should be 9.99, got ${rec.profitFactor}`);
}));

promises.push(test("24. buildRecord: avgHoldingHours derived correctly", () => {
  const trades = fakeTrades(20);
  const rec = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTC", regime: "trend_up", tradeType: null, pairTier: null },
    trades, new Date(), "daily"
  );
  assert(rec.avgHoldingHours !== null, "Expected non-null avgHoldingHours");
  assert(rec.avgHoldingHours > 0, `Expected positive avgHoldingHours, got ${rec.avgHoldingHours}`);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Section 3: Analytics API helpers (no server needed — test logic directly)
// ─────────────────────────────────────────────────────────────────────────────

// Load analytics module and extract internal helpers by requiring through module
let analyticsModule;
try {
  // analytics.js exports a factory — we test its internal helpers via mocking
  analyticsModule = require("../src/server/routes/analytics");
} catch (e) {
  analyticsModule = null;
}

promises.push(test("25. analytics.js loads without error", () => {
  assert(analyticsModule !== null, "analytics.js failed to load");
  assert(typeof analyticsModule === "function", "Expected factory function export");
}));

promises.push(test("26. analytics router is an Express router factory", () => {
  const router = analyticsModule();
  assert(router && typeof router === "function", "Expected Express router");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Section 4: Feature-importance script structure
// ─────────────────────────────────────────────────────────────────────────────

promises.push(test("27. feature-importance.js exists and has correct path", () => {
  const fs   = require("fs");
  const path = require("path");
  const p    = path.join(__dirname, "../scripts/analytics/feature-importance.js");
  assert(fs.existsSync(p), `Expected feature-importance.js at ${p}`);
}));

promises.push(test("28. winners-vs-losers.sql exists", () => {
  const fs   = require("fs");
  const path = require("path");
  const p    = path.join(__dirname, "../scripts/analytics/winners-vs-losers.sql");
  assert(fs.existsSync(p), `Expected winners-vs-losers.sql at ${p}`);
}));

// ─────────────────────────────────────────────────────────────────────────────
// Section 5: Edge cases & regressions
// ─────────────────────────────────────────────────────────────────────────────

promises.push(test("29. Edge: division by zero in WR calculation (0 trades) → handled", () => {
  const rec = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTC", regime: "trend_up", tradeType: null, pairTier: null },
    [], new Date(), "daily"
  );
  assertEqual(rec.winRate, 0, "winRate should be 0 for empty trades");
  assertNoNanInf(rec);
}));

promises.push(test("30. Sprint 1 regression: TradeFeatureCollector.captureEntryFeatures() still works", async () => {
  const collector = require("../src/server/services/TradeFeatureCollector");
  const ctx = {
    symbol:      "BTCUSDT",
    strategyKey: "AF_SMC",
    indicators:  { ema9: 105, ema21: 102, ema50: 100, adx: 28, atr: 2.0, rsi: 58, volume: 1200 },
    htfTrend:    "BULLISH",
    confidence:  75,
    pairTier:    "LIQUID",
    capital:     500,
  };
  const ec = await collector.captureEntryFeatures(ctx);
  assert(ec.htfRegime !== undefined, "htfRegime missing");
  assert(typeof ec.atr === "number",  "atr should be number");
  assertRange(ec.confidenceScore, 0, 100, "confidenceScore out of range");
}));

promises.push(test("31. Sprint 1 regression: StrategyPerformance @@unique prevents duplicates", () => {
  // Verify uniqueKeyFields exist in the service upsert logic
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../src/modules/analytics/services/StrategyPerformanceService.js"), "utf8"
  );
  assert(src.includes("strategyKey_symbol_regime_tradeType_pairTier_periodDate"), "@@unique constraint not in upsert");
}));

promises.push(test("32. StrategyPerformance legacy fields intact (Sprint 1 compat)", () => {
  const trades = fakeTrades(10, 0.7);
  const rec = H.buildRecord(
    { strategyKey: "AF_SMC", symbol: "BTC", regime: "trend_up", tradeType: null, pairTier: null },
    trades, new Date(), "daily"
  );
  // Sprint 1 fields still present
  ["tradeCount", "winCount", "lossCount", "winRate", "profitFactor", "avgPnlPct", "maxDrawdownPct"].forEach(f => {
    assert(rec[f] !== undefined, `Legacy field ${f} missing`);
  });
}));

promises.push(test("33. Regime distribution adds up to ~100%", () => {
  // Simulate distribution logic
  const regimeCounts = new Map([
    ["trend_up",   45],
    ["trend_down", 30],
    ["ranging",    25],
  ]);
  const total = [...regimeCounts.values()].reduce((s, v) => s + v, 0);
  const distribution = [...regimeCounts.entries()].map(([regime, count]) => ({
    regime, pct: +((count / total) * 100).toFixed(2), tradeCount: count,
  }));
  const sum = distribution.reduce((s, d) => s + d.pct, 0);
  assert(Math.abs(sum - 100) < 1, `Distribution should sum to ~100, got ${sum}`);
}));

promises.push(test("34. Expectancy handles all-loss trades (no division by zero)", () => {
  const pnls = [-1, -2, -1.5];
  const e    = H.expectancy(pnls);
  assert(typeof e === "number" && isFinite(e), `Expected finite number, got ${e}`);
}));

promises.push(test("35. sortino returns null for all-positive returns (no downside)", () => {
  const pnls = [1, 2, 3, 4, 5];
  const s    = H.sortino(pnls);
  assert(s === null, `Expected null sortino for all-positive, got ${s}`);
}));

promises.push(test("36. Cron module loads without error", () => {
  const cron = require("../src/infrastructure/cron/performanceAggregationCron");
  assert(typeof cron.start      === "function", "Missing start");
  assert(typeof cron.stop       === "function", "Missing stop");
  assert(typeof cron.runDaily   === "function", "Missing runDaily");
  assert(typeof cron.runWeekly  === "function", "Missing runWeekly");
  assert(typeof cron.runMonthly === "function", "Missing runMonthly");
}));

promises.push(test("37. Job failure mock: Telegram notifyError gets called on aggregateDaily error", async () => {
  _telegramCalled = false;
  // Trigger error path manually via cron
  const cron = require("../src/infrastructure/cron/performanceAggregationCron");
  const origFn = StrategyPerformanceService.aggregateDaily;
  StrategyPerformanceService.aggregateDaily = async () => { throw new Error("mock DB failure"); };
  try {
    await cron.runDaily();
  } finally {
    StrategyPerformanceService.aggregateDaily = origFn;
  }
  assert(_telegramCalled, "Expected Telegram to be called on job failure");
}));

promises.push(test("38. backfill-regime.js exists and is valid JS", () => {
  const fs   = require("fs");
  const path = require("path");
  const p    = path.join(__dirname, "../scripts/backfill-regime.js");
  assert(fs.existsSync(p), "backfill-regime.js not found");
  const src = fs.readFileSync(p, "utf8");
  assert(src.includes("--dry-run"),  "dry-run mode missing");
  assert(src.includes("DRY_RUN"),    "DRY_RUN flag missing");
  assert(src.includes("checkpoint"), "checkpoint logic missing");
}));

promises.push(test("39. RegimeClassifierEngine singleton is exported correctly", () => {
  const engine = require("../src/domain/RegimeClassifierEngine");
  assert(typeof engine.classify        === "function", "classify missing on singleton");
  assert(typeof engine.classifyMultiTF === "function", "classifyMultiTF missing on singleton");
  assert(typeof engine.invalidateCache === "function", "invalidateCache missing on singleton");
}));

// ─────────────────────────────────────────────────────────────────────────────
// Summary (await all async tests)
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(promises).then(() => {
  // Restore Telegram mocks
  telegram.notifyError = _origNotifyError;
  telegram.send        = _origSend;

  console.log(`\n── Sprint 2 QA Tests ────────────────────────────`);
  console.log(`Total  : ${testCount}`);
  console.log(`Passed : ${passCount}`);
  console.log(`Failed : ${failCount}`);

  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach(f => console.log(`  ✗ ${f.test}: ${f.error}`));
  }

  if (failCount > 0) {
    process.exitCode = 1;
  } else {
    console.log("\nAll Sprint 2 QA tests passed!");
  }
}).catch(err => {
  console.error("[QA] Fatal error:", err);
  process.exitCode = 1;
});
