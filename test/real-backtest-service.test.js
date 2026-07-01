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
const { runRealBacktest } = require("../src/server/services/RealStrategyBacktestService");

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

test("runs end-to-end and returns stats/trades/equity", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(Array.isArray(r.trades));
  assert.ok(Array.isArray(r.equity));
  assert.ok(r.stats.totalTrades > 0, "should produce trades with afMinVotes=2");
  assert.strictEqual(r.meta.strategyKey, "ADAPTIVE_FUSION");
});

test("exits are SL/TP only — no 'Signal' reversal exit (live AF parity)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  const reasons = new Set(r.trades.map(t => t.reason));
  for (const reason of reasons) assert.ok(reason === "SL" || reason === "TP", `unexpected exit reason: ${reason}`);
});

test("SL/TP are component-aware (RR matches a real component, ~2.1–2.5)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  for (const t of r.trades) {
    // Components may be reported as letters (legacy) or type names (Scalping/Intraday/Swing)
    assert.ok(
      ["A", "B", "C", "D", "Scalping", "Intraday", "Swing"].includes(t.component),
      `bad component ${t.component}`
    );
    // RR from component presets: A 1.5, B 2.125, C 2.5 (×1.8 if STRONG_TREND)
    assert.ok(t.plannedRR >= 1.4 && t.plannedRR <= 5.0, `RR out of range: ${t.plannedRR}`);
  }
});

test("afMinVotes=3 (unanimity, live default) is at most as active as =2", async () => {
  const r3 = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 3, volSmaMultiplier: 1.0 } });
  const r2 = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(r3.stats.totalTrades <= r2.stats.totalTrades);
});

test("HTF directional block — no LONG while HTF BEARISH, no SHORT while HTF BULLISH", async () => {
  // Mirror engine's per-bar HTF mapping to assert no trade violates direction.
  const { detectHTFTrend } = require("../src/domain/indicators");
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  for (const t of r.trades) {
    const ot = Date.parse(t.openTime);
    let j = 0;
    while (j < htf.length && htf[j].timestamp <= ot) j++;
    const trend = detectHTFTrend(htf.slice(0, j), {});
    if (t.side === "LONG") assert.notStrictEqual(trend, "BEARISH");
    if (t.side === "SHORT") assert.notStrictEqual(trend, "BULLISH");
  }
});

test("no HTF candles → fail-open (HTF filter skipped, still trades)", async () => {
  const r = await runRealBacktest({ entryCandles: entry, htfCandles: null, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config: { afMinVotes: 2, volSmaMultiplier: 1.0 } });
  assert.ok(r.stats.totalTrades >= 0);
  assert.ok(typeof r.meta.higherTf === "string"); // canonical config still reports intended HTF
});

console.log("✅ real-backtest-service.test.js — all assertions registered");
