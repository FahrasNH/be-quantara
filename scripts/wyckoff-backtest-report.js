#!/usr/bin/env node
/**
 * Wyckoff backtest report CLI — plain `node` so --flags work (Node 24
 * `node --test` does NOT forward args after `--` into process.argv).
 *
 * Examples:
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --types Scalping
 *   node scripts/wyckoff-backtest-report.js --source real --months 12 --types Scalping,Intraday,Swing --fees 1
 *   npm run test:wyckoff:12m
 *   npm run wyckoff:report -- --source real --types Scalping,Intraday,Swing --fees 1
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
    + `  symbol=${cfg.symbol}  types=${cfg.types.join(",")}  model=${cfg.entryModel}`,
  );

  let packed;
  try {
    packed = await runWyckoffCustomBacktest(cfg);
  } catch (err) {
    console.error(`\n[wyckoff-report] failed: ${err && err.stack ? err.stack : err}`);
    if (cfg.source === "real") {
      console.error("  Tip: check network, or use --source mock");
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
