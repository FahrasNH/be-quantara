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
  resolveVsaSessionGateFlags,
} = require("../src/core/strategy-engine/af/vsaEntry");
const { STRATEGIES } = require("../src/config/strategyDefaults");
const { evaluateAtrEntryGate } = require("../src/core/risk-engine/entryRiskGates");

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

  test("VSA defaults: Scalping shelved + Swing conf floor; session filters OFF", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Scalping.vsaScalpingShelved, true);
    assert.equal(ov.Scalping.vsaSessionFilter, false);
    assert.equal(ov.Swing.vsaSwingLongOnly, true);
    assert.equal(ov.Swing.vsaMinConfidenceSwing, 60);
    assert.equal(ov.Swing.vsaSessionFilter, false);
    assert.equal(ov.Swing.noTradeSessions, undefined);
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

  test("Intraday HTF overlay: flag SHORT×BULLISH (no hard block)", () => {
    const ablation = { rejHtfShortBullish: 0, passed: 0 };
    const gated = applyVsaEntryGates(
      { vote: "SHORT", confidence: 0.8, reason: "vsa_no_demand" },
      {
        config: { tradeType: "Intraday", htfTrend: "BULLISH", vsaHtfAlignGate: true },
        ablation,
      },
    );
    assert.equal(gated.vote, "SHORT");
    assert.equal(gated.meta?.htfCounterTrend, true);
    assert.equal(gated.meta?.vsaHtfConfidenceFlag, true);
    assert.equal(ablation.rejHtfShortBullish, 1);
  });

  test("Intraday HTF overlay: flag STOPPING_VOLUME counter-trend (no block)", () => {
    const ablation = { rejHtfStoppingCounter: 0 };
    const gated = applyVsaEntryGates(
      { vote: "LONG", confidence: 0.9, reason: "vsa_stopping_volume_low" },
      {
        config: { tradeType: "Intraday", htfTrend: "BEARISH", vsaHtfAlignGate: true },
        ablation,
      },
    );
    assert.equal(gated.vote, "LONG");
    assert.equal(gated.meta?.htfCounterTrend, true);
    assert.equal(ablation.rejHtfStoppingCounter, 1);
  });

  test("Intraday HTF overlay: flag LONG×BEARISH (no confidence penalty)", () => {
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
    assert.equal(gated.meta?.htfCounterTrend, true);
    assert.equal(gated.meta?.vsaHtfConfidenceFlag, true);
    assert.equal(ablation.rejHtfLongBearishPenalty, 1);
  });

  test("Intraday defaults enable HTF align gate; session filter OFF", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Intraday.vsaHtfAlignGate, true);
    assert.equal(ov.Intraday.vsaHtfCounterPenalty, 0.5);
    assert.equal(ov.Intraday.vsaSessionFilter, false);
    assert.equal(ov.Intraday.noTradeSessions, undefined);
    assert.equal(ov.Intraday.vsaIntradayDetectorMode, "confirmation");
  });

  test("Intraday absolute ATR gate restored (Fix #4 reverted post-WF BLOCK)", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides.Intraday;
    assert.equal(ov.atrMinMult, 0.4);
    assert.notEqual(ov.atrGateRelative, true, "relative gate reverted — caused fee-bound overtrading");

    const price = 100_000;
    const quietAtr = 250;
    const quietPct = (quietAtr / price) * 100;

    const gate = evaluateAtrEntryGate({
      atr: quietAtr,
      price,
      atrMinMult: ov.atrMinMult,
      atrGateRelative: false,
    });
    assert.equal(gate.ok, false, "absolute 0.4% floor blocks typical BTC 15m quiet leg");
    assert.ok(quietPct < 0.4);
  });

  test("GUARD: all VSA legs have session filter OFF (no Asia/London blocks)", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Scalping.vsaSessionFilter, false);
    assert.equal(ov.Intraday.vsaSessionFilter, false);
    assert.equal(ov.Swing.vsaSessionFilter, false);
    assert.equal(ov.Scalping.noTradeSessions, undefined);
    assert.equal(ov.Intraday.noTradeSessions, undefined);
    assert.equal(ov.Swing.noTradeSessions, undefined);
    const intraSess = resolveVsaSessionGateFlags(
      { typeOverrides: ov },
      "Intraday",
    );
    assert.equal(intraSess.vsaSessionFilter, false);
  });
});
