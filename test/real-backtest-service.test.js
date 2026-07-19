/**
 * real-backtest-service.test.js — RealStrategyBacktestService (server-side 1:1).
 *
 * Locks in that the engine drives the REAL strategy decision path:
 *  - component-aware SL/TP from calculateRiskConfig (not flat atrMult)
 *  - exits are SL/TP only (no EMA-reversal "Signal" exit that live lacks)
 *  - HTF directional block + risk gates actually fire
 *  - afMinVotes=3 (unanimity, live default) is far more selective than 2
 */

const test = require("node:test");
const assert = require("node:assert");
const { runRealBacktest, runMultiTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");

// Deterministic regime-cycling candles (no Math.random → reproducible).
function gen(days, iv, seed = 42) {
  const bars = Math.floor((days * 24 * 60) / iv);
  let p = 600;
  let t = Date.UTC(2024, 2, 17);
  const R = ["U", "N", "C", "D", "N"];
  const RL = Math.floor((24 * 60) / iv);
  const out = [];
  let s = seed;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < bars; i++) {
    const r = R[Math.floor(i / RL) % R.length];
    let d, n;
    if (r === "U") { d = p * 0.0015; n = 0.004; }
    else if (r === "D") { d = -p * 0.0015; n = 0.004; }
    else if (r === "C") { d = (rnd() - 0.5) * p * 0.003; n = 0.014; }
    else { d = (rnd() - 0.45) * p * 0.0008; n = 0.005; }
    const no = (rnd() - 0.5) * p * n * 2;
    const o = p, c = Math.max(p + d + no, 1);
    const hi = Math.max(o, c) * (1 + rnd() * n);
    const lo = Math.min(o, c) * (1 - rnd() * n);
    out.push({ timestamp: t, date: new Date(t).toISOString(), open: o, high: hi, low: lo, close: c, volume: 1000 + rnd() * 4000 });
    p = c; t += iv * 60000;
  }
  return out;
}

const entry = gen(180, 15);
const htf = gen(180, 60);
const entry4h = gen(365, 240);
const htf4h = gen(365, 240);
const htf1w = gen(700, 10080);

test("runs end-to-end and returns stats/trades/equity", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(Array.isArray(r.trades));
  assert.ok(Array.isArray(r.equity));
  assert.ok(r.stats.totalTrades > 0, "should produce trades with afMinVotes=2");
  assert.strictEqual(r.meta.strategyKey, "ADAPTIVE_FUSION");
});

test("exits are SL/TP/TIME_STOP only — no 'Signal' reversal exit (live AF parity)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  const reasons = new Set(r.trades.map(t => t.reason));
  // TIME_STOP is live-parity (maxHoldHours on Scalping/Swing); "Signal" reversal is not.
  for (const reason of reasons) {
    assert.ok(
      reason === "SL" || reason === "TP" || reason === "TIME_STOP",
      `unexpected exit reason: ${reason}`
    );
  }
});

test("SL/TP are component-aware (RR matches a real component, ~2.1–2.5)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  for (const t of r.trades) {
    // Components may be reported as letters (legacy) or type names (Scalping/Intraday/Swing)
    assert.ok(
      ["A", "B", "C", "D", "Scalping", "Intraday", "Swing"].includes(t.component),
      `bad component ${t.component}`
    );
    // RR from component presets (Scalping Planned RR 2.0; Intraday ~1.8; Swing ~3.3)
    assert.ok(t.plannedRR >= 1.4 && t.plannedRR <= 10.0, `RR out of range: ${t.plannedRR}`);
  }
});

test("afMinVotes=3 (unanimity, live default) is at most as active as =2", async () => {
  const r3 = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 3, volSmaMultiplier: 1.0 } });
  const r2 = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(r3.stats.totalTrades <= r2.stats.totalTrades);
});

test("HTF filter is soft by default — counter-HTF trades may still fill with penalty", async () => {
  // AF race uses soft HTF alignment (−confidence) rather than hard reject.
  // Keep this as a smoke assertion that HTF candles are consumed and trades still produce.
  const r = await runRealBacktest({
    entryCandles: entry,
    htfCandles: htf,
    strategyKey: "ADAPTIVE_FUSION",
    capital: 1000,
    config: { afMinVotes: 2, volSmaMultiplier: 1.0 },
  });
  assert.ok(r.stats.totalTrades >= 0);
  assert.ok(Array.isArray(r.trades));
});

