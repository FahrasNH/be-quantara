/**
 * strategy-reason-formatters.test.js — unit tests for per-strategy CSV reason formatters.
 */

const { describe, test, expect, run } = require("./helpers/jest-lite");
const {
  formatExitReason,
  resolveEntryReasons,
  formatSmcReasons,
  formatWyckoffReasons,
  formatVsaReasons,
  formatTrendFollowingReasons,
  formatMarketStructureReasons,
  formatVolumeProfileReasons,
  formatMeanReversionReasons,
  formatBreakoutReasons,
} = require("../src/server/services/csv/strategyReasonFormatters");

describe("formatExitReason", () => {
  test("maps TP/SL/TIME_STOP/partials", () => {
    expect(formatExitReason("TP")).toBe("Take Profit");
    expect(formatExitReason("SL")).toBe("Stop Loss");
    expect(formatExitReason("TIME_STOP")).toBe("Time Stop");
    expect(formatExitReason("SL_TRAIL")).toBe("Trailing Stop");
    expect(formatExitReason("Partial_1R")).toBe("Partial +1R");
    expect(formatExitReason("Partial_2R")).toBe("Partial +2R");
  });
  test("null/empty → empty string", () => {
    expect(formatExitReason(null)).toBe("");
    expect(formatExitReason("")).toBe("");
  });
});

describe("formatSmcReasons (AF_SMC)", () => {
  test("null → empty", () => expect(formatSmcReasons(null)).toBe(""));
  test("minimal sequence", () => {
    const out = formatSmcReasons({
      sequenceMeta: { sweepIdx: 10, chochIdx: 12, fvg: { type: "bullish" }, obConfluence: false },
    });
    expect(out).toBe("Liquidity Sweep, CHoCH, Bullish FVG");
  });
  test("full with Fresh Order Block", () => {
    const out = formatSmcReasons({
      sweepIdx: 1, chochIdx: 2, fvg: { type: "bearish" }, obConfluence: true,
    });
    expect(out).toBe("Liquidity Sweep, CHoCH, Bearish FVG, Fresh Order Block");
  });
});

describe("formatWyckoffReasons (AF_WYCKOFF)", () => {
  test("null → empty", () => expect(formatWyckoffReasons(null)).toBe(""));
  test("spring reason", () => {
    expect(formatWyckoffReasons({ reason: "wyckoff_spring" })).toBe("Spring");
  });
  test("upthrust + checklist", () => {
    const out = formatWyckoffReasons({
      reason: "wyckoff_upthrust",
      vote: "SHORT",
      meta: {
        entry: {
          checklist: {
            sosOrSow: true,
            manipulation: true,
            reclaimOrReject: true,
            volumeConfirm: true,
          },
        },
      },
    });
    expect(out).toContain("Upthrust");
    expect(out).toContain("SOW");
    expect(out).toContain("Manipulation");
  });
});

describe("formatVsaReasons (AF_VSA)", () => {
  test("null → empty", () => expect(formatVsaReasons(null)).toBe(""));
  test("stopping volume + location", () => {
    expect(formatVsaReasons({
      reason: "vsa_stopping_volume_low",
      meta: { nearSwing: { type: "low" } },
    })).toBe("Stopping Volume near Swing Low");
  });
  test("no demand near high", () => {
    expect(formatVsaReasons({
      reason: "vsa_no_demand",
      meta: { nearSwing: { type: "high" } },
    })).toBe("No-Demand near Swing High");
  });
});

describe("formatTrendFollowingReasons (TS_TF)", () => {
  test("null → empty", () => expect(formatTrendFollowingReasons(null)).toBe(""));
  test("full checklist", () => {
    const out = formatTrendFollowingReasons({
      entryChecklist: {
        htfTrendAligned: true,
        adxPassed: true,
        donchianBroken: true,
        ema9Retest: true,
        volumeConfirmed: true,
        adxMinStrength: 25,
        donchianPeriod: 20,
      },
    });
    expect(out).toBe("HTF Trend Aligned, ADX ≥ 25, Donchian 20-bar Breakout, EMA9 Retest, Volume Confirmed");
  });
});

