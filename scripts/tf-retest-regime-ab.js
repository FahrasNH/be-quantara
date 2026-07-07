#!/usr/bin/env node
/**
 * TS_TF RETEST-ENTRY + STRICT-REGIME A/B (AF-SCALP-23, 2026-07-07)
 *
 * Post AF-SCALP-22 CSVs confirm geometry now flows (RR 1.92) but netPF is flat
 * (~0.55-0.6): geometry alone cannot clear PF 1.2. Two structural levers left:
 *   1. RETEST ENTRY — TF fires at the extended breakout close ("pullback
 *      retest" layer is really just close>EMA9). retestEntryEnabled parks a
 *      limit 0.5×ATR behind the signal: better fill or no fill.
 *   2. STRICT REGIME — default gate only blocks CHOP (<0.5); the 0.5-0.8
 *      transition band bled through every chop month (Feb, Jun 2026).
 *      tfRequireStrongTrend trades only STRONG_TREND days.
 * All runs WITH dailyCandles (parity with the user's route runs), fees+slip ON,
 * maker inherited from base typeOverrides, full TP mode (matches the user's
 * per-leg runs). Walk-forward the winner on 3 yearly windows.
 * Usage: node scripts/tf-retest-regime-ab.js
 */
const { execSync } = require("child_process");
const { runMultiTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const HOST = "https://data-api.binance.vision";

function fetchK(sym, iv, startMs, endMs) {
  const out = []; let c = startMs;
  while (c < endMs) {
    const url = `${HOST}/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${c}&limit=1000`;
    let a; try { a = JSON.parse(execSync(`curl -s --max-time 30 "${url}"`, { maxBuffer: 64e6 }).toString()); } catch { break; }
    if (!Array.isArray(a) || !a.length) break;
    for (const k of a) { if (k[0] > endMs) break; out.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }); }
    const last = a[a.length - 1][0]; if (last <= c) break; c = last + 1;
  }
  return out;
}
const inWin = (arr, s, e) => arr.filter(c => c.timestamp >= s && c.timestamp < e);
function pf(t) { let gp = 0, gl = 0; for (const x of t) { if (x.pnl >= 0) gp += x.pnl; else gl += -x.pnl; } return { net: gl ? gp / gl : (gp > 0 ? Infinity : 0), pnl: gp - gl }; }
function row(label, t) {
  const closes = t.filter(x => !x.isPartial);
  const w = closes.filter(x => x.result === "win").length;
  const p = pf(t);
  return `${label.padEnd(46)} pos=${String(closes.length).padStart(3)} WR=${closes.length ? (w / closes.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

const BASE = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70,
  riskPerTrade: 0.03, htfTrendStrengthMin: 0.65, capital: 1000,
  tpMode: "full",
};
const V = (extra = {}) => ({ ...BASE, atrMult: 1.3, riskReward: 1.92, ...extra });

async function run(cfg, candles, legs = ["Intraday", "Swing"]) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles: candles.entry, htfCandles: candles.htf, dailyCandles: candles.daily,
    symbol: "BTCUSDT",
  }, legs);
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 15m + 4h + 1w + 1d candles (BTCUSDT)…");
  const s4y = Date.UTC(2022, 6, 1);
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  const all1w = fetchK("BTCUSDT", "1w", s4y, now);
  const all1d = fetchK("BTCUSDT", "1d", s4y, now);
  console.log(`Loaded ${all15.length}×15m ${all4h.length}×4h ${all1w.length}×1w ${all1d.length}×1d\n`);

  const win = (s, e) => ({
    entry: { Intraday: inWin(all15, s, e), Swing: inWin(all4h, s, e) },
    htf: { Intraday: inWin(all4h, s, e), Swing: inWin(all1w, s, e) },
    daily: inWin(all1d, s, e),
  });
  const W12 = win(Date.UTC(2025, 6, 1), now);

  console.log("── STAGE 1: candidates (12mo, fees+slip ON, full TP, maker) ──");
  const CANDS = [
    ["V0 baseline SL1.3/RR1.92", V(), ["Intraday", "Swing"]],
    ["V1 V0+retest(0.5ATR,TTL12)", V({ retestEntryEnabled: true }), ["Intraday", "Swing"]],
    ["V2 retest + SL1.0/RR2.5", V({ retestEntryEnabled: true, atrMult: 1.0, riskReward: 2.5 }), ["Intraday", "Swing"]],
    ["V3 V2 + strongTrendOnly", V({ retestEntryEnabled: true, atrMult: 1.0, riskReward: 2.5, tfRequireStrongTrend: true }), ["Intraday", "Swing"]],
    ["V4 V0 + strongTrendOnly", V({ tfRequireStrongTrend: true }), ["Intraday", "Swing"]],
    ["V5 V2 Intraday-only", V({ retestEntryEnabled: true, atrMult: 1.0, riskReward: 2.5 }), ["Intraday"]],
    ["V6 V3 Intraday-only", V({ retestEntryEnabled: true, atrMult: 1.0, riskReward: 2.5, tfRequireStrongTrend: true }), ["Intraday"]],
  ];
  const results = [];
  for (const [label, cfg, legs] of CANDS) {
    const t = await run(cfg, W12, legs);
    results.push({ label, cfg, legs, t, netPF: pf(t).net, n: t.filter(x => !x.isPartial).length });
    console.log(row(label, t));
  }
  const viable = results.filter(r => r.n >= 10).sort((a, b) => b.netPF - a.netPF);
  const best = viable[0] || results[0];
  console.log(`\n→ Stage 1 winner: ${best.label}\n`);

  console.log("── STAGE 2: WALK-FORWARD winner vs V0 ──");
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  for (const [label, s, e] of WINDOWS) {
    const wdat = win(s, e);
    const t0 = await run(V(), wdat, ["Intraday", "Swing"]);
    const tb = await run(best.cfg, wdat, best.legs);
    console.log(row(`${label} V0`, t0));
    console.log(row(`${label} ${best.label.split(" ")[0]}`, tb));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
