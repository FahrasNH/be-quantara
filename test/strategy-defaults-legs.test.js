/**
 * strategyDefaults.js — per-leg typeOverrides + smc isolation guardrails.
 */
"use strict";

const assert = require("node:assert/strict");
const { STRATEGIES } = require("../src/config/strategyDefaults");
const { normalizeStrategyKey, normalizeTradeTypeKey } = require("../src/config/strategyKeyNormalizer");

const MULTI_LEG_KEYS = [
  "SMART_MONEY_CONCEPTS",
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "BREAKOUT_RETEST",
  "WYCKOFF",
  "VOLUME_SPREAD_ANALYSIS",
  "MARKET_STRUCTURE",
  "AUCTION_MARKET_THEORY",
  "SUPPLY_AND_DEMAND",
  "STATISTICAL_ARBITRAGE",
  "ICT_STYLE_TRADING",
  "LIQUIDATION_SQUEEZE",
];

const NON_SMC_KEYS = MULTI_LEG_KEYS.filter((k) => k !== "SMART_MONEY_CONCEPTS");

console.log("\n═══ strategyDefaults per-leg SSOT ═══\n");

assert.ok(!STRATEGIES.AGGRESSIVE_SCALPING, "AGGRESSIVE_SCALPING preset removed");
assert.ok(!STRATEGIES.DAY_TRADING, "DAY_TRADING preset removed");
assert.ok(!STRATEGIES.SWING_TRADING, "SWING_TRADING preset removed");

for (const key of MULTI_LEG_KEYS) {
  const cfg = STRATEGIES[key];
  assert.ok(cfg, `${key} must exist`);
  assert.ok(cfg.typeOverrides?.Scalping?.atrMinMult != null, `${key} Scalping atrMinMult`);
  assert.ok(cfg.typeOverrides?.Intraday?.atrMinMult != null, `${key} Intraday atrMinMult`);
  assert.ok(cfg.typeOverrides?.Swing?.atrMinMult != null, `${key} Swing atrMinMult`);
}

for (const key of NON_SMC_KEYS) {
  const cfg = STRATEGIES[key];
  for (const prop of Object.keys(cfg)) {
    assert.ok(!prop.startsWith("smc"), `${key} must not have top-level ${prop}`);
  }
  for (const leg of ["Scalping", "Intraday", "Swing"]) {
    const ov = cfg.typeOverrides?.[leg] || {};
    for (const prop of Object.keys(ov)) {
      assert.ok(!prop.startsWith("smc"), `${key}.typeOverrides.${leg} must not have ${prop}`);
    }
  }
}

const smc = STRATEGIES.SMART_MONEY_CONCEPTS;
assert.equal(smc.enabledComponents?.join(","), "Scalping,Intraday,Swing");
assert.equal(smc.typeOverrides.Intraday.smcMinConfidenceB, 55);
assert.ok(smc.smcUseSequenceEngine === true);

const UMBRELLA_KEYS = ["ADAPTIVE_FUSION", "TREND_SURGE", "MEAN_DRIFT", "BREAKOUT_STORM"];
for (const key of UMBRELLA_KEYS) {
  const cfg = STRATEGIES[key];
  assert.ok(cfg, `${key} umbrella must exist`);
  assert.ok(!cfg.typeOverrides, `${key} umbrella must not have typeOverrides`);
  assert.ok(!cfg.enabledComponents, `${key} umbrella must not have enabledComponents`);
  for (const prop of Object.keys(cfg)) {
    assert.ok(!prop.startsWith("smc"), `${key} umbrella must not have ${prop}`);
    assert.ok(!["emaFast", "atrPeriod", "riskReward"].includes(prop), `${key} umbrella must not have shared geometry ${prop}`);
  }
}
assert.ok(!STRATEGIES.ADAPTIVE_FUSION.smcUseSequenceEngine, "ADAPTIVE_FUSION umbrella has no smc*");

assert.equal(normalizeStrategyKey("DAY_TRADING"), "TREND_FOLLOWING");
assert.equal(normalizeStrategyKey("AGGRESSIVE_SCALPING"), "SMART_MONEY_CONCEPTS");
assert.equal(normalizeTradeTypeKey("B"), "Intraday");
assert.equal(normalizeTradeTypeKey("A"), "Scalping");

console.log("  ✓ PDF presets removed; per-leg typeOverrides on all multi-leg strategies");
console.log("  ✓ smc* isolated to SMART_MONEY_CONCEPTS");
console.log("\nAll strategy-defaults-legs tests passed.\n");
