#!/usr/bin/env node
/**
 * TS_TF LADDER A/B v2 — HTF-warmup-correct (2026-07-08)
 *
 * v1 flaw: window slicing cut the HTF (1w) series too, so Swing's Layer 1
 * (EMA50 on 1w = 50-WEEK warmup) was dead for the first year of every window
 * and fell back to a mixed-frame check (1w EMA9/21 vs 4h EMA50). v2 slices
 * ONLY the entry candles per window; HTF/daily keep full history from a year
 * before the window (htfPtr time-aligns, so pre-window HTF history is correct,
 * not lookahead).
 *
 * Parity hypothesis: the user's CSVs (all-type-6y / swing-6y / intra-599d)
 * were generated on a PRE-AF-SCALP-24 build (no Layer-1/ADX gate): the June-
 * 2026 chop cluster in intra-599d matches yesterday's pre-fix run signature.
 * P1/P2 verify by running Layer-1 OFF.
 *
 * Run: node scripts/tf-ladder-6y-ab2.js
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
  return `${label.padEnd(44)} pos=${String(closes.length).padStart(3)} WR=${closes.length ? (w / closes.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

const BASE = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70,
  riskPerTrade: 0.03, htfTrendStrengthMin: 0.65, capital: 1000,
  atrMult: 1.3, riskReward: 1.92,
};

async function runLeg(leg, cfg, entry, htf, daily) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles: { [leg]: entry }, htfCandles: { [leg]: htf },
    dailyCandles: daily, symbol: "BTCUSDT",
  }, [leg]);
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching: 1w+1d from 2019-01, 4h from 2019-07, 15m 625d (BTCUSDT)…");
  const all1w = fetchK("BTCUSDT", "1w", Date.UTC(2019, 0, 1), now);
  const all1d = fetchK("BTCUSDT", "1d", Date.UTC(2019, 0, 1), now);
  const all4h = fetchK("BTCUSDT", "4h", Date.UTC(2019, 6, 1), now);
  const all15 = fetchK("BTCUSDT", "15m", now - 625 * 86400_000, now);
  console.log(`Loaded ${all1w.length}×1w ${all1d.length}×1d ${all4h.length}×4h ${all15.length}×15m\n`);

  // Entry sliced per window; HTF gets FULL history (time-aligned via htfPtr).
  const s6y = Date.UTC(2020, 6, 1);
  const s599 = now - 599 * 86400_000;

  console.log("── PARITY (Layer-1 OFF ≈ user's pre-AF-SCALP-24 CSVs) ──");
  const p1 = await runLeg("Swing", { ...BASE, tpMode: "full", tfHtfLayerEnabled: false }, inWin(all4h, s6y, now), all1w, all1d);
  console.log(row("P1 Swing 6y full, L1 OFF (CSV: 16pos +16.7)", p1));
  const p2 = await runLeg("Intraday", { ...BASE, tpMode: "full", tfHtfLayerEnabled: false }, inWin(all15, s599, now), all4h, all1d);
  console.log(row("P2 Intra 599d full, L1 OFF (CSV: 31pos -39.3)", p2));

  console.log("\n── SWING 6y, Layer-1 ON (proper 1w warmup) ──");
  const SWING = [
    ["S1 full TP", { ...BASE, tpMode: "full" }],
    ["S0 partial m1R=1.0", { ...BASE, tpMode: "partial" }],
    ["S2 partial m1R=1.5", { ...BASE, tpMode: "partial", slPlusM1R: 1.5 }],
    ["S3 full + RR2.2", { ...BASE, tpMode: "full", riskReward: 2.2 }],
  ];
  for (const [label, cfg] of SWING) {
    const t = await runLeg("Swing", cfg, inWin(all4h, s6y, now), all1w, all1d);
    console.log(row(label, t));
  }

  console.log("\n── INTRADAY 625d, Layer-1 ON, walk-forward 3×~208d ──");
  const W = [];
  const s625 = now - 625 * 86400_000;
  for (let k = 0; k < 3; k++) W.push([`W${k + 1}`, s625 + k * 208 * 86400_000, k === 2 ? now : s625 + (k + 1) * 208 * 86400_000]);
  const INTRA = [
    ["I0 full", { ...BASE, tpMode: "full" }],
    ["I1 partial m1R=1.0", { ...BASE, tpMode: "partial" }],
    ["I2 partial m1R=1.5", { ...BASE, tpMode: "partial", slPlusM1R: 1.5 }],
  ];
  for (const [label, cfg] of INTRA) {
    console.log(`· ${label}`);
    const pfs = [];
    for (const [wl, s, e] of W) {
      const t = await runLeg("Intraday", cfg, inWin(all15, s, e), all4h, all1d);
      console.log(row(`   ${wl}`, t));
      pfs.push(pf(t).net);
    }
    console.log(`   → ${pfs.every(x => x >= 1.0) ? "PASS ALL" : "mixed"} (${pfs.map(x => x.toFixed(2)).join(", ")})`);
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
