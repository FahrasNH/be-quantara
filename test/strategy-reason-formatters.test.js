/**
 * strategy-reason-formatters.test.js — unit tests for per-strategy CSV reason formatters.
 * Vocabulary aligned to Sprint 14 Notion CSV redesign.
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

describe("formatSmcReasons (SMART_MONEY_CONCEPTS)", () => {
  test("null → empty", () => expect(formatSmcReasons(null)).toBe(""));
  test("minimal sequence", () => {
    const out = formatSmcReasons({
      sequenceMeta: { sweepIdx: 10, chochIdx: 12, fvg: { type: "bullish" }, obConfluence: false },
    });
    expect(out).toBe("Liquidity Sweep, CHoCH, Bullish FVG");
  });
  test("full with Fresh OB", () => {
    const out = formatSmcReasons({
      sweepIdx: 1, chochIdx: 2, fvg: { type: "bearish" }, obConfluence: true,
    });
    expect(out).toBe("Liquidity Sweep, CHoCH, Fresh OB, Bearish FVG");
  });
});

describe("formatWyckoffReasons (WYCKOFF)", () => {
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
            volumeConfirm: true,
            lpsOrLpsy: true,
          },
        },
      },
    });
    expect(out).toContain("Upthrust");
    expect(out).toContain("SOW");
    expect(out).toContain("Volume Climax");
    expect(out).toContain("LPS/LPSY");
  });
});

describe("formatVsaReasons (VOLUME_SPREAD_ANALYSIS)", () => {
  test("null → empty", () => expect(formatVsaReasons(null)).toBe(""));
  test("stopping volume + swing proximity", () => {
    expect(formatVsaReasons({
      reason: "vsa_stopping_volume_low",
      meta: { nearSwing: { type: "low" } },
    })).toBe("Stopping Volume, Swing Proximity");
  });
  test("no demand near high", () => {
    expect(formatVsaReasons({
      reason: "vsa_no_demand",
      meta: { nearSwing: { type: "high" } },
    })).toBe("No-Demand, Swing Proximity");
  });
});

describe("formatTrendFollowingReasons (TREND_FOLLOWING)", () => {
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
    expect(out).toBe("HTF Aligned, ADX Strength, Donchian Break, EMA9 Retest, Volume Confirmation");
  });
});

describe("formatMarketStructureReasons (MARKET_STRUCTURE)", () => {
  test("null → empty", () => expect(formatMarketStructureReasons(null)).toBe(""));
  test("dow HL bounce", () => {
    const out = formatMarketStructureReasons({ reason: "dow_hl_pullback_bounce" });
    expect(out).toContain("Swing Structure");
    expect(out).toContain("HH/HL Pattern");
    expect(out).toContain("Pullback Bounce");
    expect(out).toContain("Same-Bar Confirm");
  });
  test("dow LH reject", () => {
    const out = formatMarketStructureReasons({ reason: "dow_lh_rally_reject" });
    expect(out).toContain("HH/HL Pattern");
    expect(out).toContain("Pullback Reject");
  });
});

describe("formatVolumeProfileReasons (AUCTION_MARKET_THEORY)", () => {
  test("null → empty", () => expect(formatVolumeProfileReasons(null)).toBe(""));
  test("maps four branches", () => {
    expect(formatVolumeProfileReasons({ reason: "vwap_reclaim" })).toBe("VWAP Reclaim");
    expect(formatVolumeProfileReasons({ reason: "vwap_lose" })).toBe("VWAP Lose");
    expect(formatVolumeProfileReasons({ reason: "val_bounce" })).toBe("VAL Bounce");
    expect(formatVolumeProfileReasons({ reason: "vah_reject" })).toBe("VAH Reject");
  });
});

describe("formatMeanReversionReasons (MEAN_REVERSION)", () => {
  test("null → empty", () => expect(formatMeanReversionReasons(null)).toBe(""));
  test("parses pipe-delimited reason", () => {
    const out = formatMeanReversionReasons({
      reason: "Scalping: RSI 24.1 < 28, BB(1.5σ) touch, below VWAP | ADX:balance | OB/FVG✓",
      adxRegime: "balance",
      hasObFvgConfluence: true,
    });
    expect(out).toContain("RSI Extreme");
    expect(out).toContain("BB Touch");
    expect(out).toContain("VWAP Dev");
    expect(out).toContain("ADX Balance");
    expect(out).toContain("OB/FVG Confluence");
  });
  test("overbought path", () => {
    const out = formatMeanReversionReasons({
      reason: "Intraday: RSI 74.2 > 72, BB(2.0σ) touch, above VWAP | ADX:transition | OB/FVG~",
    });
    expect(out).toContain("RSI Extreme");
    expect(out).toContain("ADX Balance");
    expect(out.includes("OB/FVG Confluence")).toBe(false);
  });
});

describe("formatBreakoutReasons (BREAKOUT_RETEST)", () => {
  test("null → empty", () => expect(formatBreakoutReasons(null)).toBe(""));
  test("core phases", () => {
    expect(formatBreakoutReasons({
      bbSqueeze: true,
      rangeBreakout: true,
      retestConfirmation: true,
    })).toBe("BB Squeeze, Range Break, Retest Confirm");
  });
});

describe("resolveEntryReasons dispatcher", () => {
  test("dispatches by winningComponent", () => {
    expect(resolveEntryReasons("ADAPTIVE_FUSION", {
      winningComponent: "SMART_MONEY_CONCEPTS",
      sequenceMeta: { sweepIdx: 0, chochIdx: 1, fvg: { type: "bullish" } },
    })).toContain("Liquidity Sweep");
  });
  test("dispatches AUCTION_MARKET_THEORY by strategy key", () => {
    expect(resolveEntryReasons("AUCTION_MARKET_THEORY", { reason: "val_bounce" })).toBe("VAL Bounce");
  });
  test("dispatches MEAN_REVERSION", () => {
    expect(resolveEntryReasons("MEAN_REVERSION", {
      reason: "Scalping: RSI 20 < 28, BB touch | ADX:balance | OB/FVG✓",
    })).toContain("RSI Extreme");
  });
  test("dispatches BREAKOUT_RETEST", () => {
    expect(resolveEntryReasons("BREAKOUT_RETEST", {
      bbSqueeze: true, rangeBreakout: true, retestConfirmation: true,
    })).toBe("BB Squeeze, Range Break, Retest Confirm");
  });
  test("unknown → empty", () => {
    expect(resolveEntryReasons("UNKNOWN_X", {})).toBe("");
  });
  test("AF umbrella meta from getLastSignalMeta (SMC nested sequenceMeta) is non-empty", () => {
    const afMeta = {
      confidence: { Scalping: 72, Intraday: 0, Swing: 0 },
      aggregateConfidence: 72,
      marketCond: "NORMAL",
      sequenceMeta: {
        sweepIdx: 10, chochIdx: 12, fvg: { type: "bearish" }, obConfluence: true,
      },
      component: "SMART_MONEY_CONCEPTS",
      winningComponent: "SMART_MONEY_CONCEPTS",
      strategyLabel: "Smart Money Concepts",
    };
    const out = resolveEntryReasons("SMART_MONEY_CONCEPTS", afMeta);
    expect(out).toContain("Liquidity Sweep");
    expect(out).toContain("CHoCH");
    expect(out).toContain("Bearish FVG");
    expect(out).toContain("Fresh OB");
    expect(out.length > 0).toBe(true);
  });
  test("MEAN_REVERSION + AUCTION_MARKET_THEORY + BREAKOUT_RETEST synthetic meta never empty", () => {
    expect(resolveEntryReasons("MEAN_REVERSION", {
      reason: "Scalping: RSI 24.1 < 28, BB(1.5σ) touch, below VWAP | ADX:balance | OB/FVG✓",
      adxRegime: "balance",
      hasObFvgConfluence: true,
    }).length > 0).toBe(true);
    expect(resolveEntryReasons("AUCTION_MARKET_THEORY", { reason: "vah_reject" })).toBe("VAH Reject");
    expect(resolveEntryReasons("BREAKOUT_RETEST", {
      winningComponent: "BREAKOUT_RETEST",
      bbSqueeze: true,
      rangeBreakout: true,
      retestConfirmation: true,
    })).toContain("BB Squeeze");
  });
});

run();
