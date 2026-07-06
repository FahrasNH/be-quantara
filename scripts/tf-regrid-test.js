#!/usr/bin/env node
/**
 * TF re-grid proposal test (user question 2026-07-06):
 *   1) Scalping → 1m entry: does the proven-profitable 15m config survive at 1m?
 *      (3mo window — 1m data is heavy; directional read, plus ATR/fee R-math)
 *   2) Intraday re-spec candidate → 1h entry / 4h HTF with Scalping's proven
 *      execution config (maker fees, slippage 2bps, CHoCH on, floor 80/75) — 12mo.
 * Usage: node scripts/tf-regrid-test.js
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
function pf(t) { let gp = 0, gl = 0; for (const x of t) { if (x.pnl >= 0) gp += x.pnl; else gl += -x.pnl; } return { net: gl ? gp / gl : (gp > 0 ? Infinity : 0), pnl: gp - gl }; }
function row(label, t) {
  const w = t.filter(x => x.result === "win").length, p = pf(t);
  return `${label.padEnd(40)} n=${String(t.length).padStart(3)}  WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}%  netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"}  net=${p.pnl.toFixed(1)}`;
}
// simple ATR(14) on candle array for fee math
function atrPctStats(candles) {
  const n = candles.length; if (n < 20) return null;
  let atr = null; const period = 14; const vals = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close));
    atr = atr == null ? tr : (atr * (period - 1) + tr) / period;
    if (i > 100) vals.push(atr / candles[i].close * 100);
  }
  vals.sort((a, b) => a - b);
  return { median: vals[Math.floor(vals.length / 2)], p25: vals[Math.floor(vals.length * 0.25)] };
}

(async () => {
  const now = Date.now();

  // ── Test 1: 1m entry (3mo) with the proven Scalping config ────────────────
  console.log("Fetching 3mo of 1m candles (heavy)…");
  const s3 = now - 90 * 864e5;
  const c1m = fetchK("BTCUSDT", "1m", s3, now);
  const c1h = fetchK("BTCUSDT", "1h", s3, now);
  console.log(`Loaded ${c1m.length} × 1m, ${c1h.length} × 1h`);

  const a1 = atrPctStats(c1m);
  if (a1) {
    const slPct = 2.2 * a1.median;              // SL distance as % of price
    const feeRt = 0.02 + 0.06;                  // maker in + taker SL out (bps→%): 0.02%+0.06%
    const feeAsR = (feeRt + 0.02) / slPct;      // + slippage 2bps, in R units
    console.log(`1m ATR median=${a1.median.toFixed(4)}% → SL dist=${slPct.toFixed(3)}% → fee+slip ≈ ${feeAsR.toFixed(2)}R per trade`);
  }

  const cfg1m = clone(baseCfg);
  console.log(row("Scalping cfg @ 1m entry / 1h HTF (3mo)", await runT(cfg1m, "Scalping", c1m, c1h)));

  // Also floor-60 variant so low n from the 80/75 floor doesn't hide the signal
  const cfg1mLoose = clone(baseCfg);
  delete cfg1mLoose.typeOverrides.Scalping.sacMinConfidenceALong;
  delete cfg1mLoose.typeOverrides.Scalping.sacMinConfidenceAShort;
  console.log(row("  same @ floor 60 (volume probe)", await runT(cfg1mLoose, "Scalping", c1m, c1h)));

  // ── Test 2: Intraday re-spec candidate — 1h entry / 4h HTF, 12mo ──────────
  console.log("\nFetching 12mo of 1h + 4h…");
  const s12 = Date.UTC(2025, 6, 1);
  const e1h = fetchK("BTCUSDT", "1h", s12, now);
  const e4h = fetchK("BTCUSDT", "4h", s12, now);
  console.log(`Loaded ${e1h.length} × 1h, ${e4h.length} × 4h`);

  // candidate: Scalping's proven execution config transplanted to the Intraday leg
  const cand = clone(baseCfg);
  cand.typeOverrides.Intraday = {
    ...cand.typeOverrides.Scalping,       // maker fees, slippage 2bps, choch on, RR 2.0 SL/TP
    regimeMappingStrict: true,            // keep (now uses REAL 4h trend post AF-SCALP-17)
  };
  cand.sacMinConfidenceB = 75;            // floor parity with the validated Scalping floor
  console.log(row("Intraday re-spec @ 1h/4h + Scalping exec", await runT(cand, "Intraday", e1h, e4h)));

  const candLoose = clone(cand); candLoose.sacMinConfidenceB = 60;
  console.log(row("  same @ floor 60 (volume probe)", await runT(candLoose, "Intraday", e1h, e4h)));

  async function runT(cfg, type, entry, htf) {
    const res = await runTripleTypeBacktest({
      strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
      config: cfg, typeOrder: [type], naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
      entryCandles: { [type]: entry }, htfCandles: { [type]: htf }, symbol: "BTCUSDT",
    });
    return res.trades || [];
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
