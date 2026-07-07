#!/usr/bin/env node
/**
 * Stage 1 verdict: at RR2, SL 1.0×ATR (+5.0pp) and 1.3×ATR (+4.9pp) beat random;
 * the buggy always-on default 1.5×ATR is edge-free at every RR. The intended
 * config (atrMult 1.3) was right all along — the dead knob was discarding it.
 *
 * A2: RR sweep at SL 1.0 and 1.3 (fees OFF) — locate best TP on the tight-SL curve.
 * C : production runs (fees ON, tpMode=partial AS DESIGNED — partial stays, it is
 *     the touch-rate diagnostic + live profit-locking mode) for candidate
 *     geometries, walk-forward 4 windows vs the buggy default.
 * Usage: node scripts/tf-geometry-stage2.js
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

const BASE = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70,
  riskPerTrade: 0.03, htfTrendStrengthMin: 0.65, capital: 1000,
};
const geom = (sl, tp, extra = {}) => ({ ...BASE, slAtrMult: sl, tpAtrMult: tp, ...extra });

async function run(cfg, entryCandles, htfCandles, { fees = false } = {}) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: fees, enableSlippage: fees,
    config: cfg, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles, htfCandles, symbol: "BTCUSDT",
  }, ["Intraday", "Swing"]);
  return res.trades || [];
}

function diagRow(label, t, rr) {
  const closes = t.filter(x => !x.isPartial);
  const w = closes.filter(x => x.result === "win").length;
  const wr = closes.length ? w / closes.length : 0;
  const rand = 1 / (1 + rr);
  return `${label.padEnd(34)} n=${String(closes.length).padStart(3)} P(TP first)=${(wr * 100).toFixed(1)}% random=${(rand * 100).toFixed(1)}% edge=${((wr - rand) * 100) >= 0 ? "+" : ""}${((wr - rand) * 100).toFixed(1)}pp`;
}
function prodRow(label, t) {
  const closes = t.filter(x => !x.isPartial);
  const w = closes.filter(x => x.result === "win").length;
  const p = pf(t);
  return `${label.padEnd(44)} pos=${String(closes.length).padStart(3)} posWR=${closes.length ? (w / closes.length * 100).toFixed(1) : "0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
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
  const e12 = { Intraday: inWin(all15, ...W), Swing: inWin(all4h, ...W) };
  const h12 = { Intraday: inWin(all4h, ...W), Swing: inWin(all1w, ...W) };

  console.log("── STAGE A2: RR sweep on tight SL (fees OFF) ──");
  for (const sl of [1.0, 1.3]) {
    for (const rr of [1.5, 2, 2.5, 3]) {
      const t = await run(geom(sl, sl * rr), e12, h12);
      console.log(diagRow(`A2 SL=${sl} RR=${rr}`, t, rr));
    }
  }

  console.log("\n── STAGE C: production (fees ON, tpMode=partial) — 12mo ──");
  const CANDS = [
    ["C-def SL1.5/TP3.0 (buggy default)", geom(1.5, 3.0, { tpMode: "partial" })],
    ["C1 SL1.3/TP2.6 (intended config)", geom(1.3, 2.6, { tpMode: "partial" })],
    ["C2 SL1.0/TP2.0", geom(1.0, 2.0, { tpMode: "partial" })],
    ["C3 SL1.3/TP2.6 + maker", geom(1.3, 2.6, { tpMode: "partial", makerEntry: true, makerFeeRate: 0.0002 })],
    ["C4 SL1.0/TP2.0 + maker", geom(1.0, 2.0, { tpMode: "partial", makerEntry: true, makerFeeRate: 0.0002 })],
  ];
  const results = [];
  for (const [label, cfg] of CANDS) {
    const t = await run(cfg, e12, h12, { fees: true });
    results.push({ label, cfg, t, netPF: pf(t).net });
    console.log(prodRow(label, t));
  }
  const best = results.slice(1).sort((a, b) => b.netPF - a.netPF)[0];
  console.log(`\n→ best candidate: ${best.label}\n`);

  console.log("── WALK-FORWARD best vs buggy default (fees ON, partial) ──");
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  for (const [label, s, e] of WINDOWS) {
    const entry = { Intraday: inWin(all15, s, e), Swing: inWin(all4h, s, e) };
    const htf = { Intraday: inWin(all4h, s, e), Swing: inWin(all1w, s, e) };
    const tD = await run(geom(1.5, 3.0, { tpMode: "partial" }), entry, htf, { fees: true });
    const tB = await run(best.cfg, entry, htf, { fees: true });
    console.log(prodRow(`${label} default`, tD));
    console.log(prodRow(`${label} ${best.label.split(" ")[0]}`, tB));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
