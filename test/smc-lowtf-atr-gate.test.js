/**
 * smc-lowtf-atr-gate.test.js — SMART_MONEY_CONCEPTS low-TF ATR-gate fix (2026-07-15)
 *
 * Regression guard for the tuning that unblocks the Scalping (5m) and Intraday
 * (15m) legs. Root cause: the ABSOLUTE atrMinMult floor (0.8 = 0.8% ATR/price)
 * was calibrated for the 4h chart but applied to every leg, so on 5m/15m —
 * where real ATR% sits well below 0.8% — nearly every bar was rejected
 * (Scalping 0 trades / 3mo, Intraday ~3 / 3mo).
 *
 * The fix adds per-leg atrMinMult via typeOverrides (Scalping 0.15, Intraday
 * 0.4, Swing 0.8-unchanged) plus per-leg confidence floors (Scalping 30,
 * Intraday 45). This test
 * runs the REAL backtest engine (runTripleTypeBacktest — same code path the
 * product uses for SMART_MONEY_CONCEPTS) across two non-overlapping synthetic windows and
 * asserts:
 *   • Scalping & Intraday go from 0 entries (old absolute floor) to > 0.
 *   • Swing behaviour is bit-identical before vs after.
 *   • The SMART_MONEY_CONCEPTS config carries the exact tuned values.
 */
"use strict";

const assert = require("node:assert");
const { test } = require("node:test");
const { STRATEGIES, DEFAULT_LEG_TYPE_OVERRIDES } = require("../src/config/strategyDefaults");
const { runTripleTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService");
const { evaluateAtrEntryGate, buildAtrBaseline } = require("../src/core/risk-engine/entryRiskGates");

const TF_MS = { "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": 60 * 60e3, "4h": 240 * 60e3, "1w": 7 * 24 * 60 * 60e3 };

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Structured OHLCV: cycling impulsive/pullback/chop legs (produces the sweeps,
// displacement bars and FVGs the SMC sequence engine keys off), with a per-bar
// volatility calibrated to a target ATR% band for each timeframe.
function genCandles(nBars, stepMs, seed, volPct, startTs) {
  const rnd = mulberry(seed);
  const candles = [];
  let price = 100;
  let t = startTs;
  for (let i = 0; i < nBars; i++) {
    const phase = Math.floor(i / 120) % 4;
    const wave = Math.sin(i / 40);
    const drift = phase === 0 ? volPct * 0.6
      : phase === 1 ? -volPct * 0.25
        : phase === 2 ? -volPct * 0.6
          : volPct * 0.05 * wave;
    const ret = (drift + (rnd() - 0.5) * 2 * volPct) / 100;
    const open = price;
    const close = Math.max(price * (1 + ret), 1);
    const wick = (rnd() * 0.6 + 0.2) * volPct / 100;
    const high = Math.max(open, close) * (1 + wick);
    const low = Math.min(open, close) * (1 - wick);
    const volume = 100 * (0.6 + rnd() * 1.6) * (1 + (rnd() < 0.05 ? 4 : 0));
    candles.push({ timestamp: t, open, high, low, close, volume });
    price = close; t += stepMs;
  }
  return candles;
}

// Sprint 14 TF ladder: Scalping 5m/1h · Intraday 15m/4h · Swing 4h/1w.
// vols chosen so ATR% ≈ Scalping 0.4 · Intraday 0.6 · Swing 1.3 — i.e. the two
// low-TF legs sit BELOW the old 0.8 floor but above their new per-leg floors,
// while Swing stays above 0.8 (its behaviour must not change).
const LEGS = {
  Scalping: { tf: "5m", htf: "1h", vol: 0.25 },
  Intraday: { tf: "15m", htf: "4h", vol: 0.37 },
  Swing:    { tf: "4h", htf: "1w", vol: 0.8 },
};

function buildWindow(seedBase, days) {
  const startTs = Date.UTC(2025, 0, 1) + seedBase * 1000;
  const entryCandles = {}, htfCandles = {};
  let s = seedBase;
  for (const [leg, cfg] of Object.entries(LEGS)) {
    const nEntry = Math.floor((days * 24 * 60 * 60e3) / TF_MS[cfg.tf]);
    const nHtf = Math.floor((days * 24 * 60 * 60e3) / TF_MS[cfg.htf]) + 300;
    entryCandles[leg] = genCandles(nEntry, TF_MS[cfg.tf], s++ * 7 + 11, cfg.vol, startTs);
    htfCandles[leg] = genCandles(nHtf, TF_MS[cfg.htf], s++ * 7 + 23, cfg.vol * 1.4, startTs - 300 * TF_MS[cfg.htf]);
  }
  return { entryCandles, htfCandles };
}

// The pre-fix baseline: uniform absolute floor + Intraday confidence floor 60.
// Explicit absolute-only legs (do NOT use typeOverrides:{} — deep merge preserves SSOT).
const OLD_ABSOLUTE_CFG = {
  atrMinMult: 0.8,
  atrMaxMult: 5.0,
  smcMinConfidenceB: 60,
  typeOverrides: {
    Scalping: { atrMinMult: 0.8, atrGateRelative: false },
    Intraday: { atrMinMult: 0.8 },
    Swing: { atrMinMult: 0.8 },
  },
};

async function tradesByLeg(window, config) {
  const res = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: 1000,
    enableFees: true,
    enableSlippage: false,
    entryCandles: window.entryCandles,
    htfCandles: window.htfCandles,
    config, // undefined → strategyDefaults (post-fix per-leg overrides)
  });
  const out = {};
  for (const leg of ["Scalping", "Intraday", "Swing"]) {
    out[leg] = res.perTypeStats[leg]?.trades ?? 0;
  }
  return out;
}

