/**
 * ml-readiness-phase2.test.js — Sprint 16 / ML Data Readiness Phase 2 unit tests
 *
 * Run: node test/ml-readiness-phase2.test.js
 */

"use strict";

const assert = require("assert");
const MLGateService = require("../src/modules/ml/services/MLGateService");
const { transformEngineRow } = require("../src/modules/ml/services/StrategyPerformanceAggregation");
const FeatureImportanceAnalyzer = require("../src/modules/ml/services/FeatureImportanceAnalyzer");
const WinPredictor = require("../src/modules/ml/domain/WinPredictor");
const FeatureEngineer = require("../src/modules/ml/domain/FeatureEngineer");
const { FEATURE_NAMES } = require("../src/modules/ml/domain/FeatureEngineer");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(".");
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${name}: ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(".");
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${name}: ${err.message}`);
  }
}

// ── Task 2.1: ML Gate ────────────────────────────────────────────────────────

test("MLGateService shadow mode never blocks low pWin", () => {
  const prev = process.env.ML_GATE_MODE;
  process.env.ML_GATE_MODE = "shadow";
  const gate = new MLGateService(new WinPredictor(), new FeatureEngineer());
  const verdict = gate.evaluateEntry({
    entryContext: { confidenceScore: 30, htfRegime: "ranging" },
    strategyKey:  "TREND_FOLLOWING",
    symbol:       "BTCUSDT",
    tradeCount:   500,
  });
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.mode, "shadow");
  process.env.ML_GATE_MODE = prev;
});

test("MLGateService active mode blocks low pWin", () => {
  const prevMode = process.env.ML_GATE_MODE;
  const prevThresh = process.env.ML_WIN_GATE_THRESHOLD;
  process.env.ML_GATE_MODE = "active";
  process.env.ML_WIN_GATE_THRESHOLD = "0.99";
  const gate = new MLGateService(new WinPredictor(), new FeatureEngineer());
  const verdict = gate.evaluateEntry({
    entryContext: { confidenceScore: 50 },
    strategyKey:  "SMART_MONEY_CONCEPTS",
    symbol:       "ETHUSDT",
    tradeCount:   500,
  });
  assert.strictEqual(verdict.allowed, false);
  assert.ok(verdict.reason.includes("ML gate"));
  process.env.ML_GATE_MODE = prevMode;
  process.env.ML_WIN_GATE_THRESHOLD = prevThresh;
});

test("MLGateService cold-start uses regime defaults", () => {
  const prev = process.env.ML_GATE_MODE;
  process.env.ML_GATE_MODE = "active";
  const gate = new MLGateService(new WinPredictor(), new FeatureEngineer());
  const lowConf = gate.evaluateEntry({
    entryContext: { confidenceScore: 50, htfRegime: "ranging" },
    strategyKey:  "TREND_FOLLOWING",
    symbol:       "BTCUSDT",
    tradeCount:   50,
  });
  assert.strictEqual(lowConf.allowed, false);
  assert.strictEqual(lowConf.source, "regime_defaults");

  const highConf = gate.evaluateEntry({
    entryContext: { confidenceScore: 80, htfRegime: "ranging" },
    strategyKey:  "TREND_FOLLOWING",
    symbol:       "BTCUSDT",
    tradeCount:   50,
  });
  assert.strictEqual(highConf.allowed, true);
  process.env.ML_GATE_MODE = prev;
});

test("MLGateService disabled mode always allows", () => {
  const prev = process.env.ML_GATE_MODE;
  process.env.ML_GATE_MODE = "disabled";
  const gate = new MLGateService(new WinPredictor(), new FeatureEngineer());
  const verdict = gate.evaluateEntry({
    entryContext: {},
    strategyKey:  "UNKNOWN",
    symbol:       "BTCUSDT",
    tradeCount:   0,
  });
  assert.strictEqual(verdict.allowed, true);
  assert.strictEqual(verdict.source, "disabled");
  process.env.ML_GATE_MODE = prev;
});

// ── Task 2.2: Engine trades aggregation transform ────────────────────────────

test("transformEngineRow maps engine trade to aggregation shape", () => {
  const row = {
    id: 42,
    symbol: "BTCUSDT",
    side: "LONG",
    entry_price: 50000,
    open_time: new Date("2026-07-17T10:00:00Z"),
    close_time: new Date("2026-07-17T12:00:00Z"),
    pnl: 100,
    pnl_pct: 2,
    strategy_name: "WYCKOFF",
    pair_tier: "LIQUID",
    indicators: JSON.stringify({
      htfTrend: "BULLISH",
      afMarketCond: "trending_up",
      afAggregateConfidence: 72,
    }),
    entry_context: null,
    exit_context: null,
    status: "closed",
  };
  const trade = transformEngineRow(row);
  assert.strictEqual(trade.symbol, "BTCUSDT");
  assert.strictEqual(trade.pnl, 100);
  assert.ok(trade.entryContext);
  assert.strictEqual(trade.entryContext.pairTier, "LIQUID");
  assert.ok(trade.entryContext.strategyKey);
});

test("transformEngineRow prefers entry_context when present", () => {
  const ec = {
    strategyKey: "VOLUME_SPREAD_ANALYSIS",
    pairTier: "MICRO",
    regime: "volatile",
    confidenceScore: 65,
  };
  const row = {
    id: 1,
    symbol: "SOLUSDT",
    side: "SHORT",
    entry_price: 150,
    open_time: new Date(),
    close_time: new Date(),
    pnl: -5,
    pnl_pct: -1,
    strategy_name: "AF_VSA",
    pair_tier: "MICRO",
    indicators: null,
    entry_context: ec,
    exit_context: null,
    status: "closed",
  };
  const trade = transformEngineRow(row);
  assert.strictEqual(trade.entryContext.strategyKey, "VOLUME_SPREAD_ANALYSIS");
  assert.strictEqual(trade.entryContext.pairTier, "MICRO");
});

// ── Task 2.3: Feature Importance ─────────────────────────────────────────────

testAsync("FeatureImportanceAnalyzer returns top features from synthetic samples", async () => {
  const fe = new FeatureEngineer();
  const wp = new WinPredictor();
  await wp.train([
    { features: fe.buildFeatureVector({ confidenceScore: 80, bosScore: 70 }, { strategyKey: "SMART_MONEY_CONCEPTS" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 30, bosScore: 20 }, { strategyKey: "SMART_MONEY_CONCEPTS" }), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 75, bosScore: 65 }, { strategyKey: "TREND_FOLLOWING" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 25, bosScore: 15 }, { strategyKey: "TREND_FOLLOWING" }), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 70, bosScore: 60 }, { strategyKey: "MEAN_REVERSION" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 20, bosScore: 10 }, { strategyKey: "MEAN_REVERSION" }), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 85, bosScore: 75 }, { strategyKey: "BREAKOUT_RETEST" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 35, bosScore: 25 }, { strategyKey: "BREAKOUT_RETEST" }), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 60, bosScore: 55 }, { strategyKey: "SMART_MONEY_CONCEPTS" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 40, bosScore: 35 }, { strategyKey: "SMART_MONEY_CONCEPTS" }), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 55, bosScore: 50 }, { strategyKey: "TREND_FOLLOWING" }), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 45, bosScore: 40 }, { strategyKey: "TREND_FOLLOWING" }), label: 0 },
  ]);

  const analyzer = new FeatureImportanceAnalyzer(wp, fe);
  const samples = [
    { features: fe.buildFeatureVector({ confidenceScore: 80 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 20 }, {}), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 75 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 25 }, {}), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 70 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 30 }, {}), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 65 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 35 }, {}), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 60 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 40 }, {}), label: 0 },
    { features: fe.buildFeatureVector({ confidenceScore: 55 }, {}), label: 1 },
    { features: fe.buildFeatureVector({ confidenceScore: 45 }, {}), label: 0 },
  ];
  const result = await analyzer.analyze({ tradeSamples: samples, model: wp });
  assert.ok(Array.isArray(result.importance));
  assert.ok(result.importance.length > 0);
  assert.ok(result.top5.length <= 5);
  assert.ok(result.importance.every((r) => FEATURE_NAMES.includes(r.name) || r.name));
  assert.ok(result.analyzedAt);
});

(async () => {
  await testAsync("FeatureImportanceAnalyzer falls back to model builtin with few samples", async () => {
    const wp = new WinPredictor();
    await wp.train([
      { features: new Float32Array(60).fill(0.5), label: 1 },
      { features: new Float32Array(60).fill(0.3), label: 0 },
    ]);
    const analyzer = new FeatureImportanceAnalyzer(wp, new FeatureEngineer());
    const result = await analyzer.analyze({ tradeSamples: [], model: wp });
    assert.strictEqual(result.source, "model_builtin");
  });

  console.log(`\n\nML Readiness Phase 2: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
