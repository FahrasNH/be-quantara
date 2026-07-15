/**
 * Strategy catalog SSOT — engines/components for UI filters; no legacy picker aliases.
 */
const assert = require("assert/strict");
const {
  getStrategyCatalog,
  normalizeStrategyKey,
  isLegacyAlias,
  CANONICAL_ENGINE_KEYS,
  LIVE_COMPONENT_KEYS,
  STRATEGY_RECAP_CATALOG,
  LIVE_RECAP_KEYS,
} = require("../src/config/strategies");

console.log("\n═══ strategy catalog SSOT ═══");

const catalog = getStrategyCatalog();
assert.deepEqual(catalog.engines.map((e) => e.key), CANONICAL_ENGINE_KEYS);
assert.deepEqual(catalog.components.map((c) => c.key), LIVE_COMPONENT_KEYS);
assert.ok(!catalog.engines.some((e) => e.key === "ADAPTIVE_FUSION"));
assert.ok(!catalog.components.some((c) => /legacy/i.test(c.label)));
assert.equal(catalog.aliases.ADAPTIVE_FUSION, "SMART_MONEY_CONCEPTS");
assert.equal(catalog.aliases.TS_TF, "TREND_FOLLOWING");
assert.equal(catalog.aliases.TREND_SURGE, "TREND_FOLLOWING");
assert.ok(catalog.components.some((c) => c.key === "WYCKOFF" && c.label === "Wyckoff Method"));
assert.ok(catalog.components.some((c) => c.key === "MARKET_STRUCTURE" && c.label === "Dow Theory"));
assert.ok(catalog.components.some((c) => c.key === "SUPPLY_AND_DEMAND" && c.label === "Supply and Demand"));
assert.ok(catalog.components.some((c) => c.key === "STATISTICAL_ARBITRAGE" && c.label === "Statistical Arbitrage"));
assert.ok(catalog.components.some((c) => c.key === "ICT_STYLE_TRADING" && c.label === "ICT-style trading"));
assert.ok(catalog.components.some((c) => c.key === "LIQUIDATION_SQUEEZE" && c.label === "Liquidation/Squeeze Trading"));
assert.ok(catalog.components.some((c) => c.key === "BREAKOUT_RETEST" && c.label === "Breakout Trading"));

assert.deepEqual(LIVE_RECAP_KEYS, LIVE_COMPONENT_KEYS);
for (const key of LIVE_RECAP_KEYS) {
  const row = catalog.components.find((c) => c.key === key);
  assert.ok(row, `missing catalog row for ${key}`);
  assert.ok(row.concept, `${key} concept must be non-empty`);
  assert.ok(row.indicators, `${key} indicators must be non-empty`);
  assert.ok(row.pdfTradeType, `${key} pdfTradeType must be non-empty`);
  assert.ok(STRATEGY_RECAP_CATALOG[key]?.recapStatus, `${key} recapStatus required`);
}

assert.equal(normalizeStrategyKey("ADAPTIVE_FUSION"), "SMART_MONEY_CONCEPTS");
assert.equal(normalizeStrategyKey("SAC"), "SMART_MONEY_CONCEPTS");
assert.equal(normalizeStrategyKey("TM"), "TREND_FOLLOWING");
assert.equal(normalizeStrategyKey("MR"), "MEAN_REVERSION");
assert.equal(normalizeStrategyKey("BR"), "BREAKOUT_RETEST");
assert.equal(isLegacyAlias("ADAPTIVE_FUSION"), true);
assert.equal(isLegacyAlias("TM"), true);
assert.equal(isLegacyAlias("SMART_MONEY_CONCEPTS"), false);

console.log("  ✓ catalog engines/components exclude Gen1 aliases");
console.log("  ✓ aliases map present for normalize only");
console.log("\nAll strategy-catalog tests passed.\n");
