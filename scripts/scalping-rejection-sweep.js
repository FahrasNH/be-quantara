#!/usr/bin/env node
/**
 * AF-SCALP-13 rejection-wick SWEEP (local, real BTC data).
 * Fetches candles ONCE, runs the real engine across several
 * sacRejectionWickRatio values (+ rejection OFF) and prints a comparison so we
 * can pick the setting that maximizes net PF while restoring trade volume.
 *
 * Usage: node scripts/scalping-rejection-sweep.js [months]
 */
const { execSync } = require("child_process");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const baseCfg = require("/tmp/af_smc_config.json");

const HOST = "https://data-api.binance.vision";
const MONTHS = Number(process.argv[2] || 6);

function fetchKlines(symbol, interval, startMs, endMs) {
  const out = []; let cursor = startMs;
  while (cursor < endMs) {
    const url = `${HOST}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
    let arr; try { arr = JSON.parse(execSync(`curl -s --max-time 30 "${url}"`, { maxBuffer: 64 * 1024 * 1024 }).toString()); } catch { break; }
    if (!Array.isArray(arr) || !arr.length) break;
    for (const k of arr) { if (k[0] > endMs) break; out.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }); }
    const last = arr[arr.length - 1][0]; if (last <= cursor) break; cursor = last + 1;
  }
  return out;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function pf(trades) {
  let gp = 0, gl = 0, ggp = 0, ggl = 0;
  for (const t of trades) {
    if (t.pnl >= 0) gp += t.pnl; else gl += -t.pnl;
    if (t.grossPnl >= 0) ggp += t.grossPnl; else ggl += -t.grossPnl;
  }
  return { netPF: gl > 0 ? gp / gl : Infinity, grossPF: ggl > 0 ? ggp / ggl : Infinity, net: gp - gl };
}

(async () => {
  const endMs = Date.now(), startMs = endMs - MONTHS * 30 * 24 * 60 * 60 * 1000;
  console.log(`Fetching ${MONTHS}mo BTCUSDT candles…`);
  const entry = fetchKlines("BTCUSDT", "5m", startMs, endMs);
  const htf = fetchKlines("BTCUSDT", "1h", startMs, endMs);
  console.log(`Loaded ${entry.length} × 5m, ${htf.length} × 1h\n`);

  const variants = [
    { label: "wick 0.8 (current)", reject: true, wr: 0.8 },
    { label: "wick 0.5",           reject: true, wr: 0.5 },
    { label: "wick 0.3",           reject: true, wr: 0.3 },
    { label: "wick 0.2",           reject: true, wr: 0.2 },
    { label: "rejection OFF",      reject: false, wr: null },
  ];

  const rows = [];
  for (const v of variants) {
    const cfg = clone(baseCfg);
    cfg.typeOverrides.Scalping.sacRejectionEntry = v.reject;
    if (v.reject) cfg.typeOverrides.Scalping.sacRejectionWickRatio = v.wr;
    const res = await runTripleTypeBacktest({
      strategyKey: "AF_SMC", capital: 1000, enableFees: true, enableSlippage: true,
      config: cfg, typeOrder: ["Scalping"], naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
      entryCandles: { Scalping: entry }, htfCandles: { Scalping: htf }, symbol: "BTCUSDT",
    });
    const trades = res.trades || [];
    const wins = trades.filter(t => t.result === "win").length;
    const a = res.perTypeStats?.Scalping?.ablation || {};
    const p = pf(trades);
    rows.push({
      label: v.label, setups: a.seqCandidate ?? "?", afterReject: a.seqSignal ?? "?",
      trades: trades.length, wins,
      wr: trades.length ? (wins / trades.length * 100).toFixed(1) : "0.0",
      grossPF: isFinite(p.grossPF) ? p.grossPF.toFixed(2) : "∞",
      netPF: isFinite(p.netPF) ? p.netPF.toFixed(2) : "∞",
      net: p.net.toFixed(1),
      perDay: (trades.length / (MONTHS * 30)).toFixed(2),
    });
    console.log(`✓ ${v.label}: ${trades.length} trades`);
  }

  console.log(`\n══════════════════════ SWEEP (${MONTHS}mo, ${entry.length} × 5m) ══════════════════════`);
  const H = ["Variant", "Setups", "PassRej", "Trades", "/day", "WR%", "GrossPF", "NetPF", "Net$"];
  console.log(H.map((h, i) => h.padEnd([18, 7, 8, 7, 6, 6, 8, 7, 8][i])).join(""));
  for (const r of rows) {
    console.log([r.label, r.setups, r.afterReject, r.trades, r.perDay, r.wr, r.grossPF, r.netPF, r.net]
      .map((c, i) => String(c).padEnd([18, 7, 8, 7, 6, 6, 8, 7, 8][i])).join(""));
  }
})().catch(e => { console.error("ERR:", e.stack || e.message); process.exit(1); });
