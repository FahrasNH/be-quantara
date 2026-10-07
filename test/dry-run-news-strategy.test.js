"use strict";

const assert = require("assert");
const {
  DRY_RUN_NEWS_STRATEGY_KEY,
  isDryRunMode,
  resolveRuntimeStrategyKey,
  resolveDryRunStrategies,
} = require("../src/config/dryRunNewsStrategy");
const { getStrategy } = require("../src/config/strategyDefaults");
const { strategyRegistry } = require("../src/core/strategy-engine");
const MultiStrategyCoordinator = require("../src/modules/trading/application/MultiStrategyCoordinator");

assert.strictEqual(isDryRunMode(undefined), true);
assert.strictEqual(isDryRunMode(false), false);
assert.strictEqual(isDryRunMode("false"), false);
assert.strictEqual(resolveRuntimeStrategyKey("SMART_MONEY_CONCEPTS", true), DRY_RUN_NEWS_STRATEGY_KEY);
assert.strictEqual(resolveRuntimeStrategyKey("TREND_FOLLOWING", false), "TREND_FOLLOWING");
assert.deepStrictEqual(
  resolveDryRunStrategies(["SMART_MONEY_CONCEPTS", "WYCKOFF"], true),
  [DRY_RUN_NEWS_STRATEGY_KEY],
);
assert.deepStrictEqual(
  resolveDryRunStrategies(["SMART_MONEY_CONCEPTS", "WYCKOFF"], false),
  ["SMART_MONEY_CONCEPTS", "WYCKOFF"],
);

const strategy = getStrategy(DRY_RUN_NEWS_STRATEGY_KEY);
assert.strictEqual(strategy.name, DRY_RUN_NEWS_STRATEGY_KEY);
assert.strictEqual(strategy.signalType, DRY_RUN_NEWS_STRATEGY_KEY);
assert.strictEqual(strategy.atrMinMult, 0.05);
assert.strictEqual(strategyRegistry.validate(DRY_RUN_NEWS_STRATEGY_KEY).valid, true);

const coordinator = new MultiStrategyCoordinator({
  userId: "policy-test",
  symbol: "BTCUSDT",
  strategies: ["SMART_MONEY_CONCEPTS", "TREND_FOLLOWING"],
  totalCapital: 100,
  dryRun: true,
  engineFactory: () => ({}),
});
assert.deepStrictEqual(coordinator.strategies, [DRY_RUN_NEWS_STRATEGY_KEY]);
assert.strictEqual(coordinator.capitalPerStrategy, 100);

const liveCoordinator = new MultiStrategyCoordinator({
  userId: "policy-live-test",
  symbol: "BTCUSDT",
  strategies: ["TREND_FOLLOWING"],
  totalCapital: 100,
  dryRun: "false",
  engineFactory: () => ({}),
});
assert.deepStrictEqual(liveCoordinator.strategies, ["TREND_FOLLOWING"]);
assert.strictEqual(liveCoordinator.dryRun, false);

console.log("dry-run-news-strategy.test.js: all assertions passed");
