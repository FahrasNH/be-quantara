/**
 * backtest-archive-guard.test.js — archive writes require explicit_save
 * Run: node test/backtest-archive-guard.test.js
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

function isExplicitSave(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

console.log("\nBACKTEST ARCHIVE GUARD\n");

t("explicit_save accepts boolean true", () => {
  assert.strictEqual(isExplicitSave(true), true);
});

t("explicit_save accepts string true", () => {
  assert.strictEqual(isExplicitSave("true"), true);
});

t("explicit_save rejects missing/undefined", () => {
  assert.strictEqual(isExplicitSave(undefined), false);
  assert.strictEqual(isExplicitSave(false), false);
  assert.strictEqual(isExplicitSave("false"), false);
});

t("BacktestHistoryService exposes in-memory heal only", () => {
  const BacktestHistoryService = require("../src/modules/backtest/services/BacktestHistoryService");
  assert.strictEqual(typeof BacktestHistoryService._healPayload, "function");
  assert.strictEqual(typeof BacktestHistoryService._healAndMaybePersist, "undefined");
});

t("lookup heal does not expose persist helper", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../src/modules/backtest/services/BacktestHistoryService.js"),
    "utf8",
  );
  assert.ok(!src.includes("_healAndMaybePersist"), "lookup should not persist heal-on-read");
  assert.ok(src.includes("_healPayload"), "lookup should heal in-memory");
});

console.log(`\n${failed === 0 ? "✅" : "❌"} BACKTEST ARCHIVE GUARD: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
