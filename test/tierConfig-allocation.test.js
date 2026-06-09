/**
 * tierConfig capitalAllocation + maxPositionsPerSymbol — unit tests (TASK 2.4).
 */
const { TIER_CONFIG, TIER_ORDER } = require("../src/domain/tierConfig");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🏷️  tierConfig allocation Unit Tests\n");

for (const tier of TIER_ORDER) {
  const c = TIER_CONFIG[tier];
  t(`${tier}: capitalAllocation.equal = true`, c.capitalAllocation && c.capitalAllocation.equal === true);
  t(`${tier}: maxPositionsPerSymbol = jumlah strategi (${c.strategies.length})`,
    c.maxPositionsPerSymbol === c.strategies.length);
}

// VAULT spesifik (contoh dari plan)
t("VAULT maxPositionsPerSymbol = 4", TIER_CONFIG.VAULT.maxPositionsPerSymbol === 4);

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