test("CONFIG: SMART_MONEY_CONCEPTS carries the tuned per-leg atrMinMult + Intraday confB", () => {
  const ov = STRATEGIES.SMART_MONEY_CONCEPTS.typeOverrides;
  assert.equal(ov.Scalping.atrMinMult, 0.15, "Scalping atrMinMult must be 0.15");
  assert.equal(ov.Scalping.atrGateRelative, true, "Scalping must use adaptive ATR gate");
  // Defect A fix (2026-07-16): band widened 0.6–3.0 → 0.4–4.0 so clustered real-vol
  // SMC setups (rel<0.6 in calm legs / rel>3.0 on displacement spikes) are no longer
  // blanket-rejected. Shared SSOT → live/dry-run/backtest all move together.
  assert.equal(ov.Scalping.atrRelMin, 0.4);
  assert.equal(ov.Scalping.atrRelMax, 4.0);
  assert.equal(ov.Intraday.atrMinMult, 0.4, "Intraday atrMinMult must be 0.4");
  assert.equal(ov.Swing.atrMinMult, 0.8, "Swing atrMinMult must stay 0.8");
  assert.ok(!ov.Intraday.atrGateRelative, "Intraday stays absolute ATR gate");
  assert.equal(ov.Scalping.smcMinConfidenceA, 30, "Scalping confA must be 30");
  assert.equal(ov.Intraday.smcMinConfidenceB, 45, "Intraday confB must be 45");
  // Top-level floor (what LIVE gating reads) is untouched at 0.8 → live unchanged.
  assert.equal(STRATEGIES.SMART_MONEY_CONCEPTS.atrMinMult, 0.8, "top-level atrMinMult (live) must stay 0.8");
  assert.equal(STRATEGIES.SMART_MONEY_CONCEPTS.smcMinConfidenceB, 60, "top-level confB (live) must stay 60");
});

