#!/usr/bin/env node
/**
 * SMC entry-TF sweep (local, real BTC). Tests whether the SMC edge exists at a
 * HIGHER entry timeframe. Same engine/config, only the entry+HTF candle TF changes.
 * Usage: node scripts/scalping-tf-sweep.js [months]
 */
const { execSync } = require("child_process");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const baseCfg = require("/tmp/af_smc_config.json");
const HOST = "https://data-api.binance.vision";
const MONTHS = Number(process.argv[2] || 6);

function fetchK(sym, iv, s, e) {
  const out = []; let c = s;
  while (c < e) {
    const url = `${HOST}/api/v3/klines?symbol=${sym}&interval=${iv}&startTime=${c}&limit=1000`;
    let a; try { a = JSON.parse(execSync(`curl -s --max-time 30 "${url}"`, { maxBuffer: 64 * 1024 * 1024 }).toString()); } catch { break; }
    if (!Array.isArray(a) || !a.length) break;
    for (const k of a) { if (k[0] > e) break; out.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }); }
    const last = a[a.length - 1][0]; if (last <= c) break; c = last + 1;
  }
  return out;
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function pf(ts) { let gp = 0, gl = 0, Gp = 0, Gl = 0; for (const t of ts) { t.pnl >= 0 ? gp += t.pnl : gl += -t.pnl; t.grossPnl >= 0 ? Gp += t.grossPnl : Gl += -t.grossPnl; } return { net: gl ? gp / gl : Infinity, gross: Gl ? Gp / Gl : Infinity, pnl: gp - gl }; }

(async () => {
  const e = Date.now(), s = e - MONTHS * 30 * 864e5;
  const combos = [
    { label: "5m entry / 1h HTF",  entry: "5m",  htf: "1h" },
    { label: "15m entry / 4h HTF", entry: "15m", htf: "4h" },
    { label: "1h entry / 4h HTF",  entry: "1h",  htf: "4h" },
  ];
  const cache = {};
  const rows = [];
  for (const cb of combos) {
    cache[cb.entry] = cache[cb.entry] || fetchK("BTCUSDT", cb.entry, s, e);
    cache[cb.htf] = cache[cb.htf] || fetchK("BTCUSDT", cb.htf, s, e);
    const cfg = clone(baseCfg); // keep rejection ON as configured
    const res = await runTripleTypeBacktest({
      strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
      config: cfg, typeOrder: ["Scalping"], naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
      entryCandles: { Scalping: cache[cb.entry] }, htfCandles: { Scalping: cache[cb.htf] }, symbol: "BTCUSDT",
    });
    const ts = res.trades || [], w = ts.filter(t => t.result === "win").length, p = pf(ts);
    rows.push({ label: cb.label, bars: cache[cb.entry].length, trades: ts.length, wins: w,
      wr: ts.length ? (w / ts.length * 100).toFixed(1) : "0.0",
      gross: isFinite(p.gross) ? p.gross.toFixed(2) : "∞", net: isFinite(p.net) ? p.net.toFixed(2) : "∞", pnl: p.pnl.toFixed(1) });
    console.log(`✓ ${cb.label}: ${ts.length} trades`);
  }
  console.log(`\n═══════════ SMC ENTRY-TF SWEEP (${MONTHS}mo) ═══════════`);
  const W = [20, 8, 8, 6, 8, 8, 9];
  console.log(["Entry/HTF", "Bars", "Trades", "WR%", "GrossPF", "NetPF", "Net$"].map((h, i) => h.padEnd(W[i])).join(""));
  for (const r of rows) console.log([r.label, r.bars, r.trades, r.wr, r.gross, r.net, r.pnl].map((c, i) => String(c).padEnd(W[i])).join(""));
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
