#!/usr/bin/env node
/**
 * TS_TF GEOMETRY STAGE 3 — clean re-run of the tight-SL RR curve.
 * Stage-2's A2 forgot to force tpMode:"full"; the base config's "partial"
 * leaked in, so its "wins" included +0.35R trail-outs and the curve read
 * flat across TP distances (impossible for true touch rates). This re-run
 * pins tpMode:"full" + fees OFF: WR = pure P(TP before SL).
 * Usage: node scripts/tf-geometry-stage3.js
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
const BASE = { emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70, riskPerTrade: 0.03, htfTrendStrengthMin: 0.65, capital: 1000 };
(async () => {
  const now = Date.now();
  const s4y = Date.UTC(2025, 6, 1);
  console.log("Fetching 12mo of 15m + 4h + 1w…");
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  const all1w = fetchK("BTCUSDT", "1w", s4y, now);
  console.log(`Loaded ${all15.length} × 15m, ${all4h.length} × 4h, ${all1w.length} × 1w\n`);
  const e12 = { Intraday: all15, Swing: all4h };
  const h12 = { Intraday: all4h, Swing: all1w };
  for (const sl of [1.0, 1.3]) {
    for (const rr of [1.5, 2, 2.5, 3]) {
      const res = await runMultiTypeBacktest({
        strategyKey: "TS_TF", capital: 1000, enableFees: false, enableSlippage: false,
        config: { ...BASE, tpMode: "full", slAtrMult: sl, tpAtrMult: sl * rr },
        naturalTypeOrder: ["Intraday", "Swing"], entryCandles: e12, htfCandles: h12, symbol: "BTCUSDT",
      }, ["Intraday", "Swing"]);
      const t = (res.trades || []).filter(x => !x.isPartial);
      const w = t.filter(x => x.result === "win").length;
      const wr = t.length ? w / t.length : 0, rand = 1 / (1 + rr);
      console.log(`SL=${sl} RR=${rr}`.padEnd(16) + `n=${String(t.length).padStart(3)} plannedRR=${t[0]?.plannedRR} P(TP first)=${(wr * 100).toFixed(1)}% random=${(rand * 100).toFixed(1)}% edge=${((wr - rand) * 100) >= 0 ? "+" : ""}${((wr - rand) * 100).toFixed(1)}pp`);
    }
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
