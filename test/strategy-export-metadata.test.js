/**
 * strategy-export-metadata.test.js — Sprint 15 Strategy Export verification
 *
 * Locks all 12 strategy ML_FIELD_SETS + extract/wire paths + Dynamic ML XLSX.
 */

"use strict";

const { describe, test, expect, run } = require("./helpers/jest-lite");
const assert = require("assert");

const { mapBacktestTrade } = require("../src/modules/backtest/services/BacktestCsvService");
const {
  extractBsBrEnrichment,
  extractTsVpEnrichment,
  extractTsTfEnrichment,
  extractTsMsEnrichment,
  extractMdMrEnrichment,
  extractMdSdEnrichment,
  extractMdSaEnrichment,
  extractBsIctEnrichment,
  extractBsLsEnrichment,
  extractAfVsaEnrichment,
  extractAfWyckoffEnrichment,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");
const {
  ML_FIELD_SETS,
  projectMlFields,
  TRADE_EXPORT_COLUMNS,
  DROPPED_ML_CSV_COLUMN_KEYS,
  buildDynamicMultiSheetXlsx,
  normalizeMlStrategyKey,
} = require("#shared/csv/tradeExportCsv.js");
const {
  buildSmcEntryFeatures,
  SMC_ML_CSV_COLUMNS,
} = require("../src/core/strategy-engine/smc/smcScalpGates");
const SmartMoneyConceptsStrategy = require("../src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
const VolumeProfileStrategy = require("../src/core/strategy-engine/implementations/VolumeProfileStrategy");
const TrendFollowingStrategy = require("../src/core/strategy-engine/implementations/TrendFollowingStrategy");

const ctx = {
  backtestId: "bt-meta",
  symbol: "BTCUSDT",
  strategy: "Test",
  exchange: "binance",
  sessionId: "BT-bt-meta",
  userLabel: "Backtest",
};

const EXPECTED_COUNTS = {
  AF_SMC: 12,
  BS_BR: 11,
  TS_VP: 5,
  TS_TF: 6,
  TS_MS: 6,
  MD_MR: 7,
  MD_SD: 7,
  MD_SA: 7,
  AF_WYCKOFF: 7,
  AF_VSA: 7,
  BS_ICT: 7,
  BS_LS: 7,
};

describe("ML_FIELD_SETS contracts", () => {
  test("all 12 strategies have expected field counts", () => {
    for (const [k, n] of Object.entries(EXPECTED_COUNTS)) {
      expect(ML_FIELD_SETS[k].length).toBe(n);
    }
  });

  test("ML fields stay out of CORE TRADE_EXPORT_COLUMNS", () => {
    const core = new Set(TRADE_EXPORT_COLUMNS.map(([k]) => k));
    for (const fields of Object.values(ML_FIELD_SETS)) {
      for (const k of fields) {
        if (DROPPED_ML_CSV_COLUMN_KEYS.includes(k)) {
          expect(core.has(k)).toBe(false);
        }
      }
    }
  });
});

describe("BS_BR metadata verify (already implemented)", () => {
  test("extractBsBrEnrichment maps 8 strategy-native fields from detectSignal meta", () => {
    const enrich = extractBsBrEnrichment({
      bbSqueezeWidthAtr: 0.42,
      breakoutVolumeRatio: 1.8,
      retestDepthAtr: 0.3,
      rejectionWickPct: 0.65,
      consolidationBars: 12,
      breakoutCandleAtr: 1.1,
      bbWidth: 0.015,
      volumeRatio: 1.8,
    });
    expect(enrich.bbSqueezeWidthAtr).toBe(0.42);
    expect(enrich.breakoutVolumeRatio).toBe(1.8);
  });

  test("applyBsBrSnapshotFields wires meta onto BotEngine indicator snapshot (not N/A)", () => {
    const { applyBsBrSnapshotFields } = require("../src/shared/csv/strategyMlEnrichment");
    const snap = { volumeRatio: 0.9 };
    applyBsBrSnapshotFields(snap, {
      bbSqueezeWidthAtr: 0.42,
      breakoutVolumeRatio: 1.8,
      retestDepthAtr: 0.3,
      rejectionWickPct: 0.65,
      consolidationBars: 12,
      breakoutCandleAtr: 1.1,
      bbWidth: 0.015,
      volumeRatio: 1.8,
    });
    expect(snap.bbSqueezeWidthAtr).toBe(0.42);
    expect(snap.breakoutVolumeRatio).toBe(1.8);
    expect(snap.retestDepthAtr).toBe(0.3);
    expect(snap.rejectionWickPct).toBe(0.65);
    expect(snap.consolidationBars).toBe(12);
    expect(snap.breakoutCandleAtr).toBe(1.1);
    expect(snap.bbWidth).toBe(0.015);
    expect(snap.volumeRatio).toBe(1.8);
    // BotEngine source must call the helper (live trade.indicators path)
    const fs = require("fs");
    const path = require("path");
    const beSrc = fs.readFileSync(
      path.join(__dirname, "../src/modules/trading/application/BotEngine.js"),
      "utf8"
    );
    assert.ok(beSrc.includes("applyBsBrSnapshotFields"), "BotEngine must call applyBsBrSnapshotFields");
  });

  test("mapBacktestTrade + projectMlFields expose all 11 BS_BR ML columns", () => {
    const row = mapBacktestTrade({
      side: "LONG",
      entry: 100,
      exit: 102,
      reason: "TP",
      strategyKey: "BS_BR",
      component: "BS_BR",
      openTime: "2024-01-01T08:00:00Z",
      closeTime: "2024-01-01T12:00:00Z",
      bbSqueezeWidthAtr: 0.4,
      breakoutVolumeRatio: 1.5,
      retestDepthAtr: 0.2,
      rejectionWickPct: 0.55,
      consolidationBars: 8,
      breakoutCandleAtr: 0.9,
      fundingRateAtEntry: 0.0001,
      fundingForecast24h: 0.0003,
      volumeRatio: 1.5,
      bbWidth: 0.012,
    }, { ...ctx, strategy: "Breakout Trading" }, 0);

    for (const k of ML_FIELD_SETS.BS_BR) {
      assert.ok(k in row, `missing BS_BR field on CSV row: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `BS_BR ${k} should be populated`);
    }
    expect(row.holdHours).toBe(4);
    const ml = projectMlFields(row, "BS_BR");
    expect(Object.keys(ml).sort()).toEqual([...ML_FIELD_SETS.BS_BR].sort());
  });
});

describe("AF_SMC metadata verify (already implemented)", () => {
  test("getLastSequenceMeta returns null before first detect", () => {
    const smc = new SmartMoneyConceptsStrategy();
    expect(smc.getLastSequenceMeta()).toBeNull();
  });

  test("buildSmcEntryFeatures returns 12 AF_SMC ML keys (+ shared funding/vol)", () => {
    const n = 30;
    const closes = Array.from({ length: n }, (_, i) => 100 + Math.sin(i / 3));
    const feats = buildSmcEntryFeatures(
      {
        closes,
        highs: closes.map((c) => c + 1),
        lows: closes.map((c) => c - 1),
        volumes: closes.map(() => 150),
        volSMA: closes.map(() => 100),
        atr: closes.map(() => 2),
      },
      n - 1,
      {
        sweepIdx: n - 8,
        dispIdx: n - 4,
        fvg: { size: 0.01, top: 101, bottom: 100 },
        obConfluence: true,
        confidenceComponents: {
          sweepStrength: 1.5,
          fvgSize: 0.01,
          displacementPct: 0.8,
          htfAlignment: 10,
          mitigationDepth: 0.4,
          obConfluence: true,
        },
      },
      { atr: 2, price: closes[n - 1], timestamp: Date.UTC(2026, 6, 13, 14, 0, 0), fundingRate: 0.0002 },
    );
    for (const k of ML_FIELD_SETS.AF_SMC) {
      assert.ok(k in feats || k === "hourUtc", `feature key ${k}`);
    }
    expect(feats.hourUtc).toBe(14);
  });

  test("mapBacktestTrade + projectMlFields expose all 12 AF_SMC ML columns", () => {
    const row = mapBacktestTrade({
      side: "LONG",
      entry: 100,
      exit: 101,
      reason: "TP",
      strategyKey: "AF_SMC",
      winningComponent: "AF_SMC",
      openTime: "2024-06-01T10:00:00Z",
      closeTime: "2024-06-01T11:00:00Z",
      sweepStrength: 1.2,
      fvgSizeAtr: 0.5,
      obDistanceAtr: 0.1,
      displacementPct: 1.4,
      htfAdx: 28,
      confSweepStrength: 1.2,
      confFvgSize: 0.5,
      confDisplacementPct: 1.4,
      confHtfAlignment: 8,
      confMitigationDepth: 0.3,
      confObConfluence: true,
    }, { ...ctx, strategy: "Smart Money Concepts" }, 0);

    for (const k of ML_FIELD_SETS.AF_SMC) {
      assert.ok(k in row, `missing AF_SMC field on CSV row: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `AF_SMC ${k} should be populated`);
    }
    expect(row.hourUtc).toBe(10);
  });

  test("SMC_ML_CSV_COLUMNS covers AF_SMC forensic keys used by expand scripts", () => {
    const smcKeys = new Set(SMC_ML_CSV_COLUMNS.map(([k]) => k));
    for (const k of ML_FIELD_SETS.AF_SMC) {
      assert.ok(smcKeys.has(k), `SMC_ML_CSV_COLUMNS missing ${k}`);
    }
  });
});

describe("TS_VP extract & wire metadata", () => {
  test("extractTsVpEnrichment flattens nested meta + triggerType", () => {
    const enrich = extractTsVpEnrichment({
      reason: "val_bounce",
      meta: { vwap: 100.5, vah: 102, val: 99, poc: 100.2 },
    });
    expect(enrich.vpVwapLevel).toBe(100.5);
    expect(enrich.vpTriggerType).toBe("VAL_BOUNCE");
  });

  test("detectSignal populates flat vp* on getLastSignalMeta when signal fires", () => {
    const strat = new VolumeProfileStrategy();
    const n = 80;
    const base = 100;
    const timestamps = [];
    const opens = [];
    const highs = [];
    const lows = [];
    const closes = [];
    const volumes = [];
    const dayStart = Date.UTC(2026, 0, 15, 0, 0, 0);
    for (let i = 0; i < n; i++) {
      timestamps.push(dayStart + i * 5 * 60 * 1000);
      const px = base + (i < n - 2 ? -0.5 : i === n - 2 ? -0.3 : 0.4);
      opens.push(px - 0.05);
      highs.push(px + 0.2);
      lows.push(px - 0.2);
      closes.push(px);
      volumes.push(1000 + i);
    }
    const indicators = {
      opens, highs, lows, closes, volumes, timestamps,
      atr: closes.map(() => 0.5),
    };
    const sig = strat.detectSignal(indicators, n - 1, {});
    const meta = strat.getLastSignalMeta();
    expect(meta).toBeDefined();
    expect(meta.component).toBe("TS_VP");
    for (const k of ML_FIELD_SETS.TS_VP) {
      assert.ok(k in meta, `getLastSignalMeta missing ${k}`);
    }
    if (sig) {
      expect(meta.winningComponent).toBe("TS_VP");
      expect(meta.vpTriggerType).toBeTruthy();
    }
  });

  test("mapBacktestTrade + projectMlFields expose all 5 TS_VP columns", () => {
    const row = mapBacktestTrade({
      side: "LONG",
      entry: 100,
      exit: 101,
      reason: "TP",
      strategyKey: "TS_VP",
      winningComponent: "TS_VP",
      vpVwapLevel: 100.1,
      vpVahLevel: 101.5,
      vpValLevel: 99.2,
      vpPocLevel: 100.0,
      vpTriggerType: "VWAP_RECLAIM",
    }, { ...ctx, strategy: "Auction Market Theory" }, 0);

    for (const k of ML_FIELD_SETS.TS_VP) {
      assert.ok(k in row, `missing TS_VP field: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `TS_VP ${k} should be populated`);
    }
  });
});

describe("TS_TF extract & wire metadata", () => {
  test("getLastSignalMeta returns 6 tf* fields", () => {
    const strat = new TrendFollowingStrategy();
    const meta = strat.getLastSignalMeta();
    for (const k of ML_FIELD_SETS.TS_TF) {
      assert.ok(k in meta, `missing ${k}`);
    }
    expect(meta.winningComponent).toBe("TS_TF");
  });

  test("extractTsTfEnrichment + projectMlFields", () => {
    const enrich = extractTsTfEnrichment({
      adxStrength: 32,
      donchianPeriod: 20,
      barsInTrend: 12,
      htfTrendConfirmed: true,
      entryChecklist: { volRatio: 1.4, ema9Retest: true },
    });
    expect(enrich.tfAdxStrength).toBe(32);
    expect(enrich.tfVolRatio).toBe(1.4);
    expect(enrich.tfEmaCrossover).toBe(true);

    const row = mapBacktestTrade({
      side: "LONG", entry: 100, exit: 101, reason: "TP",
      winningComponent: "TS_TF",
      ...enrich,
    }, { ...ctx, strategy: "Trend Following" }, 0);
    for (const k of ML_FIELD_SETS.TS_TF) {
      assert.notStrictEqual(row[k], "N/A", k);
    }
  });
});

describe("TS_MS / MD_* / BS_* / AF_* extract helpers", () => {
  test("TS_MS extract", () => {
    const e = extractTsMsEnrichment({
      signal: "LONG",
      winningComponent: "TS_MS",
      reason: "dow_hl_pullback_bounce",
      atr: 2,
      meta: {
        hh: 2, ll: 0, structure: "uptrend",
        lastSwingHigh: { price: 110 },
        lastSwingLow: { price: 100 },
        dist: 1.0,
      },
    });
    expect(e.msSwingHighPrice).toBe(110);
    expect(e.msSwingLowPrice).toBe(100);
    expect(e.msPullbackDepthAtr).toBe(0.5);
    expect(e.msHhPattern).toBe(true);
    expect(e.msPullbackConfirmed).toBe(true);
  });

  test("MD_MR extract", () => {
    const e = extractMdMrEnrichment({
      mrRsiValue: 28,
      mrBbMidLevel: 100,
      mrBbUpperLevel: 102,
      mrBbLowerLevel: 98,
      mrVwapLevel: 99.5,
      mrVwapDeviation: -0.5,
      mrAdxRegime: "BALANCE",
    });
    expect(e.mrRsiValue).toBe(28);
    expect(e.mrAdxRegime).toBe("BALANCE");
  });

  test("MD_SD extract", () => {
    const e = extractMdSdEnrichment({
      zoneType: "demand_ob",
      nearestZone: { low: 98, high: 100, zoneKind: "demand_ob", barsSince: 5 },
      hasVolConfirm: true,
      atr: 1,
      price: 99,
    });
    expect(e.sdZoneType).toBe("DEMAND");
    expect(e.sdZoneLevel).toBe(99);
    expect(e.sdZoneSizeAtr).toBe(2);
    expect(e.sdVolumeConfirmation).toBe(true);
    expect(e.sdConfluence).toBe(true);
  });

  test("MD_SA extract", () => {
    const e = extractMdSaEnrichment({
      zScore: -2.5,
      mean: 100,
      std: 2,
      upperBand: 104,
      lowerBand: 96,
    });
    expect(e.saZScore).toBe(-2.5);
    expect(e.saBandTouch).toBe("LOWER");
    expect(e.saMaValue).toBe(100);
  });

  test("BS_ICT extract", () => {
    const e = extractBsIctEnrichment({
      reason: "ict_raid_low_reversal_london",
      killZone: { minuteOfDay: 8 * 60, active: true },
      raid: { detected: true, direction: "LONG", level: 95, volOk: true },
      winningComponent: "BS_ICT",
    });
    expect(e.ictKillZoneHour).toBe(8);
    expect(e.ictRaidType).toBe("RAID_LOW");
    expect(e.ictReversal).toBe(true);
  });

  test("BS_LS extract", () => {
    const e = extractBsLsEnrichment({
      oiChange: 1.5,
      wick: { level: 101, depthAtr: 0.8 },
      bbWidth: 0.02,
    });
    expect(e.lsOiForecast24h).toBe(1.5);
    expect(e.lsLiquidationLevel).toBe(101);
    expect(e.lsWickDepthAtr).toBe(0.8);
  });

  test("AF_VSA extract", () => {
    const e = extractAfVsaEnrichment({
      reason: "vsa_stopping_volume_low",
      meta: {
        spreadType: { spread: 12 },
        nearSwing: { distancePct: 0.3 },
        volume: 5000,
      },
    });
    expect(e.vsaPatternType).toBe("STOPPING_VOLUME");
    expect(e.vsaReversal).toBe(true);
    expect(e.vsaSpread).toBe(12);
  });

  test("AF_WYCKOFF extract", () => {
    const e = extractAfWyckoffEnrichment({
      reason: "wyckoff_spring_reclaim",
      meta: {
        spring: { detected: true, depthAtr: 0.4, reclaimBars: 3, volRatio: 1.8 },
        range: { bars: 40, rangeStartIdx: 10, rangeEndIdx: 50, rangeLow: 90 },
        entry: { checklist: { sosOrSow: true }, lpsLevel: 92 },
      },
    });
    expect(e.wyPatternType).toBe("SPRING");
    expect(e.wyAccumulationBars).toBe(40);
    expect(e.wySosOrSow).toBe("SOS");
    expect(e.wyLpsLevel).toBe(92);
  });
});

describe("Dynamic ML multi-sheet XLSX", () => {
  function mkTrade(component, extra = {}) {
    return mapBacktestTrade({
      side: "LONG",
      entry: 100,
      exit: 101,
      reason: "TP",
      winningComponent: component,
      component,
      openTime: "2024-01-01T00:00:00Z",
      closeTime: "2024-01-01T01:00:00Z",
      ...extra,
    }, { ...ctx, strategy: component }, 0);
  }

  test("single strategy → 2 sheets (User Export + ML_*)", () => {
    const XLSX = require("xlsx");
    const trades = [
      mkTrade("TS_TF", {
        tfAdxStrength: 30, tfDonchianPeriod: 20, tfBarsInTrend: 5,
        tfVolRatio: 1.2, tfHtfTrendConfirmed: true, tfEmaCrossover: true,
      }),
    ];
    const buf = buildDynamicMultiSheetXlsx(trades, ["TS_TF"]);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames).toEqual(["User Export", "ML_TS_TF"]);
  });

  test("subset TS_TF + MD_MR → 3 sheets", () => {
    const XLSX = require("xlsx");
    const trades = [
      mkTrade("TS_TF", {
        tfAdxStrength: 30, tfDonchianPeriod: 20, tfBarsInTrend: 5,
        tfVolRatio: 1.2, tfHtfTrendConfirmed: true, tfEmaCrossover: false,
      }),
      mkTrade("MD_MR", {
        mrRsiValue: 25, mrBbMidLevel: 100, mrBbUpperLevel: 102, mrBbLowerLevel: 98,
        mrVwapLevel: 99, mrVwapDeviation: -1, mrAdxRegime: "BALANCE",
      }),
    ];
    const buf = buildDynamicMultiSheetXlsx(trades, ["TS_TF", "MD_MR"]);
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames.length).toBe(3);
    expect(wb.SheetNames).toContain("User Export");
    expect(wb.SheetNames).toContain("ML_TS_TF");
    expect(wb.SheetNames).toContain("ML_MD_MR");
  });

  test("skips empty strategy sheets; aliases normalize", () => {
    expect(normalizeMlStrategyKey("TREND_FOLLOWING")).toBe("TS_TF");
    expect(normalizeMlStrategyKey("MEAN_REVERSION")).toBe("MD_MR");
    const XLSX = require("xlsx");
    const trades = [mkTrade("AF_SMC", { sweepStrength: 1, fvgSizeAtr: 0.2, obDistanceAtr: 0.1, displacementPct: 1, htfAdx: 25, confSweepStrength: 1, confFvgSize: 0.2, confDisplacementPct: 1, confHtfAlignment: 5, confMitigationDepth: 0.2, confObConfluence: false })];
    const buf = buildDynamicMultiSheetXlsx(trades, ["AF_SMC", "TS_TF"]);
    const wb = XLSX.read(buf, { type: "buffer" });
    // TS_TF has no trades → skipped
    expect(wb.SheetNames).toEqual(["User Export", "ML_AF_SMC"]);
  });

  test("all 12 strategies with one trade each → 13 sheets", () => {
    const XLSX = require("xlsx");
    const samples = {
      AF_SMC: { sweepStrength: 1, fvgSizeAtr: 0.2, obDistanceAtr: 0.1, displacementPct: 1, htfAdx: 25, confSweepStrength: 1, confFvgSize: 0.2, confDisplacementPct: 1, confHtfAlignment: 5, confMitigationDepth: 0.2, confObConfluence: true },
      BS_BR: { bbSqueezeWidthAtr: 0.4, breakoutVolumeRatio: 1.5, retestDepthAtr: 0.2, rejectionWickPct: 0.5, consolidationBars: 8, breakoutCandleAtr: 0.9, fundingRateAtEntry: 0.0001, fundingForecast24h: 0.0002, volumeRatio: 1.5, bbWidth: 0.01 },
      TS_TF: { tfAdxStrength: 30, tfDonchianPeriod: 20, tfBarsInTrend: 5, tfVolRatio: 1.2, tfHtfTrendConfirmed: true, tfEmaCrossover: true },
      TS_MS: { msSwingHighPrice: 110, msSwingLowPrice: 100, msPullbackDepthAtr: 0.5, msHhPattern: true, msLlPattern: false, msPullbackConfirmed: true },
      TS_VP: { vpVwapLevel: 100, vpVahLevel: 101, vpValLevel: 99, vpPocLevel: 100, vpTriggerType: "VWAP_RECLAIM" },
      MD_MR: { mrRsiValue: 25, mrBbMidLevel: 100, mrBbUpperLevel: 102, mrBbLowerLevel: 98, mrVwapLevel: 99, mrVwapDeviation: -1, mrAdxRegime: "BALANCE" },
      MD_SD: { sdZoneType: "DEMAND", sdZoneLevel: 99, sdZoneSizeAtr: 1, sdRetestDepthAtr: 0.2, sdVolumeConfirmation: true, sdTimeToRetestBars: 3, sdConfluence: true },
      MD_SA: { saZScore: -2.5, saMaValue: 100, saStdDev: 2, saUpperBand: 104, saLowerBand: 96, saBandTouch: "LOWER", saMeanRevertBars: 4 },
      AF_WYCKOFF: { wyPatternType: "SPRING", wyAccumulationBars: 40, wyFakeBreakDepthAtr: 0.4, wyReclameBars: 3, wyVolumeRatio: 1.8, wySosOrSow: "SOS", wyLpsLevel: 92 },
      AF_VSA: { vsaPatternType: "STOPPING_VOLUME", vsaSpread: 12, vsaVolume: 5000, vsaAvgSpread: 8, vsaAvgVolume: 3000, vsaSwingProximity: 0.3, vsaReversal: true },
      BS_ICT: { ictKillZoneHour: 8, ictKillZoneLevel: 95, ictRaidType: "RAID_LOW", ictRaidDepthAtr: 0.5, ictVolumeRatio: 1.2, ictReversal: true, ictMssPct: 0.4 },
      BS_LS: { lsOiValue: 1e6, lsOiPercentile: 95, lsBbWidth: 0.02, lsBbWidthPercentile: 10, lsLiquidationLevel: 101, lsWickDepthAtr: 0.8, lsOiForecast24h: 1.5 },
    };
    const trades = Object.entries(samples).map(([k, extra]) => mkTrade(k, extra));
    const t0 = Date.now();
    const buf = buildDynamicMultiSheetXlsx(trades, Object.keys(samples));
    const elapsed = Date.now() - t0;
    const wb = XLSX.read(buf, { type: "buffer" });
    expect(wb.SheetNames.length).toBe(13);
    expect(wb.SheetNames[0]).toBe("User Export");
    expect(buf.length).toBeLessThan(20 * 1024 * 1024);
    expect(elapsed).toBeLessThan(5000);
  });
});

run("Strategy Export Metadata");
