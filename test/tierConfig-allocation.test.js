/**
 * tierConfig capitalAllocation + maxPositionsPerSymbol — unit tests (TASK 2.4).
 */
const { TIER_CONFIG, TIER_ORDER } = require("#core/risk-engine/tierConfig.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🏷️  tierConfig allocation Unit Tests\n");

for (const tier of TIER_ORDER) {
  const c = TIER_CONFIG[tier];
  t(`${tier}: capitalAllocation.equal = true`, c.capitalAllocation && c.capitalAllocation.equal === true);
  t(`${tier}: maxPositionsPerSymbol = 1 (race-to-confirm)`, c.maxPositionsPerSymbol === 1);
  t(`${tier}: maxPositions = 1`, c.maxPositions === 1);
}

// VAULT: 4 strategies race, but still max 1 open position per symbol
t("VAULT still has 4 strategies", TIER_CONFIG.VAULT.strategies.length === 4);
t("VAULT maxPositionsPerSymbol = 1", TIER_CONFIG.VAULT.maxPositionsPerSymbol === 1);

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