describe("formatMarketStructureReasons (TS_MS)", () => {
  test("null → empty", () => expect(formatMarketStructureReasons(null)).toBe(""));
  test("dow HL bounce", () => {
    const out = formatMarketStructureReasons({ reason: "dow_hl_pullback_bounce" });
    expect(out).toContain("Confirmed Swing Structure");
    expect(out).toContain("HH/HL Pattern");
    expect(out).toContain("Pullback Bounce");
    expect(out).toContain("Same-Bar Confirmation");
  });
  test("dow LH reject", () => {
    const out = formatMarketStructureReasons({ reason: "dow_lh_rally_reject" });
    expect(out).toContain("LH/LL Pattern");
    expect(out).toContain("Pullback Reject");
  });
});

describe("formatVolumeProfileReasons (TS_VP)", () => {
  test("null → empty", () => expect(formatVolumeProfileReasons(null)).toBe(""));
  test("maps four branches", () => {
    expect(formatVolumeProfileReasons({ reason: "vwap_reclaim" })).toBe("VWAP Reclaim");
    expect(formatVolumeProfileReasons({ reason: "vwap_lose" })).toBe("VWAP Lose");
    expect(formatVolumeProfileReasons({ reason: "val_bounce" })).toBe("VAL Bounce");
    expect(formatVolumeProfileReasons({ reason: "vah_reject" })).toBe("VAH Rejection");
  });
});

describe("formatMeanReversionReasons (MD_MR)", () => {
  test("null → empty", () => expect(formatMeanReversionReasons(null)).toBe(""));
  test("parses pipe-delimited reason", () => {
    const out = formatMeanReversionReasons({
      reason: "Scalping: RSI 24.1 < 28, BB(1.5σ) touch, below VWAP | ADX:balance | OB/FVG✓",
      adxRegime: "balance",
      hasObFvgConfluence: true,
    });
    expect(out).toContain("RSI Oversold");
    expect(out).toContain("Bollinger Band Touch");
    expect(out).toContain("VWAP Deviation");
    expect(out).toContain("ADX Balance");
    expect(out).toContain("Order Block/FVG Confluence");
  });
  test("overbought path", () => {
    const out = formatMeanReversionReasons({
      reason: "Intraday: RSI 74.2 > 72, BB(2.0σ) touch, above VWAP | ADX:transition | OB/FVG~",
    });
    expect(out).toContain("RSI Overbought");
    expect(out).toContain("ADX Transition");
    expect(out.includes("Order Block/FVG Confluence")).toBe(false);
  });
});

describe("formatBreakoutReasons (BS_BR)", () => {
  test("null → empty", () => expect(formatBreakoutReasons(null)).toBe(""));
  test("three phases", () => {
    expect(formatBreakoutReasons({
      bbSqueeze: true,
      rangeBreakout: true,
      retestConfirmation: true,
    })).toBe("BB Squeeze, Range Breakout, Retest Confirmation");
  });
});

describe("resolveEntryReasons dispatcher", () => {
  test("dispatches by winningComponent", () => {
    expect(resolveEntryReasons("ADAPTIVE_FUSION", {
      winningComponent: "AF_SMC",
      sequenceMeta: { sweepIdx: 0, chochIdx: 1, fvg: { type: "bullish" } },
    })).toContain("Liquidity Sweep");
  });
  test("dispatches TS_VP by strategy key", () => {
    expect(resolveEntryReasons("TS_VP", { reason: "val_bounce" })).toBe("VAL Bounce");
  });
  test("dispatches MD_MR", () => {
    expect(resolveEntryReasons("MEAN_REVERSION", {
      reason: "Scalping: RSI 20 < 28, BB touch | ADX:balance | OB/FVG✓",
    })).toContain("RSI Oversold");
  });
  test("dispatches BS_BR", () => {
    expect(resolveEntryReasons("BREAKOUT_RETEST", {
      bbSqueeze: true, rangeBreakout: true, retestConfirmation: true,
    })).toBe("BB Squeeze, Range Breakout, Retest Confirmation");
  });
  test("unknown → empty", () => {
    expect(resolveEntryReasons("UNKNOWN_X", {})).toBe("");
  });
});

run();
