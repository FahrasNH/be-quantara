/**
 * backtest-preset-service.test.js — strategy presets survive archive removal
 * Run: node test/backtest-preset-service.test.js
 */
"use strict";

const assert = require("assert");

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}: ${err.message}`);
  }
}

console.log("\nBACKTEST PRESET SERVICE\n");

t("BacktestHistoryService exposes preset CRUD only", () => {
  const BacktestHistoryService = require("../src/modules/backtest/services/BacktestHistoryService");
  assert.strictEqual(typeof BacktestHistoryService.savePreset, "function");
  assert.strictEqual(typeof BacktestHistoryService.getPresets, "function");
  assert.strictEqual(typeof BacktestHistoryService.deletePreset, "function");
  assert.strictEqual(typeof BacktestHistoryService.saveBacktest, "undefined");
  assert.strictEqual(typeof BacktestHistoryService.getArchive, "undefined");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} BACKTEST PRESET SERVICE: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
