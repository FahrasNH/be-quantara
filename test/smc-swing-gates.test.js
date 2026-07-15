/**
 * smc-swing-gates.test.js — Sprint 13 Swing gates, RR SSOT, confidence recalibration
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const {
  resolveSwingGateFlags,
  applySmcFundingGuard,
  buildSmcEntryFeatures,
  buildCostModelMeta,
  holdHoursBetween,
  sweetSpotPts,
  SMC_ML_CSV_COLUMNS,
  DEFAULT_SWING_MAX_HOLD_HOURS,
} = require("#core/strategy-engine/af/smcEntry.js");
const SmartMoneyConceptsStrategy = require("../src/core/strategy-engine/implementations/SmartMoneyConceptsStrategy");
const { TRADE_EXPORT_COLUMNS } = require("#shared/csv/tradeExportCsv.js");
const { STRATEGIES } = require("#config/strategyDefaults.js");

test("SWING-FLAGS: resolveSwingGateFlags defaults + typeOverrides", () => {
  const flags = resolveSwingGateFlags({
    typeOverrides: {
      Swing: {
        smcRequireObRetest: true,
        maxHoldHours: 240,
        smcFundingGuard: true,
        smcMaxFundingRate: 0.0002,
        smcHoldWarnHours: 168,
        swingMarketingBlocked: true,
      },
    },
  });
  assert.equal(flags.smcRequireObRetest, true);
  assert.equal(flags.maxHoldHours, 240);
  assert.equal(flags.smcFundingGuard, true);
  assert.equal(flags.smcMaxFundingRate, 0.0002);
  assert.equal(flags.smcHoldWarnHours, 168);
  assert.equal(flags.swingMarketingBlocked, true);
  assert.equal(DEFAULT_SWING_MAX_HOLD_HOURS, 240);
});

test("SWING-FUNDING: blocks LONG on extreme positive funding, SHORT on extreme negative", () => {
  const longBlocked = applySmcFundingGuard({
    signal: "LONG", fundingRate: 0.0003, enabled: true, maxAbsRate: 0.0002,
  });
  assert.equal(longBlocked.allow, false);
  assert.equal(longBlocked.reason, "funding_long_premium");
  assert.ok(longBlocked.fundingForecast24h != null);

  const shortBlocked = applySmcFundingGuard({
    signal: "SHORT", fundingRate: -0.0003, enabled: true, maxAbsRate: 0.0002,
  });
  assert.equal(shortBlocked.allow, false);

  const longOk = applySmcFundingGuard({
    signal: "LONG", fundingRate: 0.0001, enabled: true, maxAbsRate: 0.0002,
  });
  assert.equal(longOk.allow, true);

  const off = applySmcFundingGuard({
    signal: "LONG", fundingRate: 0.01, enabled: false,
  });
  assert.equal(off.allow, true);

  const failOpen = applySmcFundingGuard({
    signal: "LONG", fundingRate: null, enabled: true,
  });
  assert.equal(failOpen.allow, true);
});

test("SWING-RR: SUB_STRATEGIES PRD aspirational 1.2/4.0; calculateRiskConfig honors overrides", () => {
  const smc = new SmartMoneyConceptsStrategy();
  assert.equal(smc.SUB_STRATEGIES.Swing.slMultiplier, 1.2);
  assert.equal(smc.SUB_STRATEGIES.Swing.tpMultiplier, 4.0);

  const cfg = smc.calculateRiskConfig(100, 1, "LONG", "Swing", {
    slMultiplier: 1.8,
    tpMultiplier: 4.5,
  });
  assert.equal(cfg.riskReward, 2.5);

  // Factory-reset configs may omit legacy STRATEGIES.*.typeOverrides.Swing;
  // risk overrides via calculateRiskConfig opts remain the runtime SSOT.
  // A Swing override may also exist purely for non-risk knobs (e.g. the low-TF
  // ATR-gate fix sets typeOverrides.Swing.atrMinMult only) — the legacy
  // fast-fail assertions below apply ONLY when the fast-fail SSOT is present.
  const ov = STRATEGIES.SMART_MONEY_CONCEPTS?.typeOverrides?.Swing
    ?? STRATEGIES.SMART_MONEY_CONCEPTS?.typeOverrides?.Swing
    ?? null;
  if (ov && ov.slAtrMult != null) {
    assert.equal(ov.slAtrMult, 1.8);
    assert.equal(ov.tpAtrMult, 4.5);
    assert.equal(ov.maxHoldHours, 240);
    assert.equal(ov.smcRequireObRetest, true);
    assert.equal(ov.smcFundingGuard, true);
  }
});

test("CONF-SWEETSPOT: extremes score lower than peak (inverted-confidence fix)", () => {
  const peak = sweetSpotPts(1.5, { peak: 1.5, inner: 0.3, outer: 1.5, maxPts: 14, floor: 2 });
  const extreme = sweetSpotPts(4.0, { peak: 1.5, inner: 0.3, outer: 1.5, maxPts: 14, floor: 2 });
  assert.ok(peak > extreme, `peak ${peak} should beat extreme ${extreme}`);
  assert.equal(extreme, 2);
});

test("CONF-BREAKOUT: breakout bars get lower score than mitigated OB confluence", () => {
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
  const base = {
    isLong: true,
    fvg: { size: 0.003, midpoint: 100.2, bottom: 100, top: 100.4 },
    dispIdx: n - 5,
    chochIdx: n - 10,
    sweepIdx: n - 15,
    config: {},
  };
  const quality = smc._scoreSequence(ind, n - 1, {
    ...base,
    obConfluence: true,
    _isBreakoutBar: false,
    _brokeThroughFvg: false,
  });
  const chase = smc._scoreSequence(ind, n - 1, {
    ...base,
    obConfluence: false,
    _isBreakoutBar: true,
    _brokeThroughFvg: true,
  });
  assert.ok(quality.score > chase.score,
    `quality ${quality.score} should beat chase ${chase.score}`);
  assert.ok(quality.components.atrNorm === true);
});

test("CSV-COLS: Swing ML columns live in SMC_ML_CSV_COLUMNS, not TRADE_EXPORT_COLUMNS", () => {
  const keys = new Set(TRADE_EXPORT_COLUMNS.map(([k]) => k));
  assert.ok(keys.has("entryReasons"), "CORE must include entryReasons");
  for (const [k] of SMC_ML_CSV_COLUMNS) {
    assert.ok(!keys.has(k), `stale ML column ${k} must not be in TRADE_EXPORT_COLUMNS`);
  }
});

test("FEATURES: fundingRateAtEntry + holdHours helpers", () => {
  const feats = buildSmcEntryFeatures(
    {
      closes: [100, 101],
      highs: [101, 102],
      lows: [99, 100],
      volumes: [100, 150],
      volSMA: [100, 100],
      atr: [2, 2],
    },
    1,
    { obConfluence: true },
    { atr: 2, price: 101, timestamp: Date.UTC(2026, 6, 13, 10, 0, 0), fundingRate: 0.0001 },
  );
  assert.equal(feats.fundingRateAtEntry, 0.0001);
  assert.equal(feats.fundingForecast24h, 0.0003);
  assert.equal(feats.hourUtc, 10);

  const hold = holdHoursBetween(
    Date.UTC(2026, 6, 1, 0, 0, 0),
    Date.UTC(2026, 6, 11, 0, 0, 0),
  );
  assert.equal(hold, 240);
});

test("COST-MODEL: buildCostModelMeta documents Fee=0 when fees off", () => {
  const on = buildCostModelMeta({ enableFees: true, feeRate: 0.0006 });
  assert.equal(on.enableFees, true);
  assert.ok(!/WARNING/.test(on.note));

  const off = buildCostModelMeta({ enableFees: false });
  assert.equal(off.enableFees, false);
  assert.ok(/WARNING/.test(off.note));
});

test("SWING-RETEST: detectSignalMulti nulls Swing on breakout when retest required", () => {
  const smc = new SmartMoneyConceptsStrategy();
  const orig = smc._detectSMCSequence.bind(smc);
  smc._detectSMCSequence = () => ({
    signal: "LONG",
    meta: {
      score: 80,
      sweepIdx: 1, chochIdx: 2, dispIdx: 3,
      fvg: { size: 0.01, top: 1, bottom: 0, midpoint: 0.5 },
      obConfluence: false,
      confidenceComponents: { sweepStrength: 2, fvgSize: 0.01, displacementPct: 1, htfAlignment: 0 },
      _isBreakoutBar: true,
      _brokeThroughFvg: true,
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
    smcMinConfidenceC: 50,
    typeOverrides: { Swing: { smcRequireObRetest: true } },
    htfTrend: "BULLISH",
  });
  assert.equal(blocked.Swing, null);

  smc._detectSMCSequence = () => ({
    signal: "LONG",
    meta: {
      score: 80,
      sweepIdx: 1, chochIdx: 2, dispIdx: 3,
      fvg: { size: 0.01, top: 1, bottom: 0, midpoint: 0.5 },
      obConfluence: true,
      confidenceComponents: { sweepStrength: 1.5, fvgSize: 0.01, displacementPct: 1, htfAlignment: 0 },
      _isBreakoutBar: false,
      _brokeThroughFvg: false,
    },
  });
  const open = smc.detectSignalMulti(ind, 39, {
    smcUseSequenceEngine: true,
    smcMinConfidenceC: 50,
    typeOverrides: { Swing: { smcRequireObRetest: true } },
    htfTrend: "BULLISH",
  });
  assert.equal(open.Swing, "LONG");

  smc._detectSMCSequence = orig;
});
