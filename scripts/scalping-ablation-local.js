#!/usr/bin/env node
/**
 * AF-SCALP-13 LOCAL ablation harness.
 *
 * Runs the REAL runTripleTypeBacktest engine against REAL BTCUSDT candles
 * fetched from data-api.binance.vision (public, no auth) — entirely local, no
 * VPS/deploy/log-grep. Prints the per-filter funnel for the Scalping leg.
 *
 * Usage: node scripts/scalping-ablation-local.js [months]
 */
const { execSync } = require("child_process");
const { runTripleTypeBacktest } = require("../src/server/services/RealStrategyBacktestService");
const cfg = require("/tmp/af_smc_config.json");

const HOST = "https://data-api.binance.vision";
const MONTHS = Number(process.argv[2] || 6);

function fetchKlines(symbol, interval, startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${HOST}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&limit=1000`;
    const raw = execSync(`curl -s --max-time 30 "${url}"`, { maxBuffer: 64 * 1024 * 1024 }).toString();
    let arr;
    try { arr = JSON.parse(raw); } catch { break; }
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const k of arr) {
      if (k[0] > endMs) break;
      out.push({ timestamp: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
    const last = arr[arr.length - 1][0];
    if (last <= cursor) break;
    cursor = last + 1;
    process.stdout.write(`\r  ${interval}: ${out.length} candles…`);
  }
  process.stdout.write("\n");
  return out;
}

(async () => {
  const endMs = Date.now();
  const startMs = endMs - MONTHS * 30 * 24 * 60 * 60 * 1000;
  console.log(`Fetching BTCUSDT candles (${MONTHS} months)…`);
  const entry = fetchKlines("BTCUSDT", "5m", startMs, endMs);   // Scalping entry TF
  const htf   = fetchKlines("BTCUSDT", "1h", startMs, endMs);   // Scalping trend TF
  console.log(`Loaded: ${entry.length} × 5m, ${htf.length} × 1h\n`);

  console.log("Running REAL engine (runTripleTypeBacktest, Scalping only)…\n");
  const result = await runTripleTypeBacktest({
    strategyKey: "AF_SMC",
    capital: 1000,
    enableFees: true,
    enableSlippage: true,
    config: cfg,
    typeOrder: ["Scalping"],
    naturalTypeOrder: ["Scalping", "Intraday", "Swing"],
    entryCandles: { Scalping: entry },
    htfCandles: { Scalping: htf },
    symbol: "BTCUSDT",
  });

  const st = result.perTypeStats?.Scalping || {};
  const a = st.ablation;
  let commit = "?";
  try { commit = execSync("git rev-parse --short HEAD", { cwd: __dirname }).toString().trim(); } catch {}

  console.log("═══════════════════════════════════════════════════════");
  console.log(`RESULT  (commit ${commit}, ${entry.length} × 5m bars)`);
  console.log("═══════════════════════════════════════════════════════");
  console.log(`Trades produced : ${st.trades ?? 0}  (wins: ${st.wins ?? 0})`);
  if (!a) {
    console.log("\n⚠️  ablation = null → Scalping leg skipped or getAblation missing.");
    console.log("perTypeStats.Scalping:", JSON.stringify(st));
    return;
  }
  const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
  console.log(`\n[FILTER FUNNEL]`);
  console.log(`  1. Raw setups (FVG+mitigation) : ${a.seqCandidate}`);
  console.log(`  2. − Rejection-wick gate       : −${a.rejByRejection}  (${pct(a.rejByRejection, a.seqCandidate)}% of setups)`);
  console.log(`     → signals after rejection    : ${a.seqSignal}`);
  console.log(`  3. − Regime hard-block          : −${a.rejByRegime}  (${pct(a.rejByRegime, a.seqSignal)}% of signals)`);
  console.log(`  4. − 5m CHoCH validation        : −${a.rejByChoch}`);
  console.log(`  5. − Confidence floor           : −${a.rejByConf}`);
  console.log(`  ═ PASSED (tradeable signals)    : ${a.passed}`);
  console.log(`\nRAW: ${JSON.stringify(a)}`);
})().catch(e => { console.error("HARNESS ERROR:", e.stack || e.message); process.exit(1); });
