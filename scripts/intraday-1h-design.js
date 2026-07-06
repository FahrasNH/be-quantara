#!/usr/bin/env node
/**
 * INTRADAY 1h LEG DESIGN SWEEP (analysis only — nothing ships from here).
 * User constraints: entry 1h (fixed), risk 2% (fixed), target netPF > 1.2.
 * Staged search to limit multiple-comparison overfit:
 *   A: HTF source (4h vs 1d) × gates (hard block, regime map, rejection, choch-via-Scalping-path)
 *   B: SL/TP ATR grid on stage-A winner
 *   C: confidence floor sweep (incl. asymmetric) on stage-B winner
 *   D: walk-forward the final candidate on 3 out-of-sample yearly windows
 * Usage: node scripts/intraday-1h-design.js
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
  const L = t.filter(x => x.side === "LONG").length, S = t.filter(x => x.side === "SHORT").length;
  return `${label.padEnd(44)} n=${String(t.length).padStart(3)} (${L}L/${S}S) WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

// Base Intraday candidate: maker execution (strictly cheaper), rejection OFF,
// Scalping-proven SL/TP as starting point, floor 60 during structure search.
function mkCfg({ htf = "4h", hardBlock = true, regimeMap = true, rejection = false, sl = 2.2, tp = 4.4, floorB = 60 } = {}) {
  const cfg = clone(baseCfg);
  cfg.sacHtfHardBlock = hardBlock;
  cfg.sacMinConfidenceB = floorB;
  cfg.riskPerTrade = 0.02; // user constraint: 2%
  cfg.typeOverrides.Intraday = {
    slAtrMult: sl, tpAtrMult: tp,
    regimeMappingStrict: regimeMap,
    sacRejectionEntry: rejection,
    makerEntry: true, makerFeeRate: 0.0002, slippagePct: 0.0002,
    sacHtfHardBlock: hardBlock,
  };
  return cfg;
}

async function run(cfg, type, entry, htf) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, typeOrder: [type], naturalTypeOrder: [type], // leg gets FULL 2%
    entryCandles: { [type]: entry }, htfCandles: { [type]: htf }, symbol: "BTCUSDT",
  });
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 4yr of 1h/4h/1d candles…");
  const s4y = Date.UTC(2022, 6, 1);
  const all1h = fetchK("BTCUSDT", "1h", s4y, now);
  const all4h = fetchK("BTCUSDT", "4h", s4y, now);
  const all1d = fetchK("BTCUSDT", "1d", s4y, now);
  console.log(`Loaded ${all1h.length} × 1h, ${all4h.length} × 4h, ${all1d.length} × 1d\n`);

  const W = [Date.UTC(2025, 6, 1), now]; // main design window (12mo)
  const e1h = inWin(all1h, ...W), h4h = inWin(all4h, ...W), h1d = inWin(all1d, ...W);

  // ── STAGE A: HTF × gates (floor 60, SL/TP 2.2/4.4) ────────────────────────
  console.log("── STAGE A: HTF source × gates ──");
  const A = [
    ["A1 4h | hardblock+regimeMap (baseline)", mkCfg({}), h4h],
    ["A2 4h | hardblock only (regimeMap off)", mkCfg({ regimeMap: false }), h4h],
    ["A3 4h | regimeMap only (hardblock off)", mkCfg({ hardBlock: false }), h4h],
    ["A4 4h | NO regime gates (both off)", mkCfg({ hardBlock: false, regimeMap: false }), h4h],
    ["A5 1d | hardblock+regimeMap", mkCfg({ htf: "1d" }), h1d],
    ["A6 1d | hardblock only", mkCfg({ htf: "1d", regimeMap: false }), h1d],
    ["A7 4h | + rejection ON (probe)", mkCfg({ rejection: true }), h4h],
  ];
  const aRes = [];
  for (const [label, cfg, htf] of A) {
    const t = await run(cfg, "Intraday", e1h, htf);
    aRes.push({ label, t, netPF: pf(t).net, cfg, htf });
    console.log(fmt(label, t));
  }
  // CHoCH probe via Scalping path (rawA) at 1h — floor forced symmetric 60
  const chochCfg = clone(baseCfg);
  chochCfg.riskPerTrade = 0.02;
  chochCfg.typeOverrides.Scalping.sacMinConfidenceALong = 60;
  chochCfg.typeOverrides.Scalping.sacMinConfidenceAShort = 60;
  const chochT = await run(chochCfg, "Scalping", e1h, h4h);
  console.log(fmt("A8 4h | CHoCH path probe (Scalping-type)", chochT));

  const bestA = aRes.filter(r => r.t.length >= 15).sort((a, b) => b.netPF - a.netPF)[0] || aRes[0];
  console.log(`→ Stage A winner: ${bestA.label}\n`);

  // ── STAGE B: SL/TP grid on winner ─────────────────────────────────────────
  console.log("── STAGE B: SL/TP ATR grid ──");
  const wOpt = { htf: bestA.cfg.typeOverrides.Intraday.sacHtfHardBlock ? "4h" : "4h" };
  const wHard = bestA.cfg.sacHtfHardBlock, wMap = bestA.cfg.typeOverrides.Intraday.regimeMappingStrict;
  const wHtf = bestA.htf;
  const bRes = [];
  for (const sl of [1.5, 2.2, 3.0]) {
    for (const tp of [1.5 * sl, 2.0 * sl, 3.0 * sl]) {
      const cfg = mkCfg({ hardBlock: wHard, regimeMap: wMap, sl, tp });
      const t = await run(cfg, "Intraday", e1h, wHtf);
      const rr = (tp / sl).toFixed(1);
      bRes.push({ sl, tp, t, netPF: pf(t).net });
      console.log(fmt(`B sl=${sl} tp=${tp.toFixed(1)} (RR ${rr})`, t));
    }
  }
  const bestB = bRes.filter(r => r.t.length >= 15).sort((a, b) => b.netPF - a.netPF)[0] || bRes[0];
  console.log(`→ Stage B winner: sl=${bestB.sl} tp=${bestB.tp}\n`);

  // ── STAGE C: confidence floor sweep ───────────────────────────────────────
  console.log("── STAGE C: confidence floor ──");
  const cRes = [];
  for (const floorB of [60, 65, 70, 75]) {
    const cfg = mkCfg({ hardBlock: wHard, regimeMap: wMap, sl: bestB.sl, tp: bestB.tp, floorB });
    const t = await run(cfg, "Intraday", e1h, wHtf);
    cRes.push({ floorB, t, netPF: pf(t).net });
    console.log(fmt(`C floorB=${floorB}`, t));
  }
  const bestC = cRes.filter(r => r.t.length >= 12).sort((a, b) => b.netPF - a.netPF)[0] || cRes[0];
  console.log(`→ Stage C winner: floorB=${bestC.floorB}\n`);

  // ── STAGE D: walk-forward final candidate ─────────────────────────────────
  console.log("── STAGE D: WALK-FORWARD final candidate (OOS) ──");
  const finalCfg = mkCfg({ hardBlock: wHard, regimeMap: wMap, sl: bestB.sl, tp: bestB.tp, floorB: bestC.floorB });
  console.log(`candidate: htf=${wHtf === h1d ? "1d" : "4h"} hardBlock=${wHard} regimeMap=${wMap} sl=${bestB.sl} tp=${bestB.tp} floorB=${bestC.floorB}`);
  const WINDOWS = [
    ["2022-07→2023-07 (bear)", Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)", Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
  ];
  const allHtf = wHtf === h1d ? all1d : all4h;
  for (const [label, s, e] of WINDOWS) {
    const t = await run(finalCfg, "Intraday", inWin(all1h, s, e), inWin(allHtf, s, e));
    console.log(fmt(`D ${label}`, t));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
