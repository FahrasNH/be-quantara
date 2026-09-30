"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");
const {
  resolveNaturalRiskTypeOrder,
} = require("../src/config/tradeTypeAvailability");
const {
  riskShareForType,
} = require("../src/core/risk-engine/typeRiskLadder");
const {
  calculatePreviousSessionVwap,
  evaluateVolumeProfileEntry,
} = require("../src/core/strategy-engine/ts/volumeProfileEntry");
const { evaluateFeeEdgeGate } = require("../src/core/risk-engine/entryRiskGates");

describe("AMT root-cause fixes", () => {
  test("shelving Scalping does not reallocate its natural risk share", () => {
    const natural = resolveNaturalRiskTypeOrder("AUCTION_MARKET_THEORY", ["Intraday", "Swing"]);
    assert.deepEqual(natural, ["Scalping", "Intraday", "Swing"]);
    assert.ok(Math.abs(riskShareForType("Intraday", natural, 0.05) - 0.02) < 1e-12);
    assert.ok(Math.abs(riskShareForType("Swing", natural, 0.05) - 0.02) < 1e-12);
  });

  test("previous session VWAP is taken from the completed UTC day", () => {
    const day = 86_400_000;
    const timestamps = [
      Date.UTC(2026, 0, 1, 23),
      Date.UTC(2026, 0, 1, 23, 30),
      Date.UTC(2026, 0, 2, 0),
      Date.UTC(2026, 0, 2, 0, 30),
    ];
    const highs = [100, 100, 200, 200];
    const lows = [100, 100, 200, 200];
    const closes = [100, 100, 200, 200];
    const volumes = [10, 10, 10, 10];
    const previous = calculatePreviousSessionVwap(
      highs, lows, closes, volumes, timestamps, 3, day,
    );

    assert.equal(previous.sessionFound, true);
    assert.equal(previous.startIdx, 0);
    assert.equal(previous.endIdx, 1);
    assert.equal(previous.vwap, 100);
  });

  test("AMT metadata identifies completed-session levels", () => {
    const day0 = Date.UTC(2026, 0, 1, 21);
    const timestamps = [
      day0,
      day0 + 3_600_000,
      day0 + 2 * 3_600_000,
      Date.UTC(2026, 0, 2, 0),
      Date.UTC(2026, 0, 2, 1),
      Date.UTC(2026, 0, 2, 2),
    ];
    const highs = [100, 100, 100, 101, 101, 102];
    const lows = [100, 100, 100, 99, 99, 101];
    const closes = [100, 100, 100, 99.5, 99.5, 101.5];
    const opens = [100, 100, 100, 100, 99.5, 99.5];
    const volumes = [1000, 1000, 1000, 1000, 1000, 1000];
    const atr = Array(6).fill(1);
    const result = evaluateVolumeProfileEntry(
      { highs, lows, closes, opens, volumes, timestamps, atr },
      5,
      {
        tradeType: "Intraday",
        minSessionBars: 2,
        amtMinBodyAtr: 0,
        amtMinVolumeRatio: 0,
      },
    );

    assert.equal(result.meta.previousSessionSource, "completed");
    assert.equal(result.meta.previousSessionStartIdx, 0);
    assert.equal(result.meta.previousSessionEndIdx, 2);
    assert.equal(result.meta.profileStartIdx, 0);
    assert.equal(result.meta.profileIdx, 2);
  });

  test("fee-edge gate blocks reward that cannot pay realistic friction", () => {
    const blocked = evaluateFeeEdgeGate({
      price: 100,
      tpDistance: 0.5,
      minEdgeFeeMultiple: 5,
      perSideFee: 0.001,
    });
    const allowed = evaluateFeeEdgeGate({
      price: 100,
      tpDistance: 2,
      minEdgeFeeMultiple: 5,
      perSideFee: 0.001,
    });

    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "fee_edge_too_thin");
    assert.equal(allowed.ok, true);
  });
});
