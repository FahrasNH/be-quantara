/**
 * Parity: Gen1 key input normalizes to same engine/config resolution as Gen2.
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

console.log("\n═══ strategy key Gen1↔Gen2 parity ═══\n");

resetGen1DeprecationStats();
const { strategyRegistry: registry } = StrategyRegistry;

const PAIRS = [
  ["SMART_MONEY_CONCEPTS", "AF_SMC"],
  ["ADAPTIVE_FUSION", "AF_SMC"],
  ["SAC", "AF_SMC"],
  ["TREND_FOLLOWING", "TS_TF"],
  ["TF", "TS_TF"],
  ["TM", "TS_TF"],
  ["MEAN_REVERSION", "MD_MR"],
  ["MR", "MD_MR"],
  ["BREAKOUT_RETEST", "BS_BR"],
  ["BR", "BS_BR"],
];

for (const [gen1, gen2] of PAIRS) {
  assert.equal(normalizeStrategyKey(gen1), gen2, `${gen1} → ${gen2}`);
  assert.equal(ingressNormalizeStrategyKey(gen1, { source: "test", mode: "backtest" }), gen2);
  assert.ok(isLegacyAlias(gen1), `${gen1} is legacy`);

  const instGen1 = registry.get(gen1);
  const instGen2 = registry.get(gen2);
  assert.equal(instGen1, instGen2, `registry parity ${gen1} vs ${gen2}`);

  const cfgGen1 = getStrategy(gen1);
  const cfgGen2 = getStrategy(gen2);
  assert.equal(cfgGen1.signalType, cfgGen2.signalType, `getStrategy signalType ${gen1}`);
  assert.equal(cfgGen1.emaFast, cfgGen2.emaFast, `getStrategy params ${gen1}`);
}

assert.equal(normalizeStrategyKey("AF_WYCKOFF"), "AF_WYCKOFF", "components pass through");
assert.equal(normalizeStrategyKey("GROK_AI_TRADING"), "GROK_AI_TRADING");

console.log("  ✓ All Gen1→Gen2 pairs normalize to same registry + config");
console.log("\nAll strategy-key-parity tests passed.\n");
