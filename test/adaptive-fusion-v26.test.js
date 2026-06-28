/**
 * adaptive-fusion-v26.test.js — preset AF v3.0 (15m-recalibrated, 2026-06-28)
 *
 * v3.0 changes from v2.6:
 *  atrMinMult 1.2 → 0.25 (15m avg ATR% 0.49; 1.2 blocked every bar)
 *  htfTrendStrengthMin 0.75 → 0.25 (1h slope rarely reaches 0.75)
 *  volSmaMultiplier 2.0 → 1.3 (2.0 killed component A entirely)
 *  maxEntryExtensionATR 0.7 → 1.5 (0.7 blocked valid entries)
 *  maxTradesPerDay 6 → 12 (multi-position A+B+C needs headroom)
 *  cooldownAfterLoss 90 → 30 (90m = 6 bars lockout on 15m, too long)
 *  maxConsecLoss 2 → 4 (now per-component in multi-position mode)
 */

const test = require("node:test");
const assert = require("node:assert");
const { STRATEGIES } = require("../src/domain/legacyStrategies");
const AdaptiveFusionStrategy = require("../src/domain/strategy/implementations/AdaptiveFusionStrategy");

const preset = STRATEGIES.ADAPTIVE_FUSION;
const afs = new AdaptiveFusionStrategy();

test("legacyStrategies ADAPTIVE_FUSION v3.0 preset", () => {
  assert.strictEqual(preset.riskPerTrade, 0.005);
  assert.strictEqual(preset.riskPerTradeStrong, 0.01);
  assert.strictEqual(preset.rsiLongMin, 60);
  assert.strictEqual(preset.rsiShortMax, 40);
  assert.strictEqual(preset.maxEntryExtensionATR, 1.5);
  assert.strictEqual(preset.strongTrendTPMult, 1.8);
  assert.strictEqual(preset.volSmaMultiplier, 1.3);
  assert.strictEqual(preset.htfTrendStrengthMin, 0.25);
  assert.strictEqual(preset.cooldownAfterLoss, 30);
  assert.strictEqual(preset.maxTradesPerDay, 12);
  assert.strictEqual(preset.atrMinMult, 0.25);
  assert.strictEqual(preset.maxConsecLoss, 4);
});

test("AdaptiveFusionStrategy class v3.0", () => {
  assert.strictEqual(afs.config.version, "3.0.0");
  const risk = afs.getRiskConfig();
  assert.strictEqual(risk.riskPerTrade, 0.005);
  assert.strictEqual(risk.riskPerTradeStrong, 0.01);
  assert.strictEqual(risk.maxTradesPerDay, 12);
  assert.strictEqual(risk.cooldownAfterLoss, 30);
  assert.strictEqual(risk.maxConsecLoss, 4);
});

test("validateEntry ATR floor hardcoded = 1.2%", () => {
  // validateEntry hardcodes 1.2–3.5% range regardless of config.atrMinMult
  const low = afs.validateEntry(50000, 550, 2000, 1000); // 1.1%
  assert.strictEqual(low.valid, false);
  const ok = afs.validateEntry(50000, 600, 2000, 1000); // 1.2%
  assert.strictEqual(ok.valid, true);
});

test("strongTrendTPMult v3.0 = ×1.8", () => {
  const base = afs.calculateRiskConfig(100, 2, "LONG", "B");
  const strong = afs.calculateRiskConfig(100, 2, "LONG", "B", {
    marketCond: "STRONG_TREND",
    strongTrendTPMult: 1.8,
  });
  assert.ok(Math.abs(strong.tpDistance - base.tpDistance * 1.8) < 1e-9);
});
