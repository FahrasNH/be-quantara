#!/usr/bin/env node
/**
 * AF-SCALP-15 WALK-FORWARD validation + Intraday zero-trade diagnosis.
 *
 * Part 1 — walk-forward: the 80/75 asymmetric floor was picked on the
 * Jul-2025→Jul-2026 window. Test it on THREE windows never used for selection
 * (2022-23 bear, 2023-24 recovery, 2024-25 bull) vs the floor-60 baseline.
 *
 * Part 2 — Intraday diag: run the REAL Intraday leg with gates removed one at
 * a time to find which one produces 0 trades on every coin.
 *
 * Usage: node scripts/scalping-walkforward.js
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
function pf(t) {
  let gp = 0, gl = 0;
  for (const x of t) { if (x.pnl >= 0) gp += x.pnl; else gl += -x.pnl; }
  return { net: gl ? gp / gl : (gp > 0 ? Infinity : 0), pnl: gp - gl };
}
function row(label, t) {
  const w = t.filter(x => x.result === "win").length, p = pf(t);
  const L = t.filter(x => x.side === "LONG").length, S = t.filter(x => x.side === "SHORT").length;
  return `${label.padEnd(26)} n=${String(t.length).padStart(3)} (${L}L/${S}S)  WR=${t.length ? (w / t.length * 100).toFixed(1) : " 0.0"}%  netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"}  net=${p.pnl.toFixed(1)}`;
}
async function run(cfg, type, entry, htf) {
  const res = await runTripleTypeBacktest({
    strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, typeOrder: [type], naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
    entryCandles: { [type]: entry }, htfCandles: { [type]: htf }, symbol: "BTCUSDT",
  });
  return res.trades || [];
}

(async () => {
  // ── Part 1: walk-forward ──────────────────────────────────────────────────
  const WINDOWS = [
    ["2022-07→2023-07 (bear)",     Date.UTC(2022, 6, 1), Date.UTC(2023, 6, 1)],
    ["2023-07→2024-07 (recovery)", Date.UTC(2023, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2025-07 (bull)",     Date.UTC(2024, 6, 1), Date.UTC(2025, 6, 1)],
    ["2025-07→2026-07 (IN-SAMPLE)", Date.UTC(2025, 6, 1), Date.now()],
  ];

  console.log("══════════ PART 1 — WALK-FORWARD floor 80/75 vs baseline 60 (Scalping 15m/4h) ══════════");
  let lastWindow = null;
  for (const [label, s, e] of WINDOWS) {
    const entry = fetchK("BTCUSDT", "15m", s, e);
    const htf = fetchK("BTCUSDT", "4h", s, e);
    lastWindow = { entry, htf };
    console.log(`\n── ${label}  (${entry.length} × 15m)`);

    const base = clone(baseCfg); // baseline: floor 60 both sides
    delete base.typeOverrides.Scalping.sacMinConfidenceALong;
    delete base.typeOverrides.Scalping.sacMinConfidenceAShort;
    console.log(row("floor 60 (baseline)", await run(base, "Scalping", entry, htf)));

    const asym = clone(baseCfg); // as shipped: LONG>=80 / SHORT>=75
    console.log(row("LONG>=80 / SHORT>=75", await run(asym, "Scalping", entry, htf)));

    const sym75 = clone(baseCfg); // robustness probe: symmetric 75
    sym75.typeOverrides.Scalping.sacMinConfidenceALong = 75;
    sym75.typeOverrides.Scalping.sacMinConfidenceAShort = 75;
    console.log(row("75 / 75 (probe)", await run(sym75, "Scalping", entry, htf)));
  }

  // ── Part 2: Intraday zero-trade diagnosis (reuse last window's candles) ───
  console.log("\n══════════ PART 2 — INTRADAY DIAG (same 15m/4h data, 2025-07→now) ══════════");
  const { entry, htf } = lastWindow;

  const I0 = clone(baseCfg);
  console.log(row("I0 as-is", await run(I0, "Intraday", entry, htf)));

  const I1 = clone(baseCfg); I1.sacMinConfidenceB = 60;
  console.log(row("I1 floorB 65→60", await run(I1, "Intraday", entry, htf)));

  const I2 = clone(baseCfg); I2.typeOverrides.Intraday.regimeMappingStrict = false;
  console.log(row("I2 regimeMapping OFF", await run(I2, "Intraday", entry, htf)));

  const I3 = clone(baseCfg); I3.sacMinConfidenceB = 60; I3.typeOverrides.Intraday.regimeMappingStrict = false;
  console.log(row("I3 both OFF/60", await run(I3, "Intraday", entry, htf)));
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
