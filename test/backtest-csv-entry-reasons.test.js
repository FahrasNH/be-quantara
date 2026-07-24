/**
 * backtest-csv-entry-reasons.test.js — mapBacktestTrade prefers trade-close
 * entryReasons and falls back to entryMeta formatters (SMC / MEAN_REVERSION / AUCTION_MARKET_THEORY / BREAKOUT_RETEST).
 * Sprint 14: CORE CSV schema (no stale ML numerics).
 */

const { describe, test, expect, run } = require("./helpers/jest-lite");
const { mapBacktestTrade, buildTradesCsv } = require("../src/server/services/BacktestCsvService");
const {
  strategyCsvColumnKeys,
  resolveExportColumnKeys,
  UNIVERSAL_CSV_COLUMN_KEYS,
} = require("../src/server/services/csv/strategyReasonFormatters");
const {
  TRADE_EXPORT_COLUMN_KEYS,
  DROPPED_ML_CSV_COLUMN_KEYS,
  ADMIN_TRADE_EXPORT_COLUMNS,
  FULL_EXPORT_GEOMETRY_COLUMNS,
  ML_FIELD_SETS,
} = require("#shared/csv/tradeExportCsv.js");

const FULL_EXPORT_BASE_COLUMN_COUNT =
  ADMIN_TRADE_EXPORT_COLUMNS.length + FULL_EXPORT_GEOMETRY_COLUMNS.length;

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
      winningComponent: "SMART_MONEY_CONCEPTS",
      strategyKey: "SMART_MONEY_CONCEPTS",
      atr: 512,
      entryRsi: 55,
      entryMeta: {
        winningComponent: "SMART_MONEY_CONCEPTS",
        sequenceMeta: {
          sweepIdx: 8, chochIdx: 11, fvg: { type: "bullish" }, obConfluence: false,
        },
      },
    }, ctx, 1);
    expect(row.entryReasons).toContain("Liquidity Sweep");
    expect(row.entryReasons).not.toBe("N/A");
  });

  test("MEAN_REVERSION / AUCTION_MARKET_THEORY / BREAKOUT_RETEST synthetic meta → non-empty", () => {
    const mr = mapBacktestTrade({
      side: "SHORT", entry: 100, exit: 99, reason: "TP", strategyKey: "MEAN_REVERSION",
      entryMeta: {
        reason: "Intraday: RSI 74.2 > 72, BB(2.0σ) touch, above VWAP | ADX:transition | OB/FVG~",
      },
    }, { ...ctx, strategy: "Mean Reversion" }, 0);
    expect(mr.entryReasons).toContain("RSI Extreme");
    expect(mr.entryReasons).toContain("BB Touch");

    const vp = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 101, reason: "TP", strategyKey: "AUCTION_MARKET_THEORY",
      entryMeta: { reason: "val_bounce" },
    }, { ...ctx, strategy: "Auction Market Theory" }, 0);
    expect(vp.entryReasons).toBe("VAL Bounce");

    const br = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 102, reason: "TP", strategyKey: "BREAKOUT_RETEST",
      entryMeta: {
        winningComponent: "BREAKOUT_RETEST",
        bbSqueeze: true, rangeBreakout: true, retestConfirmation: true,
      },
    }, { ...ctx, strategy: "Breakout Trading" }, 0);
    expect(br.entryReasons).toContain("BB Squeeze");
    expect(br.entryReasons).toContain("Range Break");
    expect(br.entryReasons).toContain("Retest Confirm");
  });

  test("tradeType classified by hold duration; hourUtc + holdHours derived", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 102, reason: "TP",
      component: "BREAKOUT_RETEST", strategyKey: "BREAKOUT_RETEST",
      openTime: "2024-01-01T09:00:00Z",
      closeTime: "2024-01-01T11:00:00Z",
    }, { ...ctx, strategy: "Breakout Trading" }, 0);
    expect(row.tradeType).toBe("Scalping");
    expect(row.component).toBe("BREAKOUT_RETEST");
    expect(row.hourUtc).toBe(9);
    expect(row.holdHours).toBe(2);
    expect(row.openTime).toBe("Mon 01 Jan '24  09:00");
    expect(row.closeTime).toBe("Mon 01 Jan '24  11:00");
  });

  test("open/close times use requested IANA timezone (TradingView format)", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 102, reason: "TP",
      openTime: "2026-07-17T16:20:00Z",
      closeTime: "2026-07-17T16:45:00Z",
    }, { ...ctx, timeZone: "Asia/Jakarta" }, 0);
    expect(row.openTime).toBe("Fri 17 Jul '26  23:20");
    expect(row.closeTime).toBe("Fri 17 Jul '26  23:45");
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

  test("rejects absurd sl / tp magnitudes", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 61877.6, exit: 62000, reason: "TP",
      sl: 9703477651638930,
      tp: 4430841975420590,
      atr: 120.5,
      entryReasons: "x",
    }, ctx, 0);
    expect(row.sl).toBe("N/A");
    expect(row.tp).toBe("N/A");
    expect(row.atr).toBe(120.5);
  });

  test("component column uses winningComponent over stale trade leg", () => {
    const row = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 110, reason: "TP",
      component: "Scalping",
      winningComponent: "SMART_MONEY_CONCEPTS",
      entryReasons: "Liquidity Sweep",
    }, ctx, 0);
    expect(row.component).toBe("SMART_MONEY_CONCEPTS");
    expect(row.winningComponent).toBe("SMART_MONEY_CONCEPTS");
  });
});

