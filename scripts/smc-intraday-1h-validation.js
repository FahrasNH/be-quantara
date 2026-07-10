#!/usr/bin/env node
/**
 * AF_SMC INTRADAY-1h VALIDATION (2026-07-08)
 *
 * Intraday was hidden because it ran on the SAME candles as Scalping (both
 * 15m entry / 4h trend) — 100% entry overlap, not a genuinely different leg.
 * This harness tests the v3.1-doc proposal: move Intraday to 1h entry / 4h
 * confirm, which is a real signal-source change (unlike the 1h redesign
 * tested previously on TS_TF's OWN entry logic — this is AF_SMC's sequence
 * engine running on 1h candles for the first time).
 *
 * Re-enable bar (same standard as TS_TF's AF-SCALP-24 gate): netPF >= 1.0 in
 * ALL walk-forward windows, not just the 12mo eval window (avoid shipping an
 * in-sample artifact).
 *
 * Variants:
 *   V0 baseline   — Intraday@1h, no ADX gate, ladder default (1R/2R)
 *   V1 +ADX20     — entry-TF ADX >= 20 chop gate (spec: "ADX 1h > 20")
 *   V2 +ADX25     — stricter chop gate
 *   V3 +ladder    — V1 + ladder 40%@1.5R / 30%@2.5R (spec Intraday exit)
 *
 * Run: node scripts/smc-intraday-1h-validation.js
 */
const { execSync } = require("child_process");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
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
  return `${label.padEnd(38)} pos=${String(closes.length).padStart(3)} WR=${closes.length ? (w / closes.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

async function run(cfg, candles) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, typeOrder: ["Intraday"], naturalTypeOrder: ["Intraday"],
    entryCandles: { Intraday: candles.entry }, htfCandles: { Intraday: candles.htf },
    dailyCandles: candles.daily, symbol: "BTCUSDT",
  });
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 1h + 4h + 1d candles (BTCUSDT)…");
  const s4y = Date.UTC(2022, 6, 1);
  const all1h = fetchK("BTCUSDT", "1h", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  const all1d = fetchK("BTCUSDT", "1d", s4y, now);
  console.log(`Loaded ${all1h.length}×1h ${all4h.length}×4h ${all1d.length}×1d\n`);

  const win = (s, e) => ({ entry: inWin(all1h, s, e), htf: inWin(all4h, s, e), daily: inWin(all1d, s, e) });
  const W12 = win(Date.UTC(2025, 6, 1), now);

  const BASE = {
    emaFast: 9, emaSlow: 21, rsiPeriod: 14, capital: 1000,
    riskPerTrade: 0.02, tpMode: "full",
  };

  console.log("── STAGE 1: candidates (12mo, fees+slip ON) ──");
  const CANDS = [
    ["V0 baseline (no ADX gate)", BASE],
    ["V1 +ADX20 chop gate", { ...BASE, typeOverrides: { Intraday: { minAdx: 20 } } }],
    ["V2 +ADX25 chop gate", { ...BASE, typeOverrides: { Intraday: { minAdx: 25 } } }],
    ["V3 ADX20+ladder1.5/2.5R", {
      ...BASE, tpMode: "partial",
      typeOverrides: { Intraday: { minAdx: 20 } },
      slPlusM1R: 1.5, slPlusM2R: 2.5,
    }],
  ];
  const results = [];
  for (const [label, cfg] of CANDS) {
    const t = await run(cfg, W12);
    results.push({ label, cfg, t, netPF: pf(t).net, n: t.filter(x => !x.isPartial).length });
    console.log(row(label, t));
  }
  const viable = results.filter(r => r.n >= 8).sort((a, b) => b.netPF - a.netPF);
  const best = viable[0] || results[0];
  console.log(`\n→ Stage 1 best: ${best.label}\n`);

  console.log("── STAGE 2: WALK-FORWARD best vs baseline (V0) ──");
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  const allPass = { v0: [], best: [] };
  for (const [label, s, e] of WINDOWS) {
    const wdat = win(s, e);
    const t0 = await run(BASE, wdat);
    const tb = await run(best.cfg, wdat);
    console.log(row(`${label} V0`, t0));
    console.log(row(`${label} ${best.label.split(" ")[0]}`, tb));
    allPass.v0.push(pf(t0).net);
    allPass.best.push(pf(tb).net);
  }
  console.log("\n── VERDICT (re-enable requires netPF>=1.0 in ALL windows) ──");
  console.log(`V0 windows: ${allPass.v0.map(x => x.toFixed(2)).join(", ")} → ${allPass.v0.every(x => x >= 1.0) ? "PASS" : "FAIL"}`);
  console.log(`${best.label} windows: ${allPass.best.map(x => x.toFixed(2)).join(", ")} → ${allPass.best.every(x => x >= 1.0) ? "PASS" : "FAIL"}`);
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
