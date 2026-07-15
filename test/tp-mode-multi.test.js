/**
 * tpMode bot DB harus override strat.tpMode default (mis. TM partial) di multi-strategy.
 * Run: node test/tp-mode-multi.test.js
 */
"use strict";

const assert = require("assert");
const BotEngine = require("../src/modules/trading/application/BotEngine");

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("\n📋 tpMode multi-strategy override\n");

test("BotEngine: tpMode full dari DB override strategi TM default partial", () => {
  const eng = new BotEngine({
    symbol: "WLDUSDT",
    strategyKey: "TREND_FOLLOWING",
    tpMode: "full",
    dryRun: true,
    capital: 1000,
  });
  assert.strictEqual(eng.config.tpMode, "full");
});

test("BotEngine: tpMode partial eksplisit aktif", () => {
  const eng = new BotEngine({
    symbol: "WLDUSDT",
    strategyKey: "TREND_FOLLOWING",
    tpMode: "partial",
    dryRun: true,
    capital: 1000,
  });
  assert.strictEqual(eng.config.tpMode, "partial");
});

if (process.exitCode) {
  console.log("\n❌ tp-mode-multi tests FAILED\n");
} else {
  console.log("\n✅ tp-mode-multi tests passed\n");
}
