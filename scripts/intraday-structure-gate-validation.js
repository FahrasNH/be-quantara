#!/usr/bin/env node
/**
 * INTRADAY STRUCTURE-GATE VALIDATION (AF-SCALP-18, 2026-07-07)
 *
 * Root-cause hypothesis: Intraday (rawB) shares the identical raw signal with
 * Scalping (rawA) — the entry-swap test proved that giving it Scalping's exact
 * CHoCH gate produces 100% trade overlap (not a real leg). What was never
 * tested: giving Intraday its OWN structural confirmation gate, scaled to its
 * actual holding duration (avg 3-8h @ 15m ≈ 12-32 bars) instead of Scalping's
 * fast 5/20-bar CHoCH windows. Implemented as
 * _detectIntradayStructureConfirm() + typeOverrides.Intraday.structureConfirmValidate.
 *
 * This script must answer three things:
 *   1. Does the gate raise WR/PF at all (does it filter toward quality)?
 *   2. Is the resulting trade set actually DIFFERENT from Scalping's (overlap
 *      should be well below 100% — if it converges to 100% again, the gate
 *      just rediscovered the same setups through a wider window).
 *   3. Does the best window survive walk-forward?
 * Usage: node scripts/intraday-structure-gate-validation.js
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
  return `${label.padEnd(48)} n=${String(t.length).padStart(3)} WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}
function overlapPct(a, b) {
  const key = t => t.openTime;
  const setB = new Set(b.map(key));
  if (!a.length) return 0;
  return (a.filter(t => setB.has(key(t))).length / a.length) * 100;
}

function scalpingCfg() {
  const cfg = clone(baseCfg);
  cfg.riskPerTrade = 0.02;
  return cfg;
}

function intradayCfg({ sl = 2.2, tp = 5.5, floorB = 65, window = 40, multiWindow = 10, reversalMin = 3, rangeThreshold = 0.01, gate = true } = {}) {
  const cfg = clone(baseCfg);
  cfg.riskPerTrade = 0.02;
  cfg.sacMinConfidenceB = floorB;
  cfg.typeOverrides.Intraday = {
    slAtrMult: sl, tpAtrMult: tp,
    regimeMappingStrict: false,          // isolate the NEW gate's effect
    structureConfirmValidate: gate,
    intradayStructureWindow: window,
    intradayMultiWindow: multiWindow,
    intradayReversalMin: reversalMin,
    intradayRangeThreshold: rangeThreshold,
    makerEntry: true, makerFeeRate: 0.0002, slippagePct: 0.0002,
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

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 15m + 4h candles…");
  const s4y = Date.UTC(2022, 6, 1);
  const all15 = fetchK("BTCUSDT", "15m", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  console.log(`Loaded ${all15.length} × 15m, ${all4h.length} × 4h\n`);

  const W = [Date.UTC(2025, 6, 1), now];
  const e15 = inWin(all15, ...W), h4h = inWin(all4h, ...W);
  const tScalp = await run(scalpingCfg(), "Scalping", e15, h4h);
  console.log(fmt("Scalping (as-is, reference)", tScalp));

  console.log("\n── STAGE 1: no-gate baseline vs structure-gate window sweep (12mo) ──");
  const noGate = await run(intradayCfg({ gate: false }), "Intraday", e15, h4h);
  console.log(fmt("No gate (regimeMappingStrict off too)", noGate));
  console.log(`  overlap vs Scalping: ${overlapPct(noGate, tScalp).toFixed(1)}%\n`);

  const GRID = [
    { window: 40, multiWindow: 10, reversalMin: 3, rangeThreshold: 0.005 },
    { window: 40, multiWindow: 10, reversalMin: 3, rangeThreshold: 0.01 },
    { window: 60, multiWindow: 15, reversalMin: 4, rangeThreshold: 0.01 },
    { window: 60, multiWindow: 15, reversalMin: 4, rangeThreshold: 0.015 },
    { window: 80, multiWindow: 20, reversalMin: 5, rangeThreshold: 0.015 },
  ];
  const results = [];
  for (const g of GRID) {
    const t = await run(intradayCfg(g), "Intraday", e15, h4h);
    const ov = overlapPct(t, tScalp);
    results.push({ ...g, t, netPF: pf(t).net, overlap: ov });
    console.log(fmt(`window=${g.window} multi=${g.multiWindow} rev>=${g.reversalMin} thr=${(g.rangeThreshold * 100).toFixed(1)}%`, t));
    console.log(`  overlap vs Scalping: ${ov.toFixed(1)}%`);
  }
  const best = results.filter(r => r.t.length >= 15).sort((a, b) => b.netPF - a.netPF)[0] || results[0];
  console.log(`\n→ Stage 1 winner: window=${best.window} multi=${best.multiWindow} rev>=${best.reversalMin} thr=${best.rangeThreshold} (netPF ${best.netPF.toFixed(2)}, overlap ${best.overlap.toFixed(1)}%)\n`);

  console.log("── STAGE 2: confidence floor on winner ──");
  const fRes = [];
  for (const floorB of [60, 65, 70, 75]) {
    const t = await run(intradayCfg({ ...best, floorB }), "Intraday", e15, h4h);
    fRes.push({ floorB, t, netPF: pf(t).net });
    console.log(fmt(`floorB=${floorB}`, t));
  }
  const bestF = fRes.filter(r => r.t.length >= 12).sort((a, b) => b.netPF - a.netPF)[0] || fRes[0];
  console.log(`→ floor pick: ${bestF.floorB}\n`);

  console.log("── STAGE 3: WALK-FORWARD final candidate + overlap check ──");
  const finalCfg = intradayCfg({ ...best, floorB: bestF.floorB });
  console.log(`candidate: window=${best.window} multi=${best.multiWindow} rev>=${best.reversalMin} floorB=${bestF.floorB} SL${best.sl ?? 2.2}/TP${best.tp ?? 5.5}`);
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  for (const [label, s, e] of WINDOWS) {
    const entry = inWin(all15, s, e), htf = inWin(all4h, s, e);
    const tI = await run(finalCfg, "Intraday", entry, htf);
    const tS = await run(scalpingCfg(), "Scalping", entry, htf);
    console.log(fmt(`${label} Intraday`, tI));
    console.log(`  overlap vs Scalping (same window): ${overlapPct(tI, tS).toFixed(1)}%`);
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
