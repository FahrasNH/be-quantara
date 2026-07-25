/**
 * smc-scalp-gates.test.js — Sprint 13 Scalping gates + confidence/CSV helpers
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  applySmcSessionFilter,
  applySmcSideRegimeGate,
  resolveScalpingGateFlags,
  buildSmcEntryFeatures,
  SMC_ML_CSV_COLUMNS,
} = require("#core/strategy-engine/af/smcEntry.js");
const { applyRegimeGate } = require("#core/signal-engine/dailyRegimeGate.js");
const SmartMoneyConceptsStrategy = require("../src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
const { TRADE_EXPORT_COLUMNS } = require("#shared/csv/tradeExportCsv.js");

test("GATE-SESSION: blocks Sydney and Tokyo hours when noTradeSessions set", () => {
  const tsTokyo = Date.UTC(2026, 6, 13, 3, 30, 0); // hour 3 UTC — Sydney+Tokyo
  const tsLondon = Date.UTC(2026, 6, 13, 14, 0, 0);

  const blocked = applySmcSessionFilter(tsTokyo, {
    enabled: true,
    noTradeSessions: ["Sydney", "Tokyo"],
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.hourUtc, 3);

  const open = applySmcSessionFilter(tsLondon, {
    enabled: true,
    noTradeSessions: ["Sydney", "Tokyo"],
  });
  assert.equal(open.blocked, false);
  assert.equal(open.hourUtc, 14);
});

test("GATE-SESSION: blocks 21–22 UTC when enabled, fail-open when off", () => {
  const ts21 = Date.UTC(2026, 6, 13, 21, 30, 0);
  const ts14 = Date.UTC(2026, 6, 13, 14, 0, 0);

  const blocked = applySmcSessionFilter(ts21, { enabled: true });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.hourUtc, 21);

  const open = applySmcSessionFilter(ts14, { enabled: true });
  assert.equal(open.blocked, false);

  const off = applySmcSessionFilter(ts21, { enabled: false });
  assert.equal(off.blocked, false);

  // hour 23 is outside [21,23) default block list
  const ts23 = Date.UTC(2026, 6, 13, 23, 0, 0);
  assert.equal(applySmcSessionFilter(ts23, { enabled: true }).blocked, false);
});

test("GATE-SESSION: symmetric — same hours block regardless of side (filter is time-only)", () => {
  const ts = Date.UTC(2026, 6, 13, 22, 15, 0);
  const r = applySmcSessionFilter(ts, { enabled: true, blockHoursUtc: [21, 22] });
  assert.equal(r.blocked, true);
  assert.equal(r.hourUtc, 22);
});

test("GATE-CHOP-ALL: blocks both LONG and SHORT in CHOP when blockAllInChop", () => {
  const long = applySmcSideRegimeGate({
    signal: "LONG",
    dailyRegime: "CHOP",
    enabled: true,
    blockAllInChop: true,
  });
  assert.equal(long.allow, false);
  assert.equal(long.reason, "chop_all_blocked");

  const short = applySmcSideRegimeGate({
    signal: "SHORT",
    dailyRegime: "CHOP",
    enabled: true,
    blockAllInChop: true,
  });
  assert.equal(short.allow, false);
  assert.equal(short.reason, "chop_all_blocked");
});

test("GATE-CHOP-ALL: applyRegimeGate blockAllInChop for SMART_MONEY_CONCEPTS", () => {
  const blocked = applyRegimeGate({
    signal: "SHORT",
    strategyKey: "SMART_MONEY_CONCEPTS",
    regime: "CHOP",
    riskPerTrade: 0.01,
    blockAllInChop: true,
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.reason, "chop_all_blocked");
});

test("GATE-SESSION-INTRADAY: blocks London hours for Intraday preset", () => {
  const tsLondon = Date.UTC(2026, 6, 13, 14, 0, 0);
  const tsNy = Date.UTC(2026, 6, 13, 18, 0, 0);

  const blocked = applySmcSessionFilter(tsLondon, {
    enabled: true,
    noTradeSessions: ["London"],
  });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.hourUtc, 14);

  const open = applySmcSessionFilter(tsNy, {
    enabled: true,
    noTradeSessions: ["London"],
  });
  assert.equal(open.blocked, false);
});

test("GATE-FLAGS: resolveIntradayGateFlags reads typeOverrides", () => {
  const { resolveIntradayGateFlags } = require("#core/strategy-engine/af/smcEntry.js");
  const flags = resolveIntradayGateFlags({
    typeOverrides: {
      Intraday: {
        smcSessionFilter: true,
        smcBlockAllInChop: true,
        smcPivotStructure: true,
        noTradeSessions: ["London"],
        maxHoldHours: 6,
      },
    },
  });
  assert.equal(flags.smcSessionFilter, true);
  assert.equal(flags.smcBlockAllInChop, true);
  assert.equal(flags.smcPivotStructure, true);
  assert.deepEqual(flags.noTradeSessions, ["London"]);
  assert.equal(flags.maxHoldHours, 6);
});

test("INTRADAY-SSOT: strategyDefaults Intraday has Sprint 22 gates + geometry", () => {
  const { STRATEGIES } = require("#config/strategyDefaults.js");
  const ov = STRATEGIES.SMART_MONEY_CONCEPTS.typeOverrides.Intraday;
  assert.equal(ov.smcMinConfidenceIntraday, 80);
  assert.equal(ov.smcPivotStructure, true);
  assert.equal(ov.smcBlockAllInChop, true);
  assert.equal(ov.smcSessionFilter, false);
  assert.equal(ov.noTradeSessions, undefined);
  assert.equal(ov.slAtrMult, 1.8);
  assert.equal(ov.tpAtrMult, 3.6);
  assert.equal(ov.smcSweepVolMult, undefined);
});

test("SWING-SSOT: strategyDefaults Swing has explicit geometry", () => {
  const { STRATEGIES } = require("#config/strategyDefaults.js");
  const ov = STRATEGIES.SMART_MONEY_CONCEPTS.typeOverrides.Swing;
  assert.equal(ov.slAtrMult, 1.2);
  assert.equal(ov.tpAtrMult, 3.6);
});

test("GATE-CHOP-LONG: blocks LONG in CHOP, allows SHORT", () => {
  const long = applySmcSideRegimeGate({ signal: "LONG", dailyRegime: "CHOP", enabled: true });
  assert.equal(long.allow, false);
  assert.equal(long.reason, "chop_long_blocked");

  const short = applySmcSideRegimeGate({ signal: "SHORT", dailyRegime: "CHOP", enabled: true });
  assert.equal(short.allow, true);

  const longOff = applySmcSideRegimeGate({ signal: "LONG", dailyRegime: "CHOP", enabled: false });
  assert.equal(longOff.allow, true);

  const longTrend = applySmcSideRegimeGate({ signal: "LONG", dailyRegime: "STRONG_TREND", enabled: true });
  assert.equal(longTrend.allow, true);
});

test("GATE-CHOP-LONG: applyRegimeGate blockLongInChop for SMART_MONEY_CONCEPTS", () => {
  const blocked = applyRegimeGate({
    signal: "LONG",
    strategyKey: "SMART_MONEY_CONCEPTS",
    regime: "CHOP",
    riskPerTrade: 0.01,
    blockLongInChop: true,
  });
  assert.equal(blocked.allow, false);

  const shortOk = applyRegimeGate({
    signal: "SHORT",
    strategyKey: "SMART_MONEY_CONCEPTS",
    regime: "CHOP",
    riskPerTrade: 0.01,
    blockLongInChop: true,
  });
  assert.equal(shortOk.allow, true);
  assert.ok(shortOk.riskPerTrade < 0.01); // half size still

  const legacy = applyRegimeGate({
    signal: "LONG",
    strategyKey: "SMART_MONEY_CONCEPTS",
    regime: "CHOP",
    riskPerTrade: 0.01,
  });
  assert.equal(legacy.allow, true); // fail-open when flag unset
});

test("GATE-FLAGS: resolveScalpingGateFlags reads typeOverrides", () => {
  const flags = resolveScalpingGateFlags({
    typeOverrides: {
      Scalping: {
        smcSessionFilter: true,
        smcBlockLongInChop: true,
        smcRequireObRetest: true,
        maxHoldHours: 6,
      },
    },
  });
  assert.equal(flags.smcSessionFilter, true);
  assert.equal(flags.smcBlockLongInChop, true);
  assert.equal(flags.smcRequireObRetest, true);
  assert.equal(flags.maxHoldHours, 6);
});

test("SCALP-SSOT: strategyDefaults Scalping has RR 2.0 + gates on (TIME_STOP OFF)", () => {
  const { STRATEGIES } = require("#config/strategyDefaults.js");
  const ov = STRATEGIES.SMART_MONEY_CONCEPTS.typeOverrides.Scalping;
  assert.equal(ov.slAtrMult, 1.5);
  assert.equal(ov.tpAtrMult, 3.0);
  assert.equal(ov.maxHoldHours, undefined);
  assert.equal(ov.smcSessionFilter, false);
  assert.equal(ov.smcBlockLongInChop, true);
  assert.equal(ov.smcRequireObRetest, true);
  assert.equal(ov.smcMinConfidenceScalping, 40);
  assert.equal(ov.smcSweepVolMult, 1.2);
  assert.equal(ov.noTradeSessions, undefined);
  assert.equal(ov.atrMinMult, 0.287);

  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.SUB_STRATEGIES.Scalping.slMultiplier, 1.5);
  assert.equal(smc.SUB_STRATEGIES.Scalping.tpMultiplier, 3.0);
  const cfg = smc.calculateRiskConfig(100, 1, "LONG", "Scalping");
  assert.equal(cfg.riskReward, 2.0);

  // typeOverrides path used by backtest / BotEngine
  const ovCfg = smc.calculateRiskConfig(100, 1, "LONG", "Scalping", {
    slMultiplier: ov.slAtrMult,
    tpMultiplier: ov.tpAtrMult,
  });
  assert.equal(ovCfg.riskReward, 2.0);
});

test("CONF-META: _scoreSequence returns components for CSV forensics", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const n = 40;
  const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.01);
  const highs = closes.map((c) => c + 0.5);
  const lows = closes.map((c) => c - 0.5);
  const volumes = closes.map(() => 200);
  const ind = {
    closes, highs, lows, volumes,
    volSMA: closes.map(() => 100),
  };
  const scored = smc._scoreSequence(ind, n - 1, {
    isLong: true,
    fvg: { size: 0.002, midpoint: 100.2, bottom: 100, top: 100.4 },
    dispIdx: n - 5,
    chochIdx: n - 10,
    sweepIdx: n - 15,
    config: { smcScoreAtrNorm: true },
    obConfluence: true,
  });
  assert.equal(typeof scored.score, "number");
  assert.ok(scored.components);
  assert.ok("sweepStrength" in scored.components);
  assert.ok("fvgSize" in scored.components);
  assert.ok("displacementPct" in scored.components);
  assert.ok("htfAlignment" in scored.components);
  assert.equal(scored.components.obConfluence, true);
});

test("CSV-COLS: Sprint 13 ML columns live in SMC_ML_CSV_COLUMNS, not TRADE_EXPORT_COLUMNS", () => {
  const keys = new Set(TRADE_EXPORT_COLUMNS.map(([k]) => k));
  assert.ok(keys.has("entryReasons"), "CORE must include entryReasons");
  assert.ok(keys.has("atr"), "CORE must include atr");
  for (const [k] of SMC_ML_CSV_COLUMNS) {
    assert.ok(!keys.has(k), `stale ML column ${k} must not be in TRADE_EXPORT_COLUMNS`);
  }
});

test("FEATURES: buildSmcEntryFeatures returns expected keys", () => {
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
      chochIdx: n - 6,
      fvg: { size: 0.01, top: 101, bottom: 100 },
      obConfluence: true,
      confidenceComponents: {
        sweepStrength: 1.5,
        fvgSize: 0.01,
        displacementPct: 0.8,
        htfAlignment: 10,
      },
    },
    { atr: 2, price: closes[n - 1], timestamp: Date.UTC(2026, 6, 13, 10, 0, 0) },
  );
  assert.equal(feats.hourUtc, 10);
  assert.ok(feats.sweepStrength != null);
  assert.ok(feats.volumeRatio != null);
  assert.equal(feats.confHtfAlignment, 10);
  assert.equal(feats.obDistanceAtr, 0);
  assert.equal(feats.sweepAgeBars, 7);
  assert.equal(feats.sweepToChochBars, 2);
  assert.equal(feats.chochToEntryBars, 5);
});

test("SESSION in detectSignalMulti: Scalping null at 03 UTC when Asia filter on", () => {
  const smc = new SmartMoneyConceptsStrategy();
  // Force a sequence signal via stub
  const orig = smc._detectSMCSequence.bind(smc);
  smc._detectSMCSequence = () => ({
    signal: "LONG",
    meta: {
      score: 90,
      sweepIdx: 1, chochIdx: 2, dispIdx: 3,
      fvg: { size: 0.01, top: 1, bottom: 0, midpoint: 0.5 },
      obConfluence: true,
      confidenceComponents: { sweepStrength: 2, fvgSize: 0.01, displacementPct: 1, htfAlignment: 0 },
      _isBreakoutBar: false,
      _brokeThroughFvg: false,
    },
  });

  const ind = {
    closes: Array(40).fill(100),
    highs: Array(40).fill(101),
    lows: Array(40).fill(99),
    volumes: Array(40).fill(100),
    volSMA: Array(40).fill(100),
    emaFast: Array(40).fill(100),
    emaSlow: Array(40).fill(100),
    atr: Array(40).fill(1),
  };

  const blocked = smc.detectSignalMulti(ind, 39, {
    smcUseSequenceEngine: true,
    smcMinConfidenceA: 50,
    smcMinConfidenceALong: 50,
    smcMinConfidenceAShort: 50,
    scalpingChochValidate: false,
    smcSessionFilter: true,
    noTradeSessions: ["Sydney", "Tokyo"],
    candleTimestamp: Date.UTC(2026, 6, 13, 3, 5, 0),
    htfTrend: "BULLISH",
  });
  assert.equal(blocked.Scalping, null);

  const open = smc.detectSignalMulti(ind, 39, {
    smcUseSequenceEngine: true,
    smcMinConfidenceA: 50,
    smcMinConfidenceALong: 50,
    smcMinConfidenceAShort: 50,
    scalpingChochValidate: false,
    smcSessionFilter: true,
    noTradeSessions: ["Sydney", "Tokyo"],
    candleTimestamp: Date.UTC(2026, 6, 13, 14, 5, 0),
    htfTrend: "BULLISH",
  });
  assert.equal(open.Scalping, "LONG");
  assert.ok(open.meta.confidenceComponents || open.meta.sequenceMeta?.confidenceComponents);
  assert.ok(open.meta.marketCond); // always populated (NORMAL|VOLATILE|STRONG_TREND|DEAD_MARKET)

  smc._detectSMCSequence = orig;
});

test("RR: Scalping typeOverrides yield Planned RR 2.0", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const cfg = smc.calculateRiskConfig(100, 1, "LONG", "Scalping", {
    slMultiplier: 2.2,
    tpMultiplier: 4.4,
  });
  assert.equal(cfg.riskReward, 2);
});
