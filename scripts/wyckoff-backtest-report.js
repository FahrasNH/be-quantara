#!/usr/bin/env node
/**
 * Wyckoff backtest report CLI — plain `node` so --flags work (Node 24
 * `node --test` does NOT forward args after `--` into process.argv).
 *
 * Examples:
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --types Scalping
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --types Scalping,Intraday,Swing --fees 1
 *   # Web parity (default for --source real): CCXT futures/swap + 5m→180d + daily regime
 *   node scripts/wyckoff-backtest-report.js --source real --exchange binance --klines exchange --web-parity 1 ...
 *   # Legacy spot Vision (NOT comparable to website):
 *   node scripts/wyckoff-backtest-report.js --source real --klines vision ...
 *   # Offline (default for --source real): backtest-reports/btcusdt_data JSON — NO API
 *   node scripts/wyckoff-backtest-report.js --source real --klines file --types Intraday,Swing --fees 1
 *   npm run test:wyckoff:file
 *   npm run test:wyckoff:12m
 */
"use strict";

process.env.WYCKOFF_BT_CLI = "1";
require("dotenv").config();

const {
  parseCfg,
  runWyckoffCustomBacktest,
  printReport,
  savePositionReports,
} = require("../test/wyckoff-backtest-report.test.js");

function money(n) {
  if (!Number.isFinite(n)) return String(n);
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${n.toFixed(2)}`;
}

async function main() {
  const cfg = parseCfg(process.argv.slice(2));
  console.log(
    `\n[wyckoff-report] starting  source=${cfg.source}  months=${cfg.months}`
    + `  symbol=${cfg.symbol}  types=${cfg.types.join(",")}  model=${cfg.entryModel}`
    + `  exchange=${cfg.exchange}  klines=${cfg.klines}  webParity=${cfg.webParity ? 1 : 0}`,
  );

  let packed;
  try {
    packed = await runWyckoffCustomBacktest(cfg);
  } catch (err) {
    console.error(`\n[wyckoff-report] failed: ${err && err.stack ? err.stack : err}`);
    if (cfg.source === "real") {
      console.error("  Tip: api/fapi.binance.com often blocked (e.g. Internet Positif) — curl hits the same wall.");
      console.error("       • Offline: node scripts/wyckoff-dump-candles.js --source vision");
      console.error("                 then: --klines file  (uses tmp/wyckoff-bt-cache)");
      console.error("       • Desktop live: --klines vision");
      console.error("       • Website parity: run dump/report on VPS with --source exchange");
    }
    process.exitCode = 1;
    return;
  }

  const { result, loadMeta } = packed;
  const report = printReport(cfg, result, loadMeta);
  const saved = savePositionReports(cfg, result, loadMeta, report);

  console.log(`[wyckoff-report] saved single report (${saved.tradeCount} positions)`);
  console.log(`[wyckoff-report] file: ${saved.outFile}`);
  console.log(
    `[wyckoff-report] summary  trades=${result.stats.totalTrades}`
    + `  WR=${result.stats.winRate}%`
    + `  PnL=${money(report.extra.totalPnl)}`
    + `  return=${result.stats.totalReturn}%`
    + `  PF=${result.stats.profitFactor}`
    + `  MDD=${result.stats.maxDrawdown}%`,
  );
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
