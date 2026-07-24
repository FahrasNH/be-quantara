/**
 * ablation-funnel-dispatch.test.js — regression guard for the per-strategy funnel
 * dispatch path. Reproduces the runtime "resolveAblationStrategyKey is not a
 * function" defect (missing export/import) and asserts every strategy resolves +
 * renders its OWN funnel without throwing (both engine exec shapes).
 *
 * node -c only checks syntax — this test exercises the ACTUAL require/dispatch path.
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const svc = require("../src/modules/backtest/services/RealStrategyBacktestService");

const EXPORTED_FNS = [
  "formatScalpingFunnel",
  "formatStrategyFunnel",
  "formatExecSection",
  "resolveAblationStrategyKey",
  "getAblationSchemaFor",
  "smcAblationApplies",
];

// mock execution-stage payloads for BOTH engines
const EXEC_MULTI = {
  signalBars: 10, rejRegimeGate: 1, rejSideRegime: 0, rejFunding: 0,
  rejPositionOpen: 2, rejCooldown: 0, rejConsecLoss: 0, rejDailyTrades: 0,
  rejDailyLoss: 0, rejAtrGate: 5, rejSlTp: 0, rejSize: 0, opened: 2,
};
const EXEC_SINGLE = {
  barsEvaluated: 100, htfUnknownSkip: 3, signalNull: 80, htfDirBlock: 4,
  adxHTFGate: 2, cooldownBlock: 0, consecLossBlock: 0, maxTradesBlock: 0,
  dailyLossBlock: 0, atrGateBlock: 6, validateBlock: 1, opened: 4,
};

test("all new funnel helpers are exported as functions", () => {
  for (const fn of EXPORTED_FNS) {
    assert.equal(typeof svc[fn], "function", `${fn} must be exported`);
  }
});

test("resolveAblationStrategyKey resolves umbrella keys to active racer + component keys to themselves", () => {
  assert.equal(svc.resolveAblationStrategyKey("SMART_MONEY_CONCEPTS", {}), "SMART_MONEY_CONCEPTS");
  assert.equal(svc.resolveAblationStrategyKey("ADAPTIVE_FUSION", {}), "SMART_MONEY_CONCEPTS");
  // FE collapse: AF key but only WYCKOFF racing → attribute to WYCKOFF
  assert.equal(svc.resolveAblationStrategyKey("SMART_MONEY_CONCEPTS", { afActiveRacers: ["WYCKOFF"] }), "WYCKOFF");
  assert.equal(svc.resolveAblationStrategyKey("WYCKOFF", {}), "WYCKOFF");
  assert.equal(svc.resolveAblationStrategyKey("VOLUME_SPREAD_ANALYSIS", {}), "VOLUME_SPREAD_ANALYSIS");
  assert.equal(svc.resolveAblationStrategyKey("TREND_FOLLOWING", {}), "TREND_FOLLOWING");
  assert.equal(svc.resolveAblationStrategyKey("MARKET_STRUCTURE", {}), "MARKET_STRUCTURE");
  assert.equal(svc.resolveAblationStrategyKey("AUCTION_MARKET_THEORY", {}), "AUCTION_MARKET_THEORY");
  assert.equal(svc.resolveAblationStrategyKey("MEAN_REVERSION", {}), "MEAN_REVERSION");
  assert.equal(svc.resolveAblationStrategyKey("SUPPLY_AND_DEMAND", {}), "SUPPLY_AND_DEMAND");
  assert.equal(svc.resolveAblationStrategyKey("STATISTICAL_ARBITRAGE", {}), "STATISTICAL_ARBITRAGE");
  // BREAKOUT_RETEST is halted by default → primary active racer is ICT
  assert.equal(svc.resolveAblationStrategyKey("BREAKOUT_RETEST", {}), "ICT_STYLE_TRADING");
  assert.equal(svc.resolveAblationStrategyKey("ICT_STYLE_TRADING", {}), "ICT_STYLE_TRADING");
  assert.equal(svc.resolveAblationStrategyKey("LIQUIDATION_SQUEEZE", {}), "LIQUIDATION_SQUEEZE");
});

const ALL_COMPONENT_KEYS = [
  "SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS",
  "TREND_FOLLOWING", "MARKET_STRUCTURE", "AUCTION_MARKET_THEORY",
  "MEAN_REVERSION", "SUPPLY_AND_DEMAND", "STATISTICAL_ARBITRAGE",
  "BREAKOUT_RETEST", "ICT_STYLE_TRADING", "LIQUIDATION_SQUEEZE",
];

test("every strategy exposes an ordered ablation schema (first=candidate, last=passed)", () => {
  for (const key of ALL_COMPONENT_KEYS) {
    const schema = svc.getAblationSchemaFor(key);
    assert.ok(Array.isArray(schema) && schema.length >= 2, `${key} schema must be a non-empty array`);
    for (const step of schema) {
      assert.equal(typeof step.key, "string", `${key} schema step must have a key`);
      assert.equal(typeof step.label, "string", `${key} schema step must have a label`);
    }
    assert.equal(schema[schema.length - 1].key, "passed", `${key} schema must end with 'passed'`);
  }
});

test("formatStrategyFunnel renders every strategy without throwing (both exec shapes)", () => {
  for (const key of ALL_COMPONENT_KEYS) {
    const schema = svc.getAblationSchemaFor(key);
    const abl = {};
    for (const s of schema) abl[s.key] = 1;
    const exec = key === "SMART_MONEY_CONCEPTS" || key === "WYCKOFF" || key === "VOLUME_SPREAD_ANALYSIS"
      ? EXEC_MULTI : EXEC_SINGLE;
    const text = svc.formatStrategyFunnel(key, abl, exec, `${key} funnel:`);
    assert.ok(text.includes(`${key} funnel:`), `${key} header present`);
    assert.ok(text.includes("\n  - "), `${key} funnel uses dash bullets`);
    assert.ok(!text.match(/\n  \d+\./), `${key} funnel must not use numbered lines`);
    assert.ok(text.includes("PASSED"), `${key} funnel shows PASSED stage`);
    assert.ok(text.includes("OPENED"), `${key} funnel shows execution OPENED stage`);
  }
});

test("SMC funnel surfaces the previously-hidden UTC session filter in dash format", () => {
  const smcAbl = {
    seqCandidate: 50, rejByRejection: 20, rejByObRetest: 10, seqSignal: 20,
    rejByRegime: 3, rejByChoch: 5, rejBySession: 2, rejByConf: 4, passed: 6,
  };
  const text = svc.formatStrategyFunnel("SMART_MONEY_CONCEPTS", smcAbl, EXEC_MULTI, "SMC funnel:");
  assert.ok(text.includes("- Raw setups (FVG+mitigation) : 50"), "SMC raw setups line uses dash format");
  assert.ok(text.includes("UTC session filter"), "rejBySession now displayed");
  assert.ok(text.includes("-2"), "session count rendered");
  assert.ok(!text.match(/\n  \d+\./), "SMC funnel must not use numbered lines");
  assert.ok(!text.includes("Funding guard (Swing)     : -${"), "no template leakage");
});

test("VSA ablation schema lists shelved gate immediately after evaluated", () => {
  const schema = svc.getAblationSchemaFor("VOLUME_SPREAD_ANALYSIS");
  assert.equal(schema[0].key, "evaluated");
  assert.equal(schema[1].key, "rejScalpingShelved");
});

test("VSA shelved ablation funnel shows zero passed and zero execution signals", () => {
  const abl = {
    evaluated: 50056,
    rejScalpingShelved: 50056,
    rejMinBars: 0,
    rejVolume: 0,
    rejRelVol: 0,
    rejAtr: 0,
    rejSwingProximity: 0,
    rejClassify: 0,
    rejPattern: 0,
    rejBySession: 0,
    rejSwingShort: 0,
    rejMinConfidence: 0,
    passed: 0,
  };
  const exec = { signalBars: 0, rejRegimeGate: 0, rejSideRegime: 0, rejFunding: 0,
    rejPositionOpen: 0, rejCooldown: 0, rejConsecLoss: 0, rejDailyTrades: 0,
    rejDailyLoss: 0, rejAtrGate: 0, rejSlTp: 0, rejSize: 0, opened: 0 };
  const text = svc.formatStrategyFunnel(
    "VOLUME_SPREAD_ANALYSIS",
    abl,
    exec,
    "VOLUME_SPREAD_ANALYSIS filter funnel (Scalping, via-api, 0 trades):",
  );
  assert.ok(text.includes("- Scalping shelved (fee-bound) : 50056"));
  assert.ok(text.includes("- PASSED (tradeable signals) : 0"));
  assert.ok(text.includes("- Signals reaching execution : 0"));
  assert.ok(text.includes("- No VSA pattern : 0"));
});

test("runtime smoke: Swing funnel dispatch renders with dash format and does not throw", () => {
  const text = svc.formatStrategyFunnel(
    "SMART_MONEY_CONCEPTS",
    {
      seqCandidate: 12,
      rejByRejection: 4,
      rejByObRetest: 2,
      seqSignal: 6,
      rejByRegime: 1,
      rejByChoch: 1,
      rejBySession: 0,
      rejByConf: 0,
      passed: 4,
    },
    EXEC_MULTI,
    "SMART_MONEY_CONCEPTS filter funnel (Swing, via-api, 8 trades):",
  );
  assert.ok(text.includes("(Swing, via-api, 8 trades)"), "Swing header rendered");
  assert.ok(text.includes("\n  - Signals reaching execution : 10"), "execution section rendered for Swing");
  assert.ok(!text.match(/\n  \d+\./), "Swing funnel must not use numbered lines");
});

test("SMC schema no longer carries the dead rejByFunding counter", () => {
  const { strategyRegistry } = require("../src/core/strategy-engine/StrategyRegistry");
  const smc = strategyRegistry.get("SMART_MONEY_CONCEPTS");
  smc.resetAblation();
  const fresh = smc.getAblation("SMART_MONEY_CONCEPTS");
  assert.ok(!Object.prototype.hasOwnProperty.call(fresh, "rejByFunding"), "rejByFunding dropped");
  assert.ok(Object.prototype.hasOwnProperty.call(fresh, "rejBySession"), "rejBySession retained");
});
