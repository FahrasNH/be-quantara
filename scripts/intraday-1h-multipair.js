#!/usr/bin/env node
/**
 * INTRADAY 1h — multi-pair pooling to raise n on the design-sweep candidate
 * (1d HTF, hardBlock+regimeMap, SL 3.0/TP 6.0 ATR, floorB 75, risk 2%).
 * Question: does the in-sample 1.59 edge generalize once n stops being ~12-15
 * per window, or does it evaporate like a curve-fit would?
 *
 * Runs BTC/ETH/SOL independently per window (position sizing stays per-pair;
 * we are NOT modeling shared-capital contention here, just pooling the trade
 * SAMPLE to see if the win rate / PF pattern holds across more data).
 * Usage: node scripts/intraday-1h-multipair.js
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
  const w = t.filter(x => x.result === "win").length, p = pf(t);
  return `${label.padEnd(34)} n=${String(t.length).padStart(3)} WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

function candidateCfg(symbol) {
  const cfg = clone(baseCfg);
  cfg.sacHtfHardBlock = true;
  cfg.sacMinConfidenceB = 75;
  cfg.riskPerTrade = 0.02;
  cfg.typeOverrides.Intraday = {
    slAtrMult: 3.0, tpAtrMult: 6.0,
    regimeMappingStrict: true,
    sacRejectionEntry: false,
    makerEntry: true, makerFeeRate: 0.0002, slippagePct: 0.0002,
    sacHtfHardBlock: true,
  };
  return cfg;
}

async function run(symbol, entry, htf) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: candidateCfg(symbol), typeOrder: ["Intraday"], naturalTypeOrder: ["Intraday"],
    entryCandles: { Intraday: entry }, htfCandles: { Intraday: htf }, symbol,
  });
  return (res.trades || []).map(t => ({ ...t, _symbol: symbol }));
}

(async () => {
  const now = Date.now();
  const PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
    ["2025-07→2026-07 (in-sample)", Date.UTC(2025, 6, 1), now],
  ];

  const data = {};
  for (const sym of PAIRS) {
    console.log(`Fetching ${sym} 1h + 1d (4yr)…`);
    data[sym] = {
      h1: fetchK(sym, "1h", Date.UTC(2022, 6, 1), now),
      d1: fetchK(sym, "1d", Date.UTC(2022, 6, 1), now),
    };
    console.log(`  ${data[sym].h1.length} × 1h, ${data[sym].d1.length} × 1d`);
  }

  console.log("\n══════════ PER-PAIR, PER-WINDOW ══════════");
  const allByWindow = {};
  for (const [label, s, e] of WINDOWS) {
    console.log(`\n── ${label} ──`);
    allByWindow[label] = [];
    for (const sym of PAIRS) {
      const entry = inWin(data[sym].h1, s, e);
      const htf = inWin(data[sym].d1, s, e);
      if (entry.length < 100) { console.log(`${sym.padEnd(10)} skipped (insufficient candles)`); continue; }
      const t = await run(sym, entry, htf);
      allByWindow[label].push(...t);
      console.log(fmt(sym, t));
    }
    console.log(fmt("POOLED (3 pairs)", allByWindow[label]));
  }

  console.log("\n══════════ POOLED ACROSS ALL 4 WINDOWS (per pair) ══════════");
  for (const sym of PAIRS) {
    const t = Object.values(allByWindow).flat().filter(x => x._symbol === sym);
    console.log(fmt(sym + " (all windows)", t));
  }
  const grand = Object.values(allByWindow).flat();
  console.log(fmt("GRAND TOTAL (3 pairs x 4 windows)", grand));
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
