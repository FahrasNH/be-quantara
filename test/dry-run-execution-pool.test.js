/**
 * entitlement execution pool + dry-run relaxations — unit tests
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  resolveExecutionStrategies,
  filterStrategiesByMode,
} = require("../src/services/entitlement");
const { applyDryRunStrategyRelaxations } = require("../src/config/dryRunStrategyRelaxations");
const { getComponentPoolUpToTier } = require("../src/config/strategies");

test("FOUNDRY dry-run → one Grok news strategy", () => {
  const keys = resolveExecutionStrategies("FOUNDRY", "dry");
  assert.deepEqual(keys, ["GROK_NEWS_TRADING"]);
});

test("FOUNDRY live → single umbrella key", () => {
  const keys = resolveExecutionStrategies("FOUNDRY", "live");
  assert.deepEqual(keys, ["SMART_MONEY_CONCEPTS"]);
});

test("VAULT dry-run ignores the technical component pool", () => {
  const keys = resolveExecutionStrategies("VAULT", "dry");
  assert.deepEqual(keys, ["GROK_NEWS_TRADING"]);
});

test("getComponentPoolUpToTier accumulates tiers", () => {
  assert.equal(getComponentPoolUpToTier("FORGE").length, 6);
});

test("dry filter collapses stale strategy lists to Grok news", () => {
  const dry = filterStrategiesByMode(
    ["SMART_MONEY_CONCEPTS", "BREAKOUT_RETEST"],
    "dry",
  );
  assert.deepEqual(dry, ["GROK_NEWS_TRADING"]);
});

test("applyDryRunStrategyRelaxations lowers SMC Intraday gates", () => {
  const out = applyDryRunStrategyRelaxations({
    dryRun: true,
    strategyKey: "SMART_MONEY_CONCEPTS",
    typeOverrides: {
      Intraday: { smcMinConfidenceIntraday: 80, smcBlockAllInChop: true },
      Scalping: { smcRequireObRetest: true },
    },
  });
  assert.equal(out.typeOverrides.Intraday.smcMinConfidenceIntraday, 65);
  assert.equal(out.typeOverrides.Intraday.smcBlockAllInChop, false);
  assert.equal(out.typeOverrides.Scalping.smcRequireObRetest, false);
});

test("applyDryRunStrategyRelaxations skipped for live", () => {
  const cfg = {
    dryRun: false,
    strategyKey: "SMART_MONEY_CONCEPTS",
    typeOverrides: { Intraday: { smcBlockAllInChop: true } },
  };
  assert.deepEqual(applyDryRunStrategyRelaxations(cfg), cfg);
});
