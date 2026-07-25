"use strict";

const assert = require("assert");
const { calcPnl } = require("../src/modules/trading/services/forceCloseOpenTrades");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

console.log("forceCloseOpenTrades — calcPnl\n");

test("calcPnl LONG profit", () => {
  const { pnl, pnlPct } = calcPnl("LONG", 100, 110, 2);
  assert.strictEqual(pnl, 20);
  assert.ok(Math.abs(pnlPct - 10) < 1e-9);
});

test("calcPnl SHORT profit (GRASS-like)", () => {
  const { pnl } = calcPnl("SHORT", 0.3721, 0.35, 100);
  assert.ok(pnl > 0);
});

test("calcPnl zero size", () => {
  const { pnl, pnlPct } = calcPnl("LONG", 100, 110, 0);
  assert.strictEqual(pnl, 0);
  assert.strictEqual(pnlPct, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
