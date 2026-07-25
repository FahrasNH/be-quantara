/**
 * vsa-sprint23-gates.test.js — Sprint 23 VSA session, shelve, Swing filters.
 */
"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  applyVsaSessionFilter,
  applyVsaEntryGates,
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
    const ablation = { rejScalpingShelved: 0, evaluated: 0, rejPattern: 0, passed: 0 };
    const result = evaluateVSAComponent(candles, null, {
      tradeType: "Scalping",
      typeOverrides: { Scalping: { vsaScalpingShelved: true } },
      ablation,
    });
    assert.equal(result.vote, "NEUTRAL");
    assert.equal(result.reason, "vsa_scalping_shelved");
    assert.equal(ablation.rejScalpingShelved, 1);
    assert.equal(ablation.rejPattern, 0);
    assert.equal(ablation.passed, 0);
  });

  test("Scalping shelved via activeComponents when tradeType omitted", () => {
    const candles = {
      opens: Array(30).fill(100),
      highs: Array(30).fill(101),
      lows: Array(30).fill(99),
      closes: Array(30).fill(100.5),
      volumes: Array(30).fill(1000),
      atr: Array(30).fill(1),
      lastIdx: 29,
    };
    const ablation = { rejScalpingShelved: 0, evaluated: 0, passed: 0 };
    const result = evaluateVSAComponent(candles, null, {
      activeComponents: ["Scalping"],
      vsaScalpingShelved: true,
      ablation,
    });
    assert.equal(result.reason, "vsa_scalping_shelved");
    assert.equal(ablation.rejScalpingShelved, 1);
    assert.equal(ablation.passed, 0);
  });

  test("passed is not incremented when post-pattern session gate blocks", () => {
    const ablation = { passed: 0, rejBySession: 0 };
    const raw = { vote: "LONG", confidence: 0.8, reason: "no_supply" };
    const gated = applyVsaEntryGates(raw, {
      config: {
        tradeType: "Scalping",
        typeOverrides: {
          Scalping: {
            vsaSessionFilter: true,
            noTradeSessions: ["Sydney", "Tokyo"],
          },
        },
        candleTimestamp: Date.parse("2024-06-01T03:00:00.000Z"),
      },
      candles: { lastIdx: 0 },
      ablation,
    });
    if (gated.vote === "LONG" || gated.vote === "SHORT") ablation.passed += 1;
    assert.equal(gated.vote, "NEUTRAL");
    assert.equal(ablation.rejBySession, 1);
    assert.equal(ablation.passed, 0);
  });

  test("Intraday HTF gate: hard block SHORT×BULLISH", () => {
    const ablation = { rejHtfShortBullish: 0, passed: 0 };
    const gated = applyVsaEntryGates(
      { vote: "SHORT", confidence: 0.8, reason: "vsa_no_demand" },
      {
        config: { tradeType: "Intraday", htfTrend: "BULLISH", vsaHtfAlignGate: true },
        ablation,
      },
    );
    assert.equal(gated.vote, "NEUTRAL");
    assert.equal(gated.reason, "vsa_htf_short_bullish");
    assert.equal(ablation.rejHtfShortBullish, 1);
  });

  test("Intraday HTF gate: hard block STOPPING_VOLUME counter-trend", () => {
    const ablation = { rejHtfStoppingCounter: 0 };
    const gated = applyVsaEntryGates(
      { vote: "LONG", confidence: 0.9, reason: "vsa_stopping_volume_low" },
      {
        config: { tradeType: "Intraday", htfTrend: "BEARISH", vsaHtfAlignGate: true },
        ablation,
      },
    );
    assert.equal(gated.vote, "NEUTRAL");
    assert.equal(gated.reason, "vsa_htf_stopping_counter");
    assert.equal(ablation.rejHtfStoppingCounter, 1);
  });

  test("Intraday HTF gate: penalty LONG×BEARISH (non-stopping)", () => {
    const ablation = { rejHtfLongBearishPenalty: 0 };
    const gated = applyVsaEntryGates(
      { vote: "LONG", confidence: 0.8, reason: "vsa_no_supply" },
      {
        config: {
          tradeType: "Intraday",
          htfTrend: "BEARISH",
          vsaHtfAlignGate: true,
          vsaHtfCounterPenalty: 0.5,
        },
        ablation,
      },
    );
    assert.equal(gated.vote, "LONG");
    assert.equal(ablation.rejHtfLongBearishPenalty, 1);
    assert.ok(gated.confidence < 0.8);
    assert.equal(gated.meta?.htfCounterPenalty, 0.5);
  });

  test("Intraday defaults enable HTF align gate", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Intraday.vsaHtfAlignGate, true);
    assert.equal(ov.Intraday.vsaHtfCounterPenalty, 0.5);
  });
});
