/**
 * adaptive-fusion-v26.test.js — preset AF v2.6 selaras STRATEGIES.md §4
 */

const test = require("node:test");
const assert = require("node:assert");
const { STRATEGIES } = require("../src/domain/legacyStrategies");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");

const preset = STRATEGIES.ADAPTIVE_FUSION;
const afs = new AdaptiveFusionStrategy();

test("legacyStrategies ADAPTIVE_FUSION v2.6 preset", () => {
  assert.strictEqual(preset.riskPerTrade, 0.005);
  assert.strictEqual(preset.riskPerTradeStrong, 0.01);
  assert.strictEqual(preset.rsiLongMin, 60);
  assert.strictEqual(preset.rsiShortMax, 40);
  assert.strictEqual(preset.maxEntryExtensionATR, 0.7);
  assert.strictEqual(preset.strongTrendTPMult, 1.8);
  assert.strictEqual(preset.volSmaMultiplier, 2.0);
  assert.strictEqual(preset.htfTrendStrengthMin, 0.75);
  assert.strictEqual(preset.cooldownAfterLoss, 90);
  assert.strictEqual(preset.maxTradesPerDay, 6);
  assert.strictEqual(preset.atrMinMult, 1.2);
});

test("AdaptiveFusionStrategy class v2.6", () => {
  assert.strictEqual(afs.config.version, "2.6.0");
  const risk = afs.getRiskConfig();
  assert.strictEqual(risk.riskPerTrade, 0.005);
  assert.strictEqual(risk.riskPerTradeStrong, 0.01);
  assert.strictEqual(risk.maxTradesPerDay, 6);
  assert.strictEqual(risk.cooldownAfterLoss, 90);
});

test("validateEntry ATR floor v2.6 = 1.2%", () => {
  const low = afs.validateEntry(50000, 550, 2000, 1000); // 1.1%
  assert.strictEqual(low.valid, false);
  const ok = afs.validateEntry(50000, 600, 2000, 1000); // 1.2%
  assert.strictEqual(ok.valid, true);
});

test("strongTrendTPMult v2.6 = ×1.8", () => {
  const base = afs.calculateRiskConfig(100, 2, "LONG", "B");
  const strong = afs.calculateRiskConfig(100, 2, "LONG", "B", {
    marketCond: "STRONG_TREND",
    strongTrendTPMult: 1.8,
  });
  assert.ok(Math.abs(strong.tpDistance - base.tpDistance * 1.8) < 1e-9);
});
