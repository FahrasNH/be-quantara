/**
 * Regression: Scalping-only triple-TF backtest must stay under a sane bar budget.
 * Guards htfTrendAt O(n²) + Intraday pivot leak + full AF race on SMC-only jobs.
 */
"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { applyStrategyJobDefaults } = require("../src/modules/backtest/services/runBacktestJob");
const { runTripleTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService");

const TF_MS = { "5m": 5 * 60e3, "1h": 60 * 60e3 };

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
    const ret = ((rnd() - 0.5) * 2 * volPct) / 100;
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

function build180dWindow() {
  const days = 180;
  const startTs = Date.UTC(2025, 0, 1);
  const nEntry = Math.floor((days * 24 * 60 * 60e3) / TF_MS["5m"]);
  const nHtf = Math.floor((days * 24 * 60 * 60e3) / TF_MS["1h"]) + 300;
  return {
    nEntry,
    entryCandles: { Scalping: genCandles(nEntry, TF_MS["5m"], 11, 0.25, startTs) },
    htfCandles: { Scalping: genCandles(nHtf, TF_MS["1h"], 23, 0.35, startTs - 300 * TF_MS["1h"]) },
  };
}

test("applyStrategyJobDefaults: SMC-only racer → afCombinationMode smc_only", () => {
  const out = applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
    afActiveVoters: ["SMART_MONEY_CONCEPTS"],
    selectedComponents: ["SMART_MONEY_CONCEPTS"],
  });
  assert.strictEqual(out.afCombinationMode, "smc_only");
  const full = applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
    afActiveVoters: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
  });
  assert.strictEqual(full.afCombinationMode, undefined);
});

test("180d Scalping-only backtest completes under 90s on CI hardware", async () => {
  const { nEntry, ...window } = build180dWindow();
  const t0 = Date.now();
  const result = await runTripleTypeBacktest({
    strategyKey: "SMART_MONEY_CONCEPTS",
    capital: 1000,
    enableFees: false,
    ...window,
    typeOrder: ["Scalping"],
    config: applyStrategyJobDefaults("SMART_MONEY_CONCEPTS", {
      afActiveVoters: ["SMART_MONEY_CONCEPTS"],
      selectedComponents: ["SMART_MONEY_CONCEPTS"],
    }),
  });
  const ms = Date.now() - t0;
  const msPerBar = ms / nEntry;
  assert.ok(Number.isFinite(result.perTypeStats.Scalping?.entryBars), "Scalping leg ran");
  assert.ok(
    ms < 90_000,
    `180d Scalping-only took ${ms}ms (${msPerBar.toFixed(2)}ms/bar) — expected <90s`,
  );
});
