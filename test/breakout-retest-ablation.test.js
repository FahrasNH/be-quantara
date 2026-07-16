/**
 * breakout-retest-ablation.test.js — regression for BREAKOUT_RETEST funnel zeros
 *
 * Root cause (2026-07-16): schema + resetAblation existed on BreakoutTradingStrategy,
 * but evaluateBreakoutTradingEntry never accepted/incremented `ablation`, and
 * detectSignal never passed `this._ablation`. Funnel showed all 0 while trades opened.
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const BreakoutTradingStrategy = require("../src/core/strategy-engine/implementations/BreakoutTradingStrategy");
const BreakoutStormUmbrella = require("../src/core/strategy-engine/umbrellas/BreakoutStormUmbrella");
const { strategyRegistry } = require("../src/core/strategy-engine/StrategyRegistry");
const svc = require("../src/modules/backtest/services/RealStrategyBacktestService");

function buildSyntheticBars(n = 80) {
  const closes = [];
  const highs = [];
  const lows = [];
  const opens = [];
  const volumes = [];
  const atr = [];
  const volSMA = [];
  for (let i = 0; i < n; i++) {
    // Mild oscillation so BB/ATR stay defined; not required to produce a trade.
    const c = 100 + Math.sin(i / 5) * 1.5 + (i * 0.01);
    closes.push(c);
    opens.push(c - 0.1);
    highs.push(c + 0.4);
    lows.push(c - 0.4);
    volumes.push(1000 + (i % 7) * 50);
    atr.push(0.5);
    volSMA.push(1000);
  }
  return { closes, highs, lows, opens, volumes, atr, volSMA };
}

test("BR resetAblation → detectSignal increments evaluated (>0)", () => {
  const strat = new BreakoutTradingStrategy();
  strat.resetAblation();
  const before = strat.getAblation();
  assert.ok(before && before.evaluated === 0, "fresh ablation starts at 0");

  const indicators = buildSyntheticBars(80);
  for (let i = 30; i < indicators.closes.length; i++) {
    strat.detectSignal(indicators, i, { symbol: "TEST" });
  }

  const after = strat.getAblation();
  assert.ok(after.evaluated > 0, `evaluated must move, got ${after.evaluated}`);
  assert.ok(
    after.evaluated === indicators.closes.length - 30,
    `evaluated should equal bars called (${indicators.closes.length - 30}), got ${after.evaluated}`,
  );
  // At least one rejection bucket should move on idle synthetic bars
  const rejects =
    after.rejWarmup + after.rejAtrLookback + after.rejLevels + after.rejConsolidation
    + after.rejBreakout + after.rejRetestWindow + after.rejMinBars + after.rejDisplacement
    + after.rejTrueRetest + after.rejMarketCond + after.rejRrRoom;
  assert.ok(rejects > 0 || after.passed > 0, "at least one gate counter must move");
});

test("BreakoutStorm umbrella reset/getAblation delegates to BREAKOUT_RETEST component", () => {
  const umbrella = strategyRegistry.get("BREAKOUT_RETEST");
  assert.ok(umbrella, "registry returns BreakoutStorm umbrella");
  assert.equal(typeof umbrella.resetAblation, "function");
  umbrella.resetAblation();

  const cfg = {
    bsActiveRacers: ["BREAKOUT_RETEST"],
    selectedComponents: ["BREAKOUT_RETEST"],
    bsCombinationMode: "race",
  };
  const ablKey = svc.resolveAblationStrategyKey("BREAKOUT_RETEST", cfg);
  assert.equal(ablKey, "BREAKOUT_RETEST");

  const indicators = buildSyntheticBars(60);
  for (let i = 30; i < indicators.closes.length; i++) {
    umbrella.detectSignal(indicators, i, cfg);
  }

  const abl = umbrella.getAblation(ablKey);
  assert.ok(abl && abl.evaluated > 0, `umbrella getAblation(${ablKey}).evaluated > 0`);
});

test("exec funnel label clarifies signalNull is idle bars, not rejected signals", () => {
  const text = svc.formatExecSection({
    barsEvaluated: 100,
    htfUnknownSkip: 0,
    signalNull: 90,
    htfDirBlock: 0,
    adxHTFGate: 0,
    cooldownBlock: 0,
    consecLossBlock: 0,
    maxTradesBlock: 0,
    dailyLossBlock: 0,
    atrGateBlock: 0,
    validateBlock: 4,
    opened: 6,
  }).join("\n");
  assert.ok(text.includes("No signal this bar"), "label must say No signal this bar");
  assert.ok(!text.includes("Signal null (no entry)"), "old misleading label removed");
});

test("direct BreakoutStormUmbrella instance also wires ablation via component", () => {
  const um = new BreakoutStormUmbrella();
  um.resetAblation();
  const indicators = buildSyntheticBars(50);
  um.detectSignal(indicators, 40, {
    bsCombinationMode: "single",
    bsActiveRacers: ["BREAKOUT_RETEST"],
  });
  const abl = um.getAblation("BREAKOUT_RETEST");
  assert.ok(abl && abl.evaluated >= 1, "single-mode BR path increments ablation");
});
