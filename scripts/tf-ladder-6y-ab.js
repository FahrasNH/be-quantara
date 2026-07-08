#!/usr/bin/env node
/**
 * TS_TF LADDER + GROK-KNOB A/B ON 6Y DATA (2026-07-08)
 *
 * Source data (user CSVs, post AF-SCALP-24 defaults):
 * - "all-type 6y partial" = SWING LEG ONLY (Intraday 15m fetch silently failed;
 *   all 16 positions match swing-6y.csv 1:1). Partial net -5.72 / PF 0.95.
 * - swing-6y full TP, SAME 16 positions: net +16.69 / PF ~1.10.
 * - Forensics: ladder saved 2 losses (+47.9) but compressed 6 winners (-74.9)
 *   — the m1 SL jump to +0.3R trailed 3 winners out at +0.3R that full mode
 *   rode to the ~1.9R TP. Net ladder cost ≈ -27 over 6y on Swing.
 * - intra-599d full TP: PF 0.86 — Intraday remains the drag leg.
 *
 * Tests (per leg, then walk-forward 2y windows):
 * - Ladder timing via slPlusM1R/slPlusM2R (shipped 2026-07-08)
 * - Grok session recommendations: riskReward 2.2, donchianPeriod 30
 *   (donchianPeriod was a DEAD KNOB until today — read from singleton
 *   constructor config; now per-run config-aware)
 * Grok's "ADX -> 24" is REJECTED without testing: the 4-window sweep already
 * measured ADX30 > ADX25 in every window, and Grok's analysis ran on the
 * mislabeled Swing-only dataset.
 *
 * Run: node scripts/tf-ladder-6y-ab.js
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
  return `${label.padEnd(40)} pos=${String(closes.length).padStart(3)} WR=${closes.length ? (w / closes.length * 100).toFixed(1) : " 0.0"}% netPF=${isFinite(p.net) ? p.net.toFixed(2) : "inf"} net=${p.pnl.toFixed(1)}`;
}

const BASE = {
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOB: 70,
  riskPerTrade: 0.03, htfTrendStrengthMin: 0.65, capital: 1000,
  atrMult: 1.3, riskReward: 1.92,
};

async function runLeg(leg, cfg, candles) {
  const res = await runMultiTypeBacktest({
    strategyKey: "TS_TF", capital: 1000, enableFees: true, enableSlippage: true,
    config: cfg, naturalTypeOrder: ["Intraday", "Swing"],
    entryCandles: { [leg]: candles.entry }, htfCandles: { [leg]: candles.htf },
    dailyCandles: candles.daily, symbol: "BTCUSDT",
  }, [leg]);
  return res.trades || [];
}

(async () => {
  const now = Date.now();
  console.log("Fetching 6y of 4h + 1w + 1d and 625d of 15m (BTCUSDT)…");
  const s6y = Date.UTC(2020, 6, 1);
  const s625 = now - 625 * 86400_000;
  const all4h = fetchK("BTCUSDT", "4h", s6y, now);
  const all1w = fetchK("BTCUSDT", "1w", s6y, now);
  const all1d = fetchK("BTCUSDT", "1d", s6y, now);
  const all15 = fetchK("BTCUSDT", "15m", s625, now);
  console.log(`Loaded ${all4h.length}×4h ${all1w.length}×1w ${all1d.length}×1d ${all15.length}×15m\n`);

  const swingWin = (s, e) => ({ entry: inWin(all4h, s, e), htf: inWin(all1w, s, e), daily: inWin(all1d, s, e) });
  const intraWin = (s, e) => ({ entry: inWin(all15, s, e), htf: inWin(all4h, s, e), daily: inWin(all1d, s, e) });
  const SW6 = swingWin(s6y, now);
  const I625 = intraWin(s625, now);

  console.log("── STAGE 1: SWING leg, 6y (parity + ladder + Grok knobs) ──");
  const SWING = [
    ["S0 partial m1R=1.0 (CSV parity -5.7)", { ...BASE, tpMode: "partial" }],
    ["S1 full TP (CSV parity +16.7)", { ...BASE, tpMode: "full" }],
    ["S2 partial m1R=1.5", { ...BASE, tpMode: "partial", slPlusM1R: 1.5 }],
    ["S3 full + RR2.2 (Grok)", { ...BASE, tpMode: "full", riskReward: 2.2 }],
    ["S4 full + donchian30 (Grok)", { ...BASE, tpMode: "full", donchianPeriod: 30 }],
    ["S5 full + RR2.2 + donchian30", { ...BASE, tpMode: "full", riskReward: 2.2, donchianPeriod: 30 }],
    ["S6 partial m1R=1.5 + RR2.2", { ...BASE, tpMode: "partial", slPlusM1R: 1.5, riskReward: 2.2 }],
  ];
  const swingResults = [];
  for (const [label, cfg] of SWING) {
    const t = await runLeg("Swing", cfg, SW6);
    swingResults.push({ label, cfg, t, netPF: pf(t).net });
    console.log(row(label, t));
  }

  console.log("\n── STAGE 2: INTRADAY leg, 625d ──");
  const INTRA = [
    ["I0 full (CSV parity ≈ -39)", { ...BASE, tpMode: "full" }],
    ["I1 partial m1R=1.0", { ...BASE, tpMode: "partial" }],
    ["I2 full + donchian30", { ...BASE, tpMode: "full", donchianPeriod: 30 }],
    ["I3 full + RR2.2", { ...BASE, tpMode: "full", riskReward: 2.2 }],
  ];
  for (const [label, cfg] of INTRA) {
    const t = await runLeg("Intraday", cfg, I625);
    console.log(row(label, t));
  }

  console.log("\n── STAGE 3: SWING WALK-FORWARD (2y windows) — top swing variants ──");
  const top = swingResults.slice().sort((a, b) => b.netPF - a.netPF).slice(0, 3);
  const WINDOWS = [
    ["2020-07→2022-07", Date.UTC(2020, 6, 1), Date.UTC(2022, 6, 1)],
    ["2022-07→2024-07", Date.UTC(2022, 6, 1), Date.UTC(2024, 6, 1)],
    ["2024-07→2026-07", Date.UTC(2024, 6, 1), now],
  ];
  for (const cand of top) {
    console.log(`· ${cand.label}`);
    for (const [wl, s, e] of WINDOWS) {
      const t = await runLeg("Swing", cand.cfg, swingWin(s, e));
      console.log(row(`   ${wl}`, t));
    }
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