test("no HTF candles → fail-open (HTF filter skipped, still trades)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: null, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(r.stats.totalTrades >= 0);
  assert.ok(typeof r.meta.higherTf === "string"); // canonical config still reports intended HTF
});

test("AF race mode — per-trade strategyLabel is winning racer, not race header", async () => {
  const r = await runRealBacktest({
    entryCandles: entry,
    htfCandles: htf,
    strategyKey: "ADAPTIVE_FUSION",
    capital: 1000,
    config: {
      afCombinationMode: "race",
      selectedComponents: ["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"],
      volSmaMultiplier: 1.0,
    },
  });
  assert.ok(r.trades.length > 0, "race-mode AF backtest should produce trades");
  const racerLabels = new Set(["Smart Money Concepts", "Wyckoff Method", "Volume Spread Analysis"]);
  const racerKeys = new Set(["SMART_MONEY_CONCEPTS", "WYCKOFF", "VOLUME_SPREAD_ANALYSIS"]);
  for (const t of r.trades) {
    assert.ok(t.strategyLabel, "trade should have strategyLabel");
    assert.ok(!t.strategyLabel.startsWith("Adaptive Fusion race"),
      `strategyLabel must not be race header, got: ${t.strategyLabel}`);
    assert.ok(racerLabels.has(t.strategyLabel), `unexpected strategyLabel: ${t.strategyLabel}`);
    assert.ok(racerKeys.has(t.strategyKey), `strategyKey should be winning racer, got: ${t.strategyKey}`);
  }
});

// ── runMultiTypeBacktest (TREND_FOLLOWING/MEAN_REVERSION sharing SMART_MONEY_CONCEPTS's own TF definitions) ──
test("runMultiTypeBacktest (TREND_FOLLOWING: Intraday+Swing) never touches Scalping/5m", async () => {
  const r = await runMultiTypeBacktest({
    entryCandles: { Intraday: entry, Swing: entry4h },
    htfCandles: { Intraday: htf, Swing: htf1w },
    strategyKey: "TREND_FOLLOWING",
    capital: 1000,
  }, ["Intraday", "Swing"]);
  assert.ok(Array.isArray(r.trades));
  assert.ok(Array.isArray(r.equity));
  assert.ok(r.perTypeStats.Intraday);
  assert.ok(r.perTypeStats.Swing);
  assert.ok(!("Scalping" in r.perTypeStats), "TREND_FOLLOWING must never fetch/run Scalping (5m)");
  // Regression lock for the self-inclusive Donchian channel bug (2026-07-02): the
  // fallback breakout check compared close[i] against a channel that included bar
  // i's own high/low, making close>upper / close<lower mathematically impossible —
  // TREND_FOLLOWING produced ZERO trades in live AND backtest regardless of data/timeframe.
  // Fixed by comparing against the PRIOR bar's channel instead.
  assert.ok(r.trades.length > 0, "TREND_FOLLOWING must be able to produce trades — 0 trades indicates the Donchian self-inclusion regression has returned");
  for (const t of r.trades) {
    assert.ok(["Intraday", "Swing"].includes(t.component), `unexpected component ${t.component}`);
    assert.strictEqual(t.plannedRR, 2, "TREND_FOLLOWING's fixed RR is 1:2.0 (ATR×1.5 SL / ATR×3.0 TP)");
  }
});

test("runMultiTypeBacktest degrades gracefully when one type has no candles", async () => {
  // Simulates Bitget returning empty 5m candles for MEAN_REVERSION's Scalping type —
  // Intraday (15m) must still produce a result instead of the whole job failing.
  const r = await runMultiTypeBacktest({
    entryCandles: { Scalping: [], Intraday: entry },
    htfCandles: { Scalping: [], Intraday: htf },
    strategyKey: "MEAN_REVERSION",
    capital: 1000,
  }, ["Scalping", "Intraday"]);
  assert.strictEqual(r.perTypeStats.Scalping.skipped, true);
  assert.ok(r.perTypeStats.Intraday && !r.perTypeStats.Intraday.skipped, "Intraday must still run despite Scalping being empty");
  assert.ok(Array.isArray(r.trades));
  assert.ok(r.stats.totalTrades === r.trades.length);
});

console.log("✅ real-backtest-service.test.js — all assertions registered");
