/**
 * tierConfig maxActiveBots — unit tests (P2-11).
 */
const { TIER_CONFIG, TIER_ORDER, getMaxActiveBots } = require("#core/risk-engine/tierConfig.js");

let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else      { fail++; console.log(`  ❌ ${name}`); }
};

console.log("\n🤖 tierConfig maxActiveBots Unit Tests\n");

const expected = { FOUNDRY: 10, FORGE: 25, MINT: 40, VAULT: 50 };
for (const tier of TIER_ORDER) {
  t(`${tier}: maxActiveBots = ${expected[tier]}`, TIER_CONFIG[tier].maxActiveBots === expected[tier]);
  t(`getMaxActiveBots(${tier})`, getMaxActiveBots(tier) === expected[tier]);
}

t("getMaxActiveBots(undefined) → FOUNDRY fallback", getMaxActiveBots(undefined) === 10);
t("getMaxActiveBots(INVALID) → FOUNDRY fallback", getMaxActiveBots("INVALID") === 10);

console.log(`\n  TESTS: ${pass} passed, ${fail} failed (${pass + fail} total)`);
console.log(fail === 0 ? "  ✅ ALL TESTS PASSED\n" : "  ❌ SOME TESTS FAILED\n");
process.exit(fail === 0 ? 0 : 1);
