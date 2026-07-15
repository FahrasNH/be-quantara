"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeSmcParams } = require("../src/core/strategy-engine/smc/smcParamCompat");
const SmartMoneyConceptsStrategy = require("../src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy");

describe("smcParamCompat", () => {
  test("copies sac* → smc* when smc absent", () => {
    const out = normalizeSmcParams({
      sacMinConfidenceA: 55,
      sacUseSequenceEngine: false,
      typeOverrides: {
        Swing: { sacSwingV3Gate: true, sacSwingMinRvol: 1.5 },
      },
    });
    assert.equal(out.smcMinConfidenceA, 55);
    assert.equal(out.smcUseSequenceEngine, false);
    assert.equal(out.typeOverrides.Swing.smcSwingV3Gate, true);
    assert.equal(out.typeOverrides.Swing.smcSwingMinRvol, 1.5);
    assert.equal(out.sacMinConfidenceA, 55);
  });

  test("smc* wins over sac* on conflict", () => {
    const out = normalizeSmcParams({
      sacMinConfidenceA: 40,
      smcMinConfidenceA: 70,
    });
    assert.equal(out.smcMinConfidenceA, 70);
  });

  test("legacy sac keys still drive detectSignalMulti", () => {
    const smc = new SmartMoneyConceptsStrategy();
    const indicators = {
      closes: Array(30).fill(100),
      highs: Array(30).fill(101),
      lows: Array(30).fill(99),
      volumes: Array(30).fill(1000),
      volSMA: Array(30).fill(800),
      opens: Array(30).fill(100),
      emaFast: Array(30).fill(100),
      emaSlow: Array(30).fill(100),
    };
    const r = smc.detectSignalMulti(indicators, 29, {
      sacUseSequenceEngine: false,
      sacMinConfidenceA: 0,
      sacMinConfidenceB: 0,
      sacMinConfidenceC: 0,
      htfTrend: "BULLISH",
    });
    assert.ok(r.meta);
  });
});
