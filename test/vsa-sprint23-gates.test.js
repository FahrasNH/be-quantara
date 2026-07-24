/**
 * vsa-sprint23-gates.test.js — Sprint 23 VSA session, shelve, Swing filters.
 */
"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyVsaSessionFilter,
  evaluateVSAComponent,
  resolveVsaScalpingGateFlags,
  resolveVsaSwingGateFlags,
} = require("../src/core/strategy-engine/af/vsaEntry");
const { STRATEGIES } = require("../src/config/strategyDefaults");

describe("VSA Sprint 23 gates", () => {
  test("applyVsaSessionFilter blocks Tokyo hour", () => {
    const tsTokyo = Date.parse("2024-06-01T03:00:00.000Z");
    const blocked = applyVsaSessionFilter(tsTokyo, {
      enabled: true,
      noTradeSessions: ["Sydney", "Tokyo"],
    });
    assert.equal(blocked.blocked, true);
    const tsLondon = Date.parse("2024-06-01T10:00:00.000Z");
    const open = applyVsaSessionFilter(tsLondon, {
      enabled: true,
      noTradeSessions: ["Sydney", "Tokyo"],
    });
    assert.equal(open.blocked, false);
  });

  test("VSA defaults: Scalping shelved + Swing conf floor", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Scalping.vsaScalpingShelved, true);
    assert.equal(ov.Scalping.vsaSessionFilter, true);
    assert.equal(ov.Swing.vsaSwingLongOnly, true);
    assert.equal(ov.Swing.vsaMinConfidenceSwing, 60);
    assert.deepEqual(ov.Swing.noTradeSessions, ["Sydney", "Tokyo"]);
  });

  test("resolveVsaScalpingGateFlags reads typeOverrides", () => {
    const flags = resolveVsaScalpingGateFlags({
      typeOverrides: { Scalping: { vsaScalpingShelved: true, vsaSessionFilter: true } },
    });
    assert.equal(flags.vsaScalpingShelved, true);
    assert.equal(flags.vsaSessionFilter, true);
  });

  test("resolveVsaSwingGateFlags reads long-only + conf floor", () => {
    const flags = resolveVsaSwingGateFlags({
      typeOverrides: { Swing: { vsaSwingLongOnly: true, vsaMinConfidenceSwing: 60 } },
    });
    assert.equal(flags.vsaSwingLongOnly, true);
    assert.equal(flags.vsaMinConfidenceSwing, 60);
  });

  test("Scalping shelved returns neutral before pattern eval", () => {
    const candles = {
      opens: Array(30).fill(100),
      highs: Array(30).fill(101),
      lows: Array(30).fill(99),
      closes: Array(30).fill(100.5),
      volumes: Array(30).fill(1000),
      atr: Array(30).fill(1),
      lastIdx: 29,
    };
    const ablation = { rejScalpingShelved: 0, evaluated: 0 };
    const result = evaluateVSAComponent(candles, null, {
      tradeType: "Scalping",
      typeOverrides: { Scalping: { vsaScalpingShelved: true } },
      ablation,
    });
    assert.equal(result.vote, "NEUTRAL");
    assert.equal(result.reason, "vsa_scalping_shelved");
    assert.equal(ablation.rejScalpingShelved, 1);
  });
});
