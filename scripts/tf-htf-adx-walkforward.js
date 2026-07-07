#!/usr/bin/env node
/**
 * TS_TF LAYER-1 ROBUSTNESS SWEEP (AF-SCALP-24 stage 3, 2026-07-07)
 *
 * Stage-2 result: aligned Layer 1 + engine ADX gate turned 12mo from PF 0.83
 * (net -90.5) to PF 1.29 (net +64.6) at ADX30. Before shipping a default,
 * verify the ADX threshold is not an in-sample artifact: run ADX25 vs ADX30,
 * each with/without the daily strong-trend gate, across ALL windows.
 * Run: node scripts/tf-htf-adx-walkforward.js
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
  atrMult: 1.3, riskReward: 1.92, tpMode: "full",
};

async function run(cfg, candles) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: true, enableSlippage: true,
    config: { ...BASE, ...cfg }, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles: candles.entry, htfCandles: candles.htf, dailyCandles: candles.daily,
    symbol: "BTCUSDT",
  }, ["Intraday", "Swing"]);
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr candles (BTCUSDT)…");
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

  const VARIANTS = [
    ["ADX25", { adxMinStrength: 25 }],
    ["ADX30", { adxMinStrength: 30 }],
    ["ADX25+strongDay", { adxMinStrength: 25, tfRequireStrongTrend: true }],
    ["ADX30+strongDay", { adxMinStrength: 30, tfRequireStrongTrend: true }],
  ];
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
    ["2025-07→now (12mo eval)", Date.UTC(2025, 6, 1), now],
  ];

  const totals = new Map(VARIANTS.map(([k]) => [k, { pnl: 0, wins: 0 }]));
  for (const [wl, s, e] of WINDOWS) {
    console.log(`── ${wl} ──`);
    const wdat = win(s, e);
    for (const [vl, cfg] of VARIANTS) {
      const t = await run(cfg, wdat);
      console.log(row(vl, t));
      const p = pf(t);
      const agg = totals.get(vl);
      agg.pnl += p.pnl;
      if (p.net >= 1.0) agg.wins += 1;
    }
    console.log("");
  }
  console.log("── SUMMARY (4 windows) ──");
  for (const [vl, agg] of totals) {
    console.log(`${vl.padEnd(20)} windows PF>=1.0: ${agg.wins}/4   total net: ${agg.pnl.toFixed(1)}`);
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
