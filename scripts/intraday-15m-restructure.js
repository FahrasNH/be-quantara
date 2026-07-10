#!/usr/bin/env node
/**
 * INTRADAY 15m RESTRUCTURE TEST — driven by intra.csv forensics (2026-07-07):
 *   - NO trade subset is profitable (best conf bucket 0.84, SHORT-only 0.85)
 *     → filtering cannot fix the leg; only structural changes can.
 *   - Confidence is ANTI-predictive for component B (65-69 best, 75-79 worst)
 *     → floor raises are the WRONG lever here (opposite of Scalping/component A).
 *   - Exec drag 0.31R per SL (taker + 0.05% slip on tight 1.5xATR stops).
 *   - dur<1h class: WR 7.7% → tight-stop noise deaths.
 * Hypothesis: maker exec + wider SL (proven direction at 1h) lifts WR/PF.
 * Stage 1: exec + SL/TP geometry sweep on 12mo. Stage 2: walk-forward winner.
 * Usage: node scripts/intraday-15m-restructure.js
 */
const { execSync } = require("child_process");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const baseCfg = require("/tmp/af_smc_config.json");
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
const clone = o => JSON.parse(JSON.stringify(o));
const inWin = (arr, s, e) => arr.filter(c => c.timestamp >= s && c.timestamp < e);
function pf(t) { let gp = 0, gl = 0; for (const x of t) { if (x.pnl >= 0) gp += x.pnl; else gl += -x.pnl; } return { net: gl ? gp / gl : (gp > 0 ? Infinity : 0), pnl: gp - gl }; }
function fmt(label, t) {
  const w = t.filter(x => x.result === "win").length;
  const L = t.filter(x => x.side === "LONG").length, S = t.filter(x => x.side === "SHORT").length;
  const p = pf(t);
  return `${label.padEnd(46)} n=${String(t.length).padStart(3)} (${L}L/${S}S) WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

function mkCfg({ maker = true, sl = 1.5, tp = 3.75, floorB = 65 } = {}) {
  const cfg = clone(baseCfg);
  cfg.sacMinConfidenceB = floorB;
  cfg.riskPerTrade = 0.02;
  cfg.typeOverrides.Intraday = {
    slAtrMult: sl, tpAtrMult: tp,
    regimeMappingStrict: true,
    sacRejectionEntry: false,
    ...(maker ? { makerEntry: true, makerFeeRate: 0.0002, slippagePct: 0.0002 } : {}),
  };
  return cfg;
}

async function run(cfg, entry, htf) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, typeOrder: ["Intraday"], naturalTypeOrder: ["Intraday"],
    entryCandles: { Intraday: entry }, htfCandles: { Intraday: htf }, symbol: "BTCUSDT",
  });
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 15m + 4h candles (15m is heavy, ~140 pages)…");
  const s4y = Date.UTC(2022, 6, 1);
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  console.log(`Loaded ${all15.length} × 15m, ${all4h.length} × 4h\n`);

  const W = [Date.UTC(2025, 6, 1), now];
  const e15 = inWin(all15, ...W), h4h = inWin(all4h, ...W);

  console.log("── STAGE 1: exec + SL/TP geometry (12mo, floor 65) ──");
  const RUNS = [
    ["S0 baseline (taker, SL1.5/TP3.75) = CSV repro", mkCfg({ maker: false })],
    ["S1 + maker exec only", mkCfg({})],
    ["S2 maker + SL2.2/TP5.5  (RR2.5)", mkCfg({ sl: 2.2, tp: 5.5 })],
    ["S3 maker + SL3.0/TP7.5  (RR2.5)", mkCfg({ sl: 3.0, tp: 7.5 })],
    ["S4 maker + SL2.2/TP4.4  (RR2.0)", mkCfg({ sl: 2.2, tp: 4.4 })],
    ["S5 maker + SL3.0/TP6.0  (RR2.0)", mkCfg({ sl: 3.0, tp: 6.0 })],
    ["S6 maker + SL3.0/TP9.0  (RR3.0)", mkCfg({ sl: 3.0, tp: 9.0 })],
  ];
  const results = [];
  for (const [label, cfg] of RUNS) {
    const t = await run(cfg, e15, h4h);
    results.push({ label, cfg, t, netPF: pf(t).net });
    console.log(fmt(label, t));
  }
  const best = results.slice(1).filter(r => r.t.length >= 25).sort((a, b) => b.netPF - a.netPF)[0];
  console.log(`→ Stage 1 winner: ${best.label}\n`);

  // floor probe on winner — forensics say low-conf is BETTER for component B,
  // so test loosening (60) alongside the current 65, NOT raising.
  console.log("── STAGE 1b: floor probe on winner (60 vs 65 vs 70) ──");
  const geo = best.cfg.typeOverrides.Intraday;
  let bestFloor = { floorB: 65, netPF: best.netPF, t: best.t };
  for (const floorB of [60, 70]) {
    const t = await run(mkCfg({ sl: geo.slAtrMult, tp: geo.tpAtrMult, floorB }), e15, h4h);
    console.log(fmt(`floorB=${floorB}`, t));
    const n = pf(t).net;
    if (t.length >= 25 && n > bestFloor.netPF) bestFloor = { floorB, netPF: n, t };
  }
  console.log(fmt(`floorB=65 (winner geometry)`, best.t));
  console.log(`→ floor pick: ${bestFloor.floorB}\n`);

  console.log("── STAGE 2: WALK-FORWARD winner (OOS) ──");
  const finalCfg = mkCfg({ sl: geo.slAtrMult, tp: geo.tpAtrMult, floorB: bestFloor.floorB });
  console.log(`candidate: maker + SL${geo.slAtrMult}/TP${geo.tpAtrMult} floorB=${bestFloor.floorB}`);
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  for (const [label, s, e] of WINDOWS) {
    const t = await run(finalCfg, inWin(all15, s, e), inWin(all4h, s, e));
    console.log(fmt(label, t));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
