#!/usr/bin/env node
/**
 * af-confidence-gate-compare.js — Sprint 7 (AF-FIX) demonstration.
 *
 * Runs the REAL server-side backtest engine on identical deterministic candles
 * three ways and prints a side-by-side comparison so the effect of the AF-FIX
 * confidence gate is visible:
 *   (1) C-only, no gate            — the v3.2 production baseline
 *   (2) A/B/C re-enabled, NO gate  — what re-enabling A/B looks like UNGATED
 *   (3) A/B/C re-enabled, gate=60  — the AF-FIX shipping config
 *
 * No DB / network — uses synthetic regime-cycling candles.
 */

const { runRealBacktest } = require("../src/server/services/RealStrategyBacktestService");

// Deterministic regime-cycling candles (mirror real-backtest-service.test.js).
// `chop` weights the regime mix toward whippy/weak-trend bars where A/B produce
// the marginal fires the confidence gate is meant to filter.
function gen(days, iv, seed = 42, chop = false) {
  const bars = Math.floor((days * 24 * 60) / iv);
  let p = 600;
  let t = Date.UTC(2024, 2, 17);
  const R = chop
    ? ["C", "N", "C", "N", "U", "C", "D", "N", "C"]   // choppy / weak-trend heavy
    : ["U", "N", "C", "D", "N"];
  const RL = Math.floor((24 * 60) / iv);
  const out = [];
  let s = seed;
  const rnd = () => { s = (1103515245 * s + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < bars; i++) {
    const r = R[Math.floor(i / RL) % R.length];
    let d, n;
    if (r === "U") { d = p * (chop ? 0.0008 : 0.0015); n = chop ? 0.006 : 0.004; }
    else if (r === "D") { d = -p * (chop ? 0.0008 : 0.0015); n = chop ? 0.006 : 0.004; }
    else if (r === "C") { d = (rnd() - 0.5) * p * 0.003; n = 0.014; }
    else { d = (rnd() - 0.45) * p * 0.0008; n = chop ? 0.008 : 0.005; }
    const no = (rnd() - 0.5) * p * n * 2;
    const o = p, c = Math.max(p + d + no, 1);
    const hi = Math.max(o, c) * (1 + rnd() * n);
    const lo = Math.min(o, c) * (1 - rnd() * n);
    out.push({ timestamp: t, date: new Date(t).toISOString(), open: o, high: hi, low: lo, close: c, volume: 1000 + rnd() * 4000 });
    p = c; t += iv * 60000;
  }
  return out;
}

const DATASET = process.argv.includes("--chop") ? "choppy/weak-trend" : "clean regime-cycling";
const useChop = process.argv.includes("--chop");
const entry = gen(180, 15, 42, useChop);
const htf   = gen(180, 60, 42, useChop);

function run(label, config) {
  const r = runRealBacktest({ entryCandles: entry, htfCandles: htf, strategyKey: "ADAPTIVE_FUSION", capital: 1000, config });
  const s = r.stats;
  const confs = r.trades.map(t => t.confidence).filter(c => c != null);
  const avgConf = confs.length ? (confs.reduce((a, b) => a + b, 0) / confs.length).toFixed(1) : "n/a";
  return {
    label,
    trades: s.totalTrades,
    winRate: s.winRate + "%",
    profitFactor: s.profitFactor,
    totalReturn: s.totalReturn + "%",
    maxDD: s.maxDrawdown + "%",
    avgConfidence: avgConf,
  };
}

const common = { afMinVotes: 2, volSmaMultiplier: 1.0 };

const rows = [
  run("(1) C-only, no gate (v3.2 baseline)", { ...common, afEnabledComponents: ["C"] }),
  run("(2) A/B/C, NO confidence gate",        { ...common, afEnabledComponents: ["A", "B", "C"] }),
  run("(3) A/B/C, confidence gate = 60 (AF-FIX)", { ...common, afEnabledComponents: ["A", "B", "C"], afMinComponentConfidence: 60, afMinAggregateConfidence: 60 }),
];

console.log(`\nADAPTIVE_FUSION confidence-gate comparison — dataset: ${DATASET} (180d / 15m, identical candles)\n`);
console.log(
  "scenario".padEnd(44),
  "trades".padStart(7),
  "winRate".padStart(8),
  "PF".padStart(6),
  "return".padStart(9),
  "maxDD".padStart(7),
  "avgConf".padStart(8)
);
console.log("-".repeat(96));
for (const r of rows) {
  console.log(
    r.label.padEnd(44),
    String(r.trades).padStart(7),
    String(r.winRate).padStart(8),
    String(r.profitFactor).padStart(6),
    String(r.totalReturn).padStart(9),
    String(r.maxDD).padStart(7),
    String(r.avgConfidence).padStart(8)
  );
}
console.log("");
