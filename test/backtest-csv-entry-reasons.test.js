/**
 * backtest-csv-entry-reasons.test.js — mapBacktestTrade prefers trade-close
 * entryReasons and falls back to entryMeta formatters (SMC / MD_MR / TS_VP / BS_BR).
 */

const { describe, test, expect, run } = require("./helpers/jest-lite");
const { mapBacktestTrade } = require("../src/server/services/BacktestCsvService");

const ctx = {
  backtestId: "bt-1",
  symbol: "BTCUSDT",
  strategy: "Smart Money Concepts",
  exchange: "binance",
  sessionId: "BT-bt-1",
  userLabel: "Backtest",
};

describe("mapBacktestTrade entryReasons", () => {
  test("uses precomputed entryReasons from trade close", () => {
    const row = mapBacktestTrade({
      side: "LONG",
      entry: 61877.6,
      exit: 62000,
      atr: 450.2,
      entryRsi: 42.5,
      reason: "TP",
      entryReasons: "Liquidity Sweep, CHoCH, Bullish FVG",
      entryMeta: null,
    }, ctx, 0);
    expect(row.entryReasons).toBe("Liquidity Sweep, CHoCH, Bullish FVG");
    expect(row.exitReason).toBe("Take Profit");
    expect(row.atr).toBe(450.2);
    expect(row.entryRsi).toBe(42.5);
  });

  test("SMC sequenceMeta → non-empty when entryReasons missing", () => {
    const row = mapBacktestTrade({
      side: "LONG",
      entry: 61877.6,
      exit: 61000,
      reason: "SL",
      winningComponent: "AF_SMC",
      strategyKey: "AF_SMC",
      atr: 512,
      entryRsi: 55,
      entryMeta: {
        winningComponent: "AF_SMC",
        sequenceMeta: {
          sweepIdx: 8, chochIdx: 11, fvg: { type: "bullish" }, obConfluence: false,
        },
      },
    }, ctx, 1);
    expect(row.entryReasons).toContain("Liquidity Sweep");
    expect(row.entryReasons).not.toBe("N/A");
  });

  test("MD_MR / TS_VP / BS_BR synthetic meta → non-empty", () => {
    const mr = mapBacktestTrade({
      side: "SHORT", entry: 100, exit: 99, reason: "TP", strategyKey: "MD_MR",
      entryMeta: {
        reason: "Intraday: RSI 74.2 > 72, BB(2.0σ) touch, above VWAP | ADX:transition | OB/FVG~",
      },
    }, { ...ctx, strategy: "Mean Reversion" }, 0);
    expect(mr.entryReasons).toContain("RSI Overbought");

    const vp = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 101, reason: "TP", strategyKey: "TS_VP",
      entryMeta: { reason: "val_bounce" },
    }, { ...ctx, strategy: "Auction Market Theory" }, 0);
    expect(vp.entryReasons).toBe("VAL Bounce");

    const br = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 102, reason: "TP", strategyKey: "BS_BR",
      entryMeta: {
        winningComponent: "BS_BR",
        bbSqueeze: true, rangeBreakout: true, retestConfirmation: true,
      },
    }, { ...ctx, strategy: "Breakout Trading" }, 0);
    expect(br.entryReasons).toContain("BB Squeeze");
  });

  test("tradeType classified by hold duration; hourUtc + holdHours derived", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 102, reason: "TP",
      component: "BS_BR", strategyKey: "BS_BR",
      openTime: "2024-01-01T09:00:00Z",
      closeTime: "2024-01-01T11:00:00Z",
    }, { ...ctx, strategy: "Breakout Trading" }, 0);
    expect(row.tradeType).toBe("Scalping");
    expect(row.component).toBe("BS_BR");
    expect(row.hourUtc).toBe(9);
    expect(row.holdHours).toBe(2);
  });

  test("rejects absurd atr / entryRsi magnitudes", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 61877.6, exit: 62000, reason: "TP",
      atr: 9703477651638930,
      entryRsi: 4430841975420590,
      entryReasons: "x",
    }, ctx, 0);
    expect(row.atr).toBe("N/A");
    expect(row.entryRsi).toBe("N/A");
  });
});

run();