describe("CORE CSV schema (Sprint 14 redesign)", () => {
  const baseTrade = {
    date: "2026-01-01", side: "LONG", entry: 100, exit: 110, pnl: 10, fee: 0.5, reason: "TP",
  };

  test("export includes Entry Reasons and omits all stale ML columns", () => {
    const csv = buildTradesCsv([{
      id: 1, symbol: "BTCUSDT", strategy_key: "BREAKOUT_RETEST",
      trades_data: [{
        ...baseTrade,
        component: "BREAKOUT_RETEST",
        entryReasons: "BB Squeeze, Range Break, Volume Spike, Retest Confirm",
      }],
    }], { includeSummary: false });
    expect(csv).toContain("Entry Reasons");
    expect(csv).toContain("Component");
    expect(csv).toContain("HTF Trend");
    expect(csv).toContain("Daily Regime");
    for (const key of DROPPED_ML_CSV_COLUMN_KEYS) {
      const labelHints = [
        "Sweep Strength", "FVG Size ATR", "BB Squeeze Width ATR", "Retest Depth ATR",
        "Conf Sweep", "Conf OB Confluence", "HTF ADX", "Hour UTC", "Hold Hours",
        "Funding Rate At Entry", "Consolidation Bars",
      ];
      for (const label of labelHints) {
        expect(csv).not.toContain(label);
      }
      expect(TRADE_EXPORT_COLUMN_KEYS).not.toContain(key);
    }
  });

  test("SMART_MONEY_CONCEPTS and BREAKOUT_RETEST share the same CORE columns", () => {
    const smc = buildTradesCsv([{
      id: 2, symbol: "BTCUSDT", strategy_key: "SMART_MONEY_CONCEPTS",
      trades_data: [{ ...baseTrade, component: "SMART_MONEY_CONCEPTS" }],
    }], { includeSummary: false });
    const br = buildTradesCsv([{
      id: 3, symbol: "BTCUSDT", strategy_key: "BREAKOUT_RETEST",
      trades_data: [{ ...baseTrade, component: "BREAKOUT_RETEST" }],
    }], { includeSummary: false });
    const smcHeader = smc.split("\n")[0];
    const brHeader = br.split("\n")[0];
    expect(smcHeader).toBe(brHeader);
    expect(smcHeader).toContain("Entry Reasons");
    expect(smcHeader).not.toContain("Sweep Strength");
    expect(brHeader).not.toContain("BB Squeeze Width ATR");
  });

  test("resolveExportColumnKeys returns CORE only (no strategy extras)", () => {
    const keys = resolveExportColumnKeys(["SMART_MONEY_CONCEPTS", "BREAKOUT_RETEST"], TRADE_EXPORT_COLUMN_KEYS);
    expect(keys).toEqual([...TRADE_EXPORT_COLUMN_KEYS]);
    expect(keys).not.toContain("sweepStrength");
    expect(keys).not.toContain("bbSqueezeWidthAtr");
    expect(strategyCsvColumnKeys("BREAKOUT_RETEST")).toEqual([]);
    expect(strategyCsvColumnKeys("SMART_MONEY_CONCEPTS")).toEqual([]);
    expect(UNIVERSAL_CSV_COLUMN_KEYS).toContain("entryReasons");
  });

  test("CORE headers always present for any component", () => {
    const csv = buildTradesCsv([{
      id: 3, symbol: "BTCUSDT", strategy_key: "BREAKOUT_RETEST",
      trades_data: [{
        ...baseTrade,
        component: "BREAKOUT_RETEST",
        openTime: "2024-01-01T09:00:00Z",
        closeTime: "2024-01-01T11:00:00Z",
      }],
    }], { includeSummary: false });
    expect(csv).toContain("Entry Reasons");
    expect(csv).toContain("Exit Reason");
    expect(csv).toContain("Open Time");
    expect(csv).toContain("Close Time");
    expect(csv).toContain("DryRun");
    expect(csv).not.toContain("Hour UTC");
    expect(csv).not.toContain("Hold Hours");
    expect(csv).toContain("Trade Type");
    expect(csv).not.toContain("Funding Rate At Entry");
  });

  test("Core CSV (buildTradesCsv) stays compact — not Full superset", () => {
    const csv = buildTradesCsv([{
      id: 4, symbol: "BTCUSDT", strategy_key: "BREAKOUT_RETEST",
      trades_data: [{ ...baseTrade, component: "BREAKOUT_RETEST" }],
    }], { includeSummary: false });
    const headerLine = csv.split("\n")[0];
    const colCount = headerLine.split(",").length;
    expect(colCount).toBe(ADMIN_TRADE_EXPORT_COLUMNS.length);
    expect(colCount).toBe(25);
    expect(csv).not.toContain("Session ID");
    expect(csv).not.toContain("Planned R:R");
  });

  test("Full Export (exportBacktests) includes geometry + ML union columns", () => {
    const { exportBacktests, exportBacktestsXlsx } = require("../src/server/services/BacktestCsvService");
    const XLSX = require("xlsx");
    const record = {
      id: 4, symbol: "BTCUSDT", strategy_key: "BREAKOUT_RETEST",
      trades_data: [{
        ...baseTrade,
        component: "BREAKOUT_RETEST",
        sl: 95,
        tp: 110,
        openTime: "2024-01-01T09:00:00Z",
        closeTime: "2024-01-01T11:00:00Z",
      }],
    };
    const csv = exportBacktests([record], "trades");
    const headerLine = csv.split("\n").find((line) => line.startsWith("ID,"));
    expect(csv).toContain("SL");
    expect(csv).toContain("TP");
    expect(csv).toContain("Planned R:R");
    expect(csv).toContain("BB Squeeze Width ATR");
    expect(csv).not.toContain("Session ID");
    expect(csv).not.toContain("User,");
    expect(headerLine).toBeTruthy();
    expect(headerLine.split(",").length).toBe(
      FULL_EXPORT_BASE_COLUMN_COUNT + ML_FIELD_SETS.BREAKOUT_RETEST.length,
    );

    const coreXlsx = exportBacktestsXlsx([record], { adminFormat: true, coreOnly: true });
    const coreWb = XLSX.read(coreXlsx, { type: "buffer" });
    const coreHeader = XLSX.utils.sheet_to_json(coreWb.Sheets["User Export"], { header: 1 })[0];
    expect(coreHeader.length).toBe(ADMIN_TRADE_EXPORT_COLUMNS.length);
    expect(coreHeader.length).toBe(25);
    expect(coreHeader).not.toContain("Session ID");

    const stratXlsx = exportBacktestsXlsx([record], {
      adminFormat: true,
      coreOnly: false,
      strategies: ["BREAKOUT_RETEST"],
    });
    const stratWb = XLSX.read(stratXlsx, { type: "buffer" });
    expect(stratWb.SheetNames).toEqual(["BR_specific"]);
    const stratHeader = XLSX.utils.sheet_to_json(stratWb.Sheets["BR_specific"], { header: 1 })[0];
    expect(stratHeader.length).toBe(
      FULL_EXPORT_BASE_COLUMN_COUNT + ML_FIELD_SETS.BREAKOUT_RETEST.length,
    );
    expect(stratHeader).toContain("SL");
    expect(stratHeader).toContain("BB Squeeze Width ATR");
  });

  test("Strategy-specific XLSX: SMC + Wyckoff → self-contained sheets with correct column counts", () => {
    const { exportBacktestsXlsx } = require("../src/server/services/BacktestCsvService");
    const XLSX = require("xlsx");
    const { ML_FIELD_SETS } = require("#shared/csv/tradeExportCsv.js");
    const base = {
      side: "LONG", entry: 100, exit: 110, pnl: 10, fee: 0.5, reason: "TP",
      openTime: "2024-01-01T09:00:00Z", closeTime: "2024-01-01T11:00:00Z",
    };
    const records = [{
      id: 5, symbol: "BTCUSDT", strategy_key: "SMART_MONEY_CONCEPTS",
      trades_data: [
        {
          ...base,
          component: "SMART_MONEY_CONCEPTS",
          winningComponent: "SMART_MONEY_CONCEPTS",
          sweepStrength: 0.5, fvgSizeAtr: 1.2,
        },
        {
          ...base, side: "SHORT", exit: 95, pnl: -5,
          component: "WYCKOFF",
          winningComponent: "WYCKOFF",
          wyPatternType: "accumulation", wyAccumulationBars: 12,
        },
      ],
    }];
    const buf = exportBacktestsXlsx(records, { adminFormat: true, coreOnly: false });
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["SMC_specific", "Wyckoff_specific"]);
    expect(wb.SheetNames).not.toContain("User Export");

    const smcHeader = XLSX.utils.sheet_to_json(wb.Sheets["SMC_specific"], { header: 1 })[0];
    const wyHeader = XLSX.utils.sheet_to_json(wb.Sheets["Wyckoff_specific"], { header: 1 })[0];
    const smcRows = XLSX.utils.sheet_to_json(wb.Sheets["SMC_specific"]);
    expect(smcHeader.length).toBe(
      FULL_EXPORT_BASE_COLUMN_COUNT + ML_FIELD_SETS.SMART_MONEY_CONCEPTS.length,
    );
    expect(smcHeader).toContain("Sweep Strength");
    expect(smcHeader).toContain("Conf Sweep Strength");
    expect(smcHeader).toContain("SL");
    expect(smcRows[0]["Sweep Strength"]).toBe(0.5);
    expect(wyHeader.length).toBe(
      FULL_EXPORT_BASE_COLUMN_COUNT + ML_FIELD_SETS.WYCKOFF.length,
    );
  });

  test("Full CSV SMC-only batch exposes sweepStrength", () => {
    const { exportBacktests } = require("../src/server/services/BacktestCsvService");
    const csv = exportBacktests([{
      id: 6, symbol: "BTCUSDT", strategy_key: "SMART_MONEY_CONCEPTS",
      trades_data: [{
        ...baseTrade,
        component: "SMART_MONEY_CONCEPTS",
        winningComponent: "SMART_MONEY_CONCEPTS",
        sweepStrength: 0.5,
      }],
    }], "trades", { variant: "full" });
    expect(csv).toContain("Sweep Strength");
    expect(csv).toContain("0.5");
  });
});

run();
