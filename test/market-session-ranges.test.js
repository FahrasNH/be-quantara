/**
 * market-session-ranges.test.js — UTC session windows (SSOT: entryRiskGates.js)
 *
 * Run: node test/market-session-ranges.test.js
 */

"use strict";

const assert = require("assert");
const {
  SESSION_HOUR_RANGES,
  detectMarketSession,
  hourInMarketSession,
} = require("../src/core/risk-engine/entryRiskGates");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(".");
  } catch (err) {
    failed += 1;
    console.error(`\n✗ ${name}: ${err.message}`);
  }
}

test("SESSION_HOUR_RANGES matches WIB-aligned UTC windows", () => {
  assert.deepEqual(SESSION_HOUR_RANGES.Sydney, [[21, 23], [0, 6]]);
  assert.deepEqual(SESSION_HOUR_RANGES.Tokyo, [[23, 23], [0, 8]]);
  assert.deepEqual(SESSION_HOUR_RANGES.London, [[8, 16]]);
  assert.deepEqual(SESSION_HOUR_RANGES["New York"], [[13, 21]]);
});

test("hour 21 UTC is Sydney (WIB 04:00 open)", () => {
  assert.ok(hourInMarketSession(21, "Sydney"));
  assert.ok(!hourInMarketSession(21, "Tokyo"));
  assert.strictEqual(detectMarketSession(21), "Sydney");
});

test("hour 23 UTC is in both Sydney and Tokyo ranges", () => {
  assert.ok(hourInMarketSession(23, "Sydney"));
  assert.ok(hourInMarketSession(23, "Tokyo"));
  assert.strictEqual(detectMarketSession(23), "Sydney");
});

test("hour 7 UTC is Tokyo-only (Sydney ends at 06 UTC)", () => {
  assert.ok(!hourInMarketSession(7, "Sydney"));
  assert.ok(hourInMarketSession(7, "Tokyo"));
  assert.strictEqual(detectMarketSession(7), "Tokyo");
});

test("London and New York unchanged", () => {
  assert.ok(hourInMarketSession(10, "London"));
  assert.strictEqual(detectMarketSession(10), "London");
  assert.ok(hourInMarketSession(15, "New York"));
  assert.strictEqual(detectMarketSession(15), "London"); // overlap priority
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