test("PARITY: relative ATR band 0.4–4.0 is the SHARED SSOT (gate math == config)", () => {
  // The gate math default (used by live validateEntry / checkAtrRangeGate) MUST
  // equal the config band the backtest flattens onto cfg — otherwise live and
  // backtest would gate real-vol setups differently (parity break).
  const scalp = DEFAULT_LEG_TYPE_OVERRIDES.Scalping;
  assert.equal(scalp.atrRelMin, 0.4, "config band min must be 0.4");
  assert.equal(scalp.atrRelMax, 4.0, "config band max must be 4.0");

  // evaluateAtrEntryGate is the SSOT shared by LIVE and BACKTEST. Same inputs →
  // same verdict regardless of caller. price=100, baseline=1 → rel == atr.
  const gate = (atr, cfg = {}) => evaluateAtrEntryGate({
    atr, price: 100, atrBaseline: 1, atrGateRelative: true,
    atrRelMin: cfg.atrRelMin ?? scalp.atrRelMin,
    atrRelMax: cfg.atrRelMax ?? scalp.atrRelMax,
  });

  // Newly ADMITTED by the widened band (were rejected under 0.6–3.0):
  assert.ok(gate(0.5).ok, "rel=0.5 (calm SMC leg) must PASS under 0.4 floor");
  assert.ok(gate(3.5).ok, "rel=3.5 (displacement spike) must PASS under 4.0 cap");
  // Still REJECTED (dead market / true blowoff):
  assert.ok(!gate(0.3).ok, "rel=0.3 (flatlined) must still be blocked");
  assert.ok(!gate(4.5).ok, "rel=4.5 (blowoff) must still be blocked");

  // Gate defaults (no explicit band) resolve to the same widened window → a
  // caller that omits the band (some live paths) matches the backtest.
  assert.ok(evaluateAtrEntryGate({ atr: 0.5, price: 100, atrBaseline: 1, atrGateRelative: true }).ok);
  assert.ok(!evaluateAtrEntryGate({ atr: 0.3, price: 100, atrBaseline: 1, atrGateRelative: true }).ok);
});

test("PARITY: relative branch does NOT fire on warmup/NaN baseline (no spurious rel rejection)", () => {
  // During warmup buildAtrBaseline yields null for the first bars. The relative
  // branch must NOT fire on a null/NaN/≤0 baseline — it falls through to the
  // absolute floor instead of computing a bogus ratio. Same for live and backtest.
  const warm = evaluateAtrEntryGate({ atr: 0.5, price: 100, atrBaseline: null, atrGateRelative: true });
  assert.notEqual(warm.mode, "relative", "null baseline must not use relative mode");
  const nan = evaluateAtrEntryGate({ atr: 0.5, price: 100, atrBaseline: NaN, atrGateRelative: true });
  assert.notEqual(nan.mode, "relative", "NaN baseline must not use relative mode");
  // ATR above the absolute floor + null baseline → passes (relative never rejects it).
  const ok = evaluateAtrEntryGate({ atr: 1.0, price: 100, atrBaseline: null, atrGateRelative: true });
  assert.ok(ok.ok && ok.mode === "absolute", "null baseline falls through to absolute floor");
  const base = buildAtrBaseline([null, null, 1, 1]);
  assert.equal(base[0], null, "warmup baseline is null before any finite ATR");
});

test("ENGINE: low-TF legs unblocked out-of-sample; Swing invariant", async () => {
  const windows = [buildWindow(1000, 45), buildWindow(777777, 45)];

  let scalpBefore = 0, scalpAfter = 0, intraBefore = 0, intraAfter = 0;

  for (const w of windows) {
    const before = await tradesByLeg(w, OLD_ABSOLUTE_CFG);
    const after = await tradesByLeg(w, undefined);

    // Swing sits above the 0.8 floor in both configs → must be bit-identical.
    assert.equal(after.Swing, before.Swing,
      `Swing must be unchanged (before=${before.Swing}, after=${after.Swing})`);

    // Old absolute floor starved the low-TF legs entirely.
    assert.equal(before.Scalping, 0, `expected 0 Scalping under old floor, got ${before.Scalping}`);
    assert.equal(before.Intraday, 0, `expected 0 Intraday under old floor, got ${before.Intraday}`);

    scalpBefore += before.Scalping; scalpAfter += after.Scalping;
    intraBefore += before.Intraday; intraAfter += after.Intraday;
  }

  // The fix must produce entries where there were none (both legs, across windows).
  assert.ok(scalpAfter > scalpBefore && scalpAfter > 0,
    `Scalping must go from 0 to >0 (before=${scalpBefore}, after=${scalpAfter})`);
  assert.ok(intraAfter > intraBefore && intraAfter > 0,
    `Intraday must go from 0 to >0 (before=${intraBefore}, after=${intraAfter})`);
});
