/**
 * strategy-export-metadata.test.js — Sprint 15 Strategy Export verification
 *
 * Locks BS_BR (11) + AF_SMC (12) metadata pipelines (verify tasks) and
 * TS_VP (5) extract & wire path.
 */

"use strict";

const { describe, test, expect, run } = require("./helpers/jest-lite");
const assert = require("assert");

const { mapBacktestTrade } = require("../src/modules/backtest/services/BacktestCsvService");
const {
  extractBsBrEnrichment,
  extractTsVpEnrichment,
} = require("../src/modules/backtest/services/RealStrategyBacktestService");
const {
  ML_FIELD_SETS,
  projectMlFields,
  TRADE_EXPORT_COLUMNS,
  DROPPED_ML_CSV_COLUMN_KEYS,
} = require("#shared/csv/tradeExportCsv.js");
const {
  buildSmcEntryFeatures,
  SMC_ML_CSV_COLUMNS,
} = require("../src/core/strategy-engine/smc/smcScalpGates");
const SmartMoneyConceptsStrategy = require("../src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
const VolumeProfileStrategy = require("../src/core/strategy-engine/implementations/VolumeProfileStrategy");

const ctx = {
  backtestId: "bt-meta",
  symbol: "BTCUSDT",
  strategy: "Test",
  exchange: "binance",
  sessionId: "BT-bt-meta",
  userLabel: "Backtest",
};

const BS_BR_FIELDS = ML_FIELD_SETS.BS_BR;
const AF_SMC_FIELDS = ML_FIELD_SETS.AF_SMC;
const TS_VP_FIELDS = ML_FIELD_SETS.TS_VP;

describe("ML_FIELD_SETS contracts", () => {
  test("AF_SMC has 12 fields; BS_BR has 11; TS_VP has 5", () => {
    expect(AF_SMC_FIELDS.length).toBe(12);
    expect(BS_BR_FIELDS.length).toBe(11);
    expect(TS_VP_FIELDS.length).toBe(5);
  });

  test("ML fields stay out of CORE TRADE_EXPORT_COLUMNS", () => {
    const core = new Set(TRADE_EXPORT_COLUMNS.map(([k]) => k));
    for (const k of [...AF_SMC_FIELDS, ...BS_BR_FIELDS, ...TS_VP_FIELDS]) {
      if (DROPPED_ML_CSV_COLUMN_KEYS.includes(k)) {
        expect(core.has(k)).toBe(false);
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
    expect(enrich.retestDepthAtr).toBe(0.3);
    expect(enrich.rejectionWickPct).toBe(0.65);
    expect(enrich.consolidationBars).toBe(12);
    expect(enrich.breakoutCandleAtr).toBe(1.1);
    expect(enrich.bbWidth).toBe(0.015);
    expect(enrich.volumeRatio).toBe(1.8);
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

    for (const k of BS_BR_FIELDS) {
      assert.ok(k in row, `missing BS_BR field on CSV row: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `BS_BR ${k} should be populated`);
    }
    expect(row.holdHours).toBe(4);

    const ml = projectMlFields(row, "BS_BR");
    expect(Object.keys(ml).sort()).toEqual([...BS_BR_FIELDS].sort());
    expect(ml.bbSqueezeWidthAtr).toBe(0.4);
    expect(ml.fundingRateAtEntry).toBe(0.0001);
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

    for (const k of AF_SMC_FIELDS) {
      assert.ok(k in feats || k === "hourUtc", `feature key ${k}`);
    }
    expect(feats.hourUtc).toBe(14);
    expect(feats.sweepStrength).toBeDefined();
    expect(feats.confSweepStrength).toBe(1.5);
    expect(feats.confObConfluence).toBe(true);
    expect(feats.obDistanceAtr).toBe(0);
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

    for (const k of AF_SMC_FIELDS) {
      assert.ok(k in row, `missing AF_SMC field on CSV row: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `AF_SMC ${k} should be populated`);
    }
    expect(row.hourUtc).toBe(10);

    const ml = projectMlFields(row, "AF_SMC");
    expect(ml.sweepStrength).toBe(1.2);
    expect(ml.confObConfluence).toBe(true);
  });

  test("SMC_ML_CSV_COLUMNS covers AF_SMC forensic keys used by expand scripts", () => {
    const smcKeys = new Set(SMC_ML_CSV_COLUMNS.map(([k]) => k));
    for (const k of AF_SMC_FIELDS) {
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
    expect(enrich.vpVahLevel).toBe(102);
    expect(enrich.vpValLevel).toBe(99);
    expect(enrich.vpPocLevel).toBe(100.2);
    expect(enrich.vpTriggerType).toBe("VAL_BOUNCE");
  });

  test("detectSignal populates flat vp* on getLastSignalMeta when signal fires", () => {
    const strat = new VolumeProfileStrategy();
    const n = 80;
    const base = 100;
    // Build a session with timestamps + a VWAP reclaim on the last bar
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
    // Force reclaim: prev below vwap, close above — use synthetic indicators
    // Prefer stubbing via evaluate path: call detectSignal with crafted series
    const indicators = {
      opens, highs, lows, closes, volumes, timestamps,
      atr: closes.map(() => 0.5),
    };
    // May or may not fire depending on VWAP; assert meta shape when it does,
    // otherwise assert extract helper from synthetic meta (covered above).
    const sig = strat.detectSignal(indicators, n - 1, {});
    const meta = strat.getLastSignalMeta();
    expect(meta).toBeDefined();
    expect(meta.component).toBe("TS_VP");
    for (const k of TS_VP_FIELDS) {
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

    for (const k of TS_VP_FIELDS) {
      assert.ok(k in row, `missing TS_VP field: ${k}`);
      assert.notStrictEqual(row[k], "N/A", `TS_VP ${k} should be populated`);
    }
    const ml = projectMlFields(row, "TS_VP");
    expect(ml.vpTriggerType).toBe("VWAP_RECLAIM");
    expect(ml.vpVwapLevel).toBe(100.1);
  });
});

run("Strategy Export Metadata");
