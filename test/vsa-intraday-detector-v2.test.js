/**
 * Sprint 23 — VSA Intraday detector v2 + session per-tier guards.
 */
"use strict";

const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const {
  evaluateVSAComponent,
  resolveVsaSessionGateFlags,
  resolveVsaIntradayGateFlags,
  applyVsaEntryGates,
} = require("../src/core/strategy-engine/af/vsaEntry");
const {
  detectConfirmationBar,
  resolveIntradayDetectorMode,
} = require("../src/core/strategy-engine/af/vsaIntradayDetector");
const { STRATEGIES } = require("../src/config/strategyDefaults");

function makeCandles(n, opts = {}) {
  const opens = [];
  const highs = [];
  const lows = [];
  const closes = [];
  const volumes = [];
  const atr = [];
  for (let i = 0; i < n; i++) {
    const base = 100 + i * 0.01;
    opens.push(base);
    highs.push(base + 2);
    lows.push(base - 2);
    closes.push(base + (opts.bullish ? 0.5 : -0.5));
    volumes.push(opts.volume?.[i] ?? 1000);
    atr.push(2);
  }
  return { opens, highs, lows, closes, volumes, atr, lastIdx: n - 1 };
}

describe("VSA Intraday detector v2", () => {
  test("defaults: confirmation mode + London block (not Asia)", () => {
    const ov = STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides;
    assert.equal(ov.Intraday.vsaIntradayDetectorMode, "confirmation");
    assert.equal(ov.Intraday.vsaSessionFilter, true);
    assert.deepEqual(ov.Intraday.noTradeSessions, ["London"]);
    assert.equal(ov.Intraday.noTradeSessions.includes("Tokyo"), false);
    assert.equal(ov.Scalping.noTradeSessions.includes("Tokyo"), true);
  });

  test("resolveVsaSessionGateFlags: Intraday gets London, Scalping gets Asia", () => {
    const cfg = STRATEGIES.VOLUME_SPREAD_ANALYSIS;
    const scalp = resolveVsaSessionGateFlags(cfg, "Scalping");
    const intra = resolveVsaSessionGateFlags(cfg, "Intraday");
    assert.equal(scalp.vsaSessionFilter, true);
    assert.deepEqual(scalp.noTradeSessions, ["Sydney", "Tokyo"]);
    assert.equal(intra.vsaSessionFilter, true);
    assert.deepEqual(intra.noTradeSessions, ["London"]);
  });

  test("Intraday London session gate blocks UTC 10:00", () => {
    const ablation = { rejBySession: 0 };
    const gated = applyVsaEntryGates(
      { vote: "LONG", confidence: 0.8, reason: "vsa_no_supply_confirmed" },
      {
        config: {
          tradeType: "Intraday",
          typeOverrides: STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides,
          candleTimestamp: Date.parse("2024-06-01T10:00:00.000Z"),
        },
        ablation,
      },
    );
    assert.equal(gated.vote, "NEUTRAL");
    assert.equal(ablation.rejBySession, 1);
  });

  test("Intraday Tokyo session NOT blocked (Asia is best subset)", () => {
    const ablation = { rejBySession: 0 };
    const gated = applyVsaEntryGates(
      { vote: "LONG", confidence: 0.8, reason: "vsa_no_supply_confirmed" },
      {
        config: {
          tradeType: "Intraday",
          typeOverrides: STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides,
          candleTimestamp: Date.parse("2024-06-01T03:00:00.000Z"),
        },
        ablation,
      },
    );
    assert.equal(gated.vote, "LONG");
    assert.equal(ablation.rejBySession, 0);
  });

  test("resolveIntradayDetectorMode falls back to confirmation", () => {
    assert.equal(resolveIntradayDetectorMode({}), "confirmation");
    assert.equal(resolveIntradayDetectorMode({ vsaIntradayDetectorMode: "hvsa" }), "hvsa");
    assert.equal(resolveIntradayDetectorMode({ vsaIntradayDetectorMode: "bogus" }), "confirmation");
  });

  test("confirmation bar rejects when next bar fails volume test", () => {
    const candles = makeCandles(25, { bullish: true });
    candles.volumes[23] = 2000;
    candles.volumes[24] = 2500;
    candles.closes[24] = candles.opens[24] - 1;
    candles.lastIdx = 24;
    const ablation = {};
    const result = detectConfirmationBar(candles, 24, { minBars: 20, volumeSmaPeriod: 20 }, ablation);
    assert.equal(result, null);
    assert.ok(ablation.rejConfirmationFailed >= 1 || ablation.rejConfirmationNoPattern >= 1);
  });

  test("Intraday v2 path returns NEUTRAL when no pattern (not legacy 1-bar)", () => {
    const candles = makeCandles(30);
    const ablation = { evaluated: 0, rejPattern: 0, passed: 0 };
    const result = evaluateVSAComponent(candles, null, {
      tradeType: "Intraday",
      typeOverrides: STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides,
      ablation,
    });
    assert.equal(result.vote, "NEUTRAL");
    assert.equal(ablation.rejPattern, 1);
  });

  test("resolveVsaIntradayGateFlags exposes session + HTF flags", () => {
    const flags = resolveVsaIntradayGateFlags({
      typeOverrides: STRATEGIES.VOLUME_SPREAD_ANALYSIS.typeOverrides,
    });
    assert.equal(flags.vsaHtfAlignGate, true);
    assert.equal(flags.vsaSessionFilter, true);
    assert.deepEqual(flags.noTradeSessions, ["London"]);
  });
});
