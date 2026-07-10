#!/usr/bin/env node
/**
 *
 * CSV forensics (all-type-tf-12.csv, 91 legs -> 57 positions after de-dupe):
 *   WR 45.6%, PF 0.49, net -230.8. Root cause identified as EXIT structure,
 *   not entry: avgWin realized only 0.58R vs avgLoss -1.15R on a PLANNED
 *   RR2 signal -> breakeven WR needed is 63.2%, unreachable for trend-following.
 *   Winners that reach full TP average +1.10R (still short of 2R -- the
 *   ladder banks 40% at +1R then trails the rest out near +0.3R). 69% of
 *   winners never get past the first milestone (+0.35R realized).
 *   Losses >=24h accounted for -76.8 of the -230.8 net (11 positions, PF 0.28)
 *   -- a hung trend thesis that hasn't paid off in a day rarely does.
 *
 * Candidates tested (12mo real BTCUSDT, Intraday 15m/4h + Swing 4h/1w legs,
 * riskPerTrade combined 0.03 -> ladder-split same as live):
 *   C0 baseline       : tpMode=partial (current ladder: 40%@1R SL->0.3R, 27.5%@2R SL->1R)
 *   C1 pure RR (no ladder) : tpMode=full -- full size held to planned TP or SL
 *   C2 lighter ladder : tpMode=partial, single milestone 25%@1.5R SL->breakeven, no 2nd leg
 *   C3 baseline+timestop  : C0 + maxHoldHours=24 on both legs
 *   C4 pure-RR+timestop   : C1 + maxHoldHours=24 on both legs
 * Then walk-forward the winner on 3 prior yearly windows.
 * Usage: node scripts/tf-exit-ladder-ab.js
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
function fmt(label, t) {
  const w = t.filter(x => x.result === "win" && !x.isPartial).length + t.filter(x => x.isPartial && x.pnl >= 0).length;
  // Position-level WR is more meaningful than leg-level; approximate via non-partial closes as position count
  const closes = t.filter(x => !x.isPartial);
  const winCloses = closes.filter(x => x.result === "win").length;
  const p = pf(t);
  return `${label.padEnd(46)} legs=${String(t.length).padStart(3)} positions=${String(closes.length).padStart(3)} posWR=${closes.length ? (winCloses / closes.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

const BASE_TF_CFG = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70,
  atrMult: 1.3, riskReward: 1.92, // planned RR ~2
  riskPerTrade: 0.03, // combined cap, split Intraday 1% / Swing 2% via ladder
  htfTrendStrengthMin: 0.65,
  capital: 1000,
};

function makeCfg({ tpMode = "partial", partial1 = 0.40, partial2 = 0.275, maxHoldHours = null, maker = false } = {}) {
  const legOverride = {
    ...(maxHoldHours ? { maxHoldHours } : {}),
    ...(maker ? { makerEntry: true, makerFeeRate: 0.0002 } : {}),
  };
  return {
    ...BASE_TF_CFG,
    tpMode,
    slPlusPartial1Pct: partial1,
    slPlusPartial2Pct: partial2,
    typeOverrides: {
      Intraday: { ...legOverride },
      Swing: { ...legOverride },
    },
  };
}

async function run(cfg, entryCandles, htfCandles) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles, htfCandles, symbol: "BTCUSDT",
  }, ["Intraday", "Swing"]);
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 15m + 4h + 1w candles (BTCUSDT)…");
  const s4y = Date.UTC(2022, 6, 1);
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  const all1w = fetchK("BTCUSDT", "1w", s4y, now);
  console.log(`Loaded ${all15.length} × 15m, ${all4h.length} × 4h, ${all1w.length} × 1w\n`);

  const W = [Date.UTC(2025, 6, 1), now];
  const entryCandles = { Intraday: inWin(all15, ...W), Swing: inWin(all4h, ...W) };
  const htfCandles = { Intraday: inWin(all4h, ...W), Swing: inWin(all1w, ...W) };

  console.log("── STAGE 1: exit-ladder candidates (12mo) ──");
  const CANDIDATES = [
    ["C0 baseline (current ladder, 40%@1R+27.5%@2R)", makeCfg({})],
    ["C1 pure RR (tpMode=full, no ladder)", makeCfg({ tpMode: "full" })],
    ["C2 lighter ladder (25%@1.5R only, no 2nd leg)", makeCfg({ partial1: 0.25, partial2: 0 })],
    ["C3 baseline + time-stop 24h", makeCfg({ maxHoldHours: 24 })],
    ["C4 pure RR + time-stop 24h", makeCfg({ tpMode: "full", maxHoldHours: 24 })],
    ["C5 pure RR + maker exec", makeCfg({ tpMode: "full", maker: true })],
    ["C6 pure RR + time-stop 24h + maker", makeCfg({ tpMode: "full", maxHoldHours: 24, maker: true })],
  ];
  const results = [];
  for (const [label, cfg] of CANDIDATES) {
    const t = await run(cfg, entryCandles, htfCandles);
    results.push({ label, cfg, t, netPF: pf(t).net });
    console.log(fmt(label, t));
  }
  const closesCount = r => r.t.filter(x => !x.isPartial).length;
  const best = results.filter(r => closesCount(r) >= 15).sort((a, b) => b.netPF - a.netPF)[0] || results[0];
  console.log(`\n→ Stage 1 winner: ${best.label} (netPF ${best.netPF.toFixed(2)})\n`);

  console.log("── STAGE 2: WALK-FORWARD winner (OOS) ──");
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  // baseline comparison too, so the win/loss is visible per window
  for (const [label, s, e] of WINDOWS) {
    const entry = { Intraday: inWin(all15, s, e), Swing: inWin(all4h, s, e) };
    const htf = { Intraday: inWin(all4h, s, e), Swing: inWin(all1w, s, e) };
    const tBase = await run(makeCfg({}), entry, htf);
    const tBest = await run(best.cfg, entry, htf);
    console.log(fmt(`${label} C0 baseline`, tBase));
    console.log(fmt(`${label} ${best.label.split(" ")[0]} winner`, tBest));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
