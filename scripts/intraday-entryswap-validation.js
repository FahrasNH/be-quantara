#!/usr/bin/env node
/**
 * INTRADAY ENTRY-SWAP VALIDATION (2026-07-07)
 *
 * Code fact (SmartMoneyConceptsStrategy.js detectSignalMulti, useSequence=true
 * default): rawA and rawB come from the SAME _detectSMCSequence() call — the
 * only differentiators are (1) CHoCH gate (scalpingChochValidate, A-only),
 * (2) regimeMappingStrict (B-only), (3) confidence floor. So "swap Intraday's
 * entry to component-A logic" = give Intraday the CHoCH gate + asymmetric
 * floor + regimeMappingStrict:false, keep Intraday's OWN SL/TP geometry.
 *
 * Two questions this script must answer:
 *   1. Does entry-swap clear PF 1.2 / beat Scalping-Swing WR? (walk-forward)
 *   2. Is it actually a DIFFERENT trade set from Scalping, or just the same
 *      entries with a different exit (near-100% overlap = no diversification,
 *      just correlated risk stacked on the same signal)?
 * Usage: node scripts/intraday-entryswap-validation.js
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
  return `${label.padEnd(40)} n=${String(t.length).padStart(3)} WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

// Scalping config, run as-is (component A entry gates, proven geometry)
function scalpingCfg() {
  const cfg = clone(baseCfg);
  cfg.riskPerTrade = 0.02;
  return cfg; // typeOverrides.Scalping already has the validated floor 80/75 + SL1.5/TP6.75
}

// Intraday-as-A: same entry gates as Scalping (CHoCH on, regimeMappingStrict
// off, asymmetric floor via sacMinConfidenceALong/AShort) but its OWN SL/TP
// (RR 2.5, from the restructure-sweep winner) run through the "Scalping" type
// slot so it inherits component-A gating, then relabeled Intraday for output.
function entrySwapCfg() {
  const cfg = clone(baseCfg);
  cfg.riskPerTrade = 0.02;
  cfg.typeOverrides.Scalping = {
    ...cfg.typeOverrides.Scalping,
    slAtrMult: 2.2, tpAtrMult: 5.5, // Intraday's own RR2.5 geometry
  };
  return cfg;
}

async function run(cfg, type, entry, htf) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, typeOrder: [type], naturalTypeOrder: [type],
    entryCandles: { [type]: entry }, htfCandles: { [type]: htf }, symbol: "BTCUSDT",
  });
  return res.trades || [];
}

function overlapPct(a, b) {
  const setB = new Set(b.map(t => t.entryTime || t.openTime || JSON.stringify([t.side, t.entryPrice])));
  const key = t => t.entryTime || t.openTime || JSON.stringify([t.side, t.entryPrice]);
  if (!a.length) return 0;
  const hits = a.filter(t => setB.has(key(t))).length;
  return (hits / a.length) * 100;
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 15m + 4h candles…");
  const s4y = Date.UTC(2022, 6, 1);
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  console.log(`Loaded ${all15.length} × 15m, ${all4h.length} × 4h\n`);

  const W = [Date.UTC(2025, 6, 1), now];
  const e15 = inWin(all15, ...W), h4h = inWin(all4h, ...W);

  console.log("── 12mo comparison ──");
  const tScalp = await run(scalpingCfg(), "Scalping", e15, h4h);
  console.log(fmt("Scalping (as-is, RR4.5)", tScalp));
  const tSwap = await run(entrySwapCfg(), "Scalping", e15, h4h); // ran via Scalping slot, own SL/TP
  console.log(fmt("Intraday entry-swap (RR2.5)", tSwap));
  console.log(`Trade-entry overlap (swap vs Scalping): ${overlapPct(tSwap, tScalp).toFixed(1)}% of swap trades share an entry timestamp with Scalping\n`);

  console.log("── WALK-FORWARD entry-swap candidate (OOS) ──");
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  for (const [label, s, e] of WINDOWS) {
    const entry = inWin(all15, s, e), htf = inWin(all4h, s, e);
    const tS = await run(scalpingCfg(), "Scalping", entry, htf);
    const tI = await run(entrySwapCfg(), "Scalping", entry, htf);
    console.log(fmt(`${label} Scalping`, tS));
    console.log(fmt(`${label} Intraday-swap`, tI));
    console.log(`  overlap: ${overlapPct(tI, tS).toFixed(1)}%`);
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
