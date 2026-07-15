/**
 * Parity: deprecated alias input normalizes to same engine/config resolution as canonical.
 */
const assert = require("assert/strict");
const {
  normalizeStrategyKey,
  ingressNormalizeStrategyKey,
  isLegacyAlias,
  resetGen1DeprecationStats,
} = require("../src/config/strategyKeyNormalizer");
const StrategyRegistry = require("../src/core/strategy-engine/StrategyRegistry");
const { getStrategy } = require("../src/config/strategyDefaults");

console.log("\n═══ strategy key alias↔canonical parity ═══\n");

resetGen1DeprecationStats();
const { strategyRegistry: registry } = StrategyRegistry;

const ALIAS_PAIRS = [
  ["ADAPTIVE_FUSION", "SMART_MONEY_CONCEPTS"],
  ["DAY_TRADING", "TREND_FOLLOWING"],
  ["AGGRESSIVE_SCALPING", "SMART_MONEY_CONCEPTS"],
  ["SAC", "SMART_MONEY_CONCEPTS"],
  ["AF_SMC", "SMART_MONEY_CONCEPTS"],
  ["TREND_SURGE", "TREND_FOLLOWING"],
  ["TF", "TREND_FOLLOWING"],
  ["TM", "TREND_FOLLOWING"],
  ["TS_TF", "TREND_FOLLOWING"],
  ["MEAN_DRIFT", "MEAN_REVERSION"],
  ["MR", "MEAN_REVERSION"],
  ["MD_MR", "MEAN_REVERSION"],
  ["BREAKOUT_STORM", "BREAKOUT_RETEST"],
  ["BR", "BREAKOUT_RETEST"],
  ["BS_BR", "BREAKOUT_RETEST"],
  ["AF_WYCKOFF", "WYCKOFF"],
  ["AF_VSA", "VOLUME_SPREAD_ANALYSIS"],
  ["TS_MS", "MARKET_STRUCTURE"],
  ["TS_VP", "AUCTION_MARKET_THEORY"],
  ["MD_SD", "SUPPLY_AND_DEMAND"],
  ["MD_SA", "STATISTICAL_ARBITRAGE"],
  ["BS_ICT", "ICT_STYLE_TRADING"],
  ["BS_LS", "LIQUIDATION_SQUEEZE"],
];

for (const [alias, canonical] of ALIAS_PAIRS) {
  assert.equal(normalizeStrategyKey(alias), canonical, `${alias} → ${canonical}`);
  assert.equal(ingressNormalizeStrategyKey(alias, { source: "test", mode: "backtest" }), canonical);
  assert.ok(isLegacyAlias(alias), `${alias} is legacy`);

  const instAlias = registry.get(alias);
  const instCanonical = registry.get(canonical);
  assert.equal(instAlias, instCanonical, `registry parity ${alias} vs ${canonical}`);

  const cfgAlias = getStrategy(alias);
  const cfgCanonical = getStrategy(canonical);
  assert.equal(cfgAlias.signalType, cfgCanonical.signalType, `getStrategy signalType ${alias}`);
  assert.equal(cfgAlias.emaFast, cfgCanonical.emaFast, `getStrategy params ${alias}`);
}

assert.equal(normalizeStrategyKey("TREND_FOLLOWING"), "TREND_FOLLOWING", "canonical pass-through");
assert.equal(normalizeStrategyKey("WYCKOFF"), "WYCKOFF", "components pass through");
assert.equal(normalizeStrategyKey("GROK_AI_TRADING"), "GROK_AI_TRADING");

console.log("  ✓ All alias→canonical pairs normalize to same registry + config");
console.log("\nAll strategy-key-parity tests passed.\n");
