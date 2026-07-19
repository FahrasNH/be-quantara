/**
 * Repro: Scalping gate funnel — race vs smc_only, ATR before/after typeOverrides.
 */
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { resolveStrategyDefaults } = require("../src/config/strategyDefaults");
const { runTripleTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService");

const TF_MS = { "5m": 5 * 60e3, "30m": 30 * 60e3, "1h": 60 * 60e3 };

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genCandles(nBars, stepMs, seed, volPct, startTs) {
  const rnd = mulberry(seed);
  const candles = [];
  let price = 100;
  let t = startTs;
  for (let i = 0; i < nBars; i++) {
    const phase = Math.floor(i / 120) % 4;
    const drift = phase === 0 ? volPct * 0.6
      : phase === 1 ? -volPct * 0.25
        : phase === 2 ? -volPct * 0.6
          : volPct * 0.05 * Math.sin(i / 40);
    const ret = (drift + (rnd() - 0.5) * 2 * volPct) / 100;
    const open = price;
    const close = Math.max(price * (1 + ret), 1);
    const wick = (rnd() * 0.6 + 0.2) * volPct / 100;
    candles.push({
      timestamp: t, open,
      high: Math.max(open, close) * (1 + wick),
      low: Math.min(open, close) * (1 - wick),
      close,
      volume: 100 * (0.6 + rnd() * 1.6),
    });
    price = close;
    t += stepMs;
  }
  return candles;
}

function buildWindow(days, seed) {
  const startTs = Date.UTC(2025, 0, 1) + seed;
  const nEntry = Math.floor((days * 24 * 60 * 60e3) / TF_MS["5m"]);
  const nHtf = Math.floor((days * 24 * 60 * 60e3) / TF_MS["30m"]) + 300;
  return {
    entryCandles: { Scalping: genCandles(nEntry, TF_MS["5m"], seed * 7 + 11, 0.25, startTs) },
    htfCandles: { Scalping: genCandles(nHtf, TF_MS["30m"], seed * 7 + 23, 0.35, startTs - 300 * TF_MS["30m"]) },
  };
}

test("Scalping funnel: ATR fix unblocks leg; conf 30 lets SMC-only pass CHoCH", async () => {
  const window = buildWindow(45, 1000);
  const base = resolveStrategyDefaults("SMART_MONEY_CONCEPTS");

  const oldAtr = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: 1000,
    enableFees: false,
    ...window,
    typeOrder: ["Scalping"],
    // Explicit absolute 0.8 floor — empty typeOverrides no longer wipes SSOT.
    config: {
      atrMinMult: 0.8,
      typeOverrides: {
        Scalping: { atrMinMult: 0.8, atrGateRelative: false },
      },
    },
  });

  const raceDefault = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: 1000,
    enableFees: false,
    ...window,
    typeOrder: ["Scalping"],
  });

  const smcOnly = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: 1000,
    enableFees: false,
    ...window,
    typeOrder: ["Scalping"],
    config: { afUseThreeComponentVoting: false },
  });

  assert.equal(oldAtr.perTypeStats.Scalping?.trades ?? 0, 0, "old 0.8 ATR floor blocks Scalping");
  assert.ok((raceDefault.perTypeStats.Scalping?.trades ?? 0) > 0, "race mode opens Scalping trades with per-leg overrides");
  assert.ok((smcOnly.perTypeStats.Scalping?.trades ?? 0) > 0,
    "SMC-only opens Scalping trades when conf floor is 30 (CHoCH still filters most setups)");
  assert.equal(base.typeOverrides.Scalping.atrMinMult, 0.287);
  assert.equal(base.typeOverrides.Scalping.smcMinConfidenceA, 40);
});
