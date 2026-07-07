#!/usr/bin/env node
/**
 *
 * User question: "is something wrong with the Entry, TP, or SL?" — answered by
 * measuring TOUCH PROBABILITIES with fees OFF, so the numbers are pure
 * price-path quality, not execution drag:
 *   WR(fees off, tpMode=full) = P(TP touched before SL) per geometry.
 *   Random-walk baseline for RR=k is 1/(1+k). Entry has directional edge at
 *   horizon k only if measured WR > 1/(1+k).
 *
 * Verdict logic:
 *   - WR ≈ random at ALL geometries        → ENTRY problem (no edge, geometry can't fix)
 *   - WR > random at low RR, < at high RR  → TP too far (edge decays; bring TP in)
 *   - widening SL lifts WR ABOVE random    → SL too tight (noise-stops; widen SL)
 *
 * before it, slAtrMult/tpAtrMult never reached TF (dead knobs, constructor
 * defaults 1.5/3.0 always used — every row in the 12mo CSV shows RR 2.0).
 *
 * Stage A: RR sweep at SL 1.5×ATR (entry-quality curve vs random)
 * Stage B: SL sweep at RR 2 (noise-stop diagnosis)
 * Stage C: best geometry, production config (fees ON, tpMode=partial as shipped)
 *          + walk-forward vs current default geometry.
 * Usage: node scripts/tf-geometry-diagnostic.js
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

function cfgGeom(sl, tp, { tpMode = "full" } = {}) {
  // slAtrMult/tpAtrMult flow: runMultiTypeBacktest merges typeOverrides[leg]
  // to the top level; engine passes them as opts.slMultiplier/tpMultiplier

  return { ...BASE, tpMode, slAtrMult: sl, tpAtrMult: tp };
}

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
  const edge = (wr - rand) * 100;
  const rrSeen = closes[0]?.plannedRR ?? "?";
  return `${label.padEnd(30)} n=${String(closes.length).padStart(3)} plannedRR=${rrSeen} P(TP first)=${(wr * 100).toFixed(1)}% random=${(rand * 100).toFixed(1)}% edge=${edge >= 0 ? "+" : ""}${edge.toFixed(1)}pp`;
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
  const entry12 = { Intraday: inWin(all15, ...W), Swing: inWin(all4h, ...W) };
  const htf12 = { Intraday: inWin(all4h, ...W), Swing: inWin(all1w, ...W) };

  console.log("── STAGE A: RR sweep @ SL 1.5×ATR (fees OFF — pure path quality) ──");
  for (const rr of [1, 1.5, 2, 3]) {
    const t = await run(cfgGeom(1.5, 1.5 * rr), entry12, htf12);
    console.log(diagRow(`A RR=${rr} (TP ${(1.5 * rr).toFixed(1)}×ATR)`, t, rr));
  }

  console.log("\n── STAGE B: SL sweep @ RR 2 (fees OFF — noise-stop diagnosis) ──");
  for (const sl of [1.0, 1.3, 2.0, 2.6]) {
    const t = await run(cfgGeom(sl, sl * 2), entry12, htf12);
    console.log(diagRow(`B SL=${sl}×ATR (TP ${(sl * 2).toFixed(1)})`, t, 2));
  }

  console.log("\n── STAGE C: production check (fees ON, tpMode=partial as shipped) ──");
  console.log("Fill in after reading A/B — this run uses the current default geometry");
  const tDef = await run(cfgGeom(1.5, 3.0, { tpMode: "partial" }), entry12, htf12, { fees: true });
  const pDef = pf(tDef);
  console.log(`C0 default SL1.5/TP3.0 partial      netPF=${pDef.net.toFixed(2)} net=${pDef.pnl.toFixed(1)} legs=${tDef.length}`);
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
