/**
 * adaptive-fusion-v25.test.js — preset AF v2.5 selaras STRATEGIES.md §4
 */

const test = require("node:test");
const assert = require("node:assert");
const { STRATEGIES } = require("../src/domain/legacyStrategies");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");

const preset = STRATEGIES.ADAPTIVE_FUSION;
const afs = new AdaptiveFusionStrategy();

test("legacyStrategies ADAPTIVE_FUSION v2.5 preset", () => {
  assert.strictEqual(preset.riskPerTrade, 0.007);
  assert.strictEqual(preset.atrMultiplier, 1.4);
  assert.strictEqual(preset.riskReward, 2.5);
  assert.strictEqual(preset.rsiLongMin, 58);
  assert.strictEqual(preset.rsiShortMax, 42);
  assert.strictEqual(preset.maxEntryExtensionATR, 0.8);
  assert.strictEqual(preset.strongTrendTPMult, 1.6);
  assert.strictEqual(preset.volSmaMultiplier, 1.8);
  assert.strictEqual(preset.htfTrendStrengthMin, 0.72);
  assert.strictEqual(preset.cooldownAfterLoss, 60);
  assert.strictEqual(preset.maxDailyLossPct, 0.035);
  assert.strictEqual(preset.atrMinMult, 1.0);
  assert.strictEqual(preset.sidewaysBreakoutVolMult, 1.5);
});

test("AdaptiveFusionStrategy class v2.5 sub-components", () => {
  assert.strictEqual(afs.config.version, "2.5.0");
  const subs = afs.getSubStrategies();
  assert.strictEqual(subs.A.tpMultiplier, 3.3);
  assert.strictEqual(subs.A.minScore, 38);
  assert.strictEqual(subs.B.tpMultiplier, 3.4);
  assert.strictEqual(subs.C.slMultiplier, 1.2);
  assert.strictEqual(subs.C.tpMultiplier, 3.0);
  assert.strictEqual(subs.C.minScore, 42);
});

test("validateEntry ATR floor v2.5 = 1.0%", () => {
  const low = afs.validateEntry(50000, 350, 2000, 1000); // 0.7%
  assert.strictEqual(low.valid, false);
  const ok = afs.validateEntry(50000, 550, 2000, 1000); // 1.1%
  assert.strictEqual(ok.valid, true);
});

test("strongTrendTPMult v2.5 = ×1.6", () => {
  const base = afs.calculateRiskConfig(100, 2, "LONG", "B");
  const strong = afs.calculateRiskConfig(100, 2, "LONG", "B", {
    marketCond: "STRONG_TREND",
    strongTrendTPMult: 1.6,
  });
  assert.ok(Math.abs(strong.tpDistance - base.tpDistance * 1.6) < 1e-9);
});
