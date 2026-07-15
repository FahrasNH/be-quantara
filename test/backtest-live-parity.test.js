/**
 * Backtest ↔ live parity regressions (Sprint 12).
 * - Risk defaults align with BotEngine (maxConsecLoss=3, maxDailyLossPct=0.03)
 * - AF triple-type no longer zeroes cooldown / raises consec-loss cap
 * - Funding cost helper accrues over hold time
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

const svcPath = path.join(__dirname, "../src/modules/backtest/services/RealStrategyBacktestService.js");
const src = fs.readFileSync(svcPath, "utf8");

console.log("\n═══ Backtest ↔ Live Parity ═══");

test("AF triple path does not force cooldownAfterLoss: 0", () => {
  assert.ok(!/cooldownAfterLoss:\s*0/.test(src), "must not hardcode cooldownAfterLoss: 0");
});

test("AF triple path does not raise maxConsecLoss to ≥5", () => {
  assert.ok(!/maxConsecLoss:\s*Math\.max\(cfg\.maxConsecLoss/.test(src),
    "must not Math.max raise maxConsecLoss for AF triple");
});

test("risk defaults use live-aligned maxConsecLoss ?? 3", () => {
  const matches = src.match(/maxConsecLoss\s*=\s*cfg\.maxConsecLoss\s*\?\?\s*3/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 live-aligned defaults, got ${matches.length}`);
});

test("risk defaults use live-aligned maxDailyLossPct ?? 0.03", () => {
  const matches = src.match(/maxDailyLossPct\s*=\s*cfg\.maxDailyLossPct\s*\?\?\s*0\.03/g) || [];
  assert.ok(matches.length >= 2, `expected ≥2 live-aligned defaults, got ${matches.length}`);
});

test("funding accrual helper is present", () => {
  assert.ok(src.includes("estimateFundingCost"), "estimateFundingCost missing");
  assert.ok(src.includes("FUNDING_RATE_8H"), "FUNDING_RATE_8H missing");
});

test("floating daily loss included in gates", () => {
  assert.ok(src.includes("floatingLoss"), "floatingLoss parity missing");
});

test("Swing typeOverrides soften weekly ADX in TREND_FOLLOWING (optional post factory-reset)", () => {
  const strat = fs.readFileSync(
    path.join(__dirname, "../src/domain/legacyStrategies.js"),
    "utf8"
  );
  // Factory-reset canonical configs may drop legacy Swing adxMinStrength:20;
  // if present it must remain the softer weekly gate (20).
  if (/Swing:\s*\{[^}]*adxMinStrength:/s.test(strat)) {
    assert.ok(/Swing:\s*\{[^}]*adxMinStrength:\s*20/s.test(strat),
      "Swing adxMinStrength override must be 20 when present");
  }
});

console.log("\n══════════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("All backtest-live parity tests passed.\n");
