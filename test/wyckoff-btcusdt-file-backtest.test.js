/**
 * Offline Wyckoff backtest from local JSON (NO exchange API).
 *
 * Data: backtest-reports/btcusdt_data/BTCUSDT_*_12_months.json
 * Available TFs: 5m, 15m, 1h, 4h, 12h, 1d, 1w, 1M
 *
 *   npm run test:wyckoff:file
 *   node --test test/wyckoff-btcusdt-file-backtest.test.js
 */
"use strict";

process.env.WYCKOFF_BT_CLI = "1";

const fs = require("fs");
const path = require("path");
const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "backtest-reports", "btcusdt_data");

const {
  parseCfg,
  runWyckoffCustomBacktest,
  printReport,
  savePositionReports,
} = require("./wyckoff-backtest-report.test.js");

describe("Wyckoff offline backtest (btcusdt_data JSON, no API)", () => {
  test("loads local 12m JSON and runs Scalping+Intraday+Swing backtest", async () => {
    assert.ok(fs.existsSync(DATA_DIR), `missing data dir: ${DATA_DIR}`);
    for (const f of [
      "BTCUSDT_5m_12_months.json",
      "BTCUSDT_15m_12_months.json",
      "BTCUSDT_1h_12_months.json",
      "BTCUSDT_4h_12_months.json",
      "BTCUSDT_1w_12_months.json",
      "BTCUSDT_1d_12_months.json",
    ]) {
      assert.ok(fs.existsSync(path.join(DATA_DIR, f)), `missing ${f}`);
    }

    const cfg = parseCfg([
      "--source", "real",
      "--months", "12",
      "--symbol", "BTCUSDT",
      "--types", "Scalping,Intraday,Swing",
      "--fees", "1",
      "--klines", "file",
      "--cache-dir", DATA_DIR,
      "--web-parity", "1",
      "--entry-model", "balanced",
    ]);

    assert.equal(cfg.klines, "file");
    assert.equal(cfg.cacheDir, DATA_DIR);

    const packed = await runWyckoffCustomBacktest(cfg);
    const { result, loadMeta } = packed;

    assert.ok(result && typeof result === "object");
    assert.ok(Array.isArray(result.trades));
    assert.ok(result.stats && typeof result.stats === "object");
    assert.equal(typeof result.stats.totalTrades, "number");
    assert.ok(result.stats.totalTrades > 0, "expected at least one trade from local data");
    assert.ok(result.stats.winRate != null);
    assert.ok(result.stats.maxDrawdown != null);

    const byType = {};
    for (const t of result.trades) {
      const k = t.tradeType || t.component || "?";
      byType[k] = (byType[k] || 0) + 1;
    }
    assert.ok(byType.Scalping > 0, `expected Scalping trades, got: ${JSON.stringify(byType)}`);
    assert.ok(byType.Intraday > 0, `expected Intraday trades, got: ${JSON.stringify(byType)}`);
    assert.ok(byType.Swing > 0, `expected Swing trades, got: ${JSON.stringify(byType)}`);

    // Prove we used file cache, not exchange/vision.
    const src = String(loadMeta?.source || "");
    assert.match(src, /^file\(/, `expected file(...) source, got: ${src}`);

    const report = printReport(cfg, result, loadMeta);
    assert.ok(Number.isFinite(report.extra.totalPnl));

    const saved = savePositionReports(cfg, result, loadMeta, report);
    assert.ok(fs.existsSync(saved.outFile), `report missing: ${saved.outFile}`);

    console.log(
      `[wyckoff-file] trades=${result.stats.totalTrades}`
      + `  WR=${result.stats.winRate}%`
      + `  PnL=${report.extra.totalPnl.toFixed(2)}`
      + `  MDD=${result.stats.maxDrawdown}%`
      + `  byType=${JSON.stringify(byType)}`
      + `  source=${src}`,
    );
  });
});
