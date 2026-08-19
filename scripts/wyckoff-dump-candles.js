#!/usr/bin/env node
/**
 * One-shot OHLCV dump for offline Wyckoff backtests.
 *
 * Desktop (ISP blocks api/fapi): use Vision SPOT
 *   node scripts/wyckoff-dump-candles.js --source vision
 *
 * VPS / VPN (website parity — USDT-M futures):
 *   node scripts/wyckoff-dump-candles.js --source exchange --exchange binance
 *
 * Writes per-TF:
 *   tmp/wyckoff-bt-cache/BTCUSDT_5m_365d.json   (machine / --klines file)
 *   tmp/wyckoff-bt-cache/BTCUSDT_5m_365d.txt    (readable TSV)
 *
 * Then run reports offline:
 *   node scripts/wyckoff-backtest-report.js --source real --klines file --types Scalping,Intraday,Swing --fees 1
 */
"use strict";

// Must be set BEFORE requiring the test module (skips node:test suite).
process.env.WYCKOFF_BT_CLI = "1";

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const {
  loadCandles,
  parseCfg,
} = require("../test/wyckoff-backtest-report.test.js");

const TFS = [
  { tf: "5m", daysLabel: "365d", periodId: "12m" },
  { tf: "15m", daysLabel: "365d", periodId: "12m" },
  { tf: "1h", daysLabel: "365d", periodId: "12m" },
  { tf: "4h", daysLabel: "365d", periodId: "12m" },
  { tf: "1d", daysLabel: "365d", periodId: "12m" },
  { tf: "1w", daysLabel: "800d", periodId: "12m", warmupBars: 60 },
];

function parseArgs(argv) {
  const get = (flag, def) => {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1] != null && !String(argv[i + 1]).startsWith("--")) {
      return argv[i + 1];
    }
    return def;
  };
  const src = String(get("--source", "vision")).toLowerCase();
  return {
    fetchSource: src === "exchange" || src === "futures" ? "exchange" : "vision",
    symbol: String(get("--symbol", "BTCUSDT")).toUpperCase(),
    exchange: String(get("--exchange", "binance")).toLowerCase(),
    outDir: path.resolve(get("--out", path.join(ROOT, "tmp", "wyckoff-bt-cache"))),
  };
}

function toTxt(candles, meta) {
  const header = [
    `# ${meta.symbol} ${meta.tf}  source=${meta.source}  n=${candles.length}`,
    `# from=${meta.from}  to=${meta.to}`,
    "timestamp\tdate\topen\thigh\tlow\tclose\tvolume",
  ];
  const rows = candles.map((c) => {
    const ts = c.timestamp;
    const date = new Date(ts).toISOString();
    return [ts, date, c.open, c.high, c.low, c.close, c.volume].join("\t");
  });
  return `${header.join("\n")}\n${rows.join("\n")}\n`;
}

function writeCandleFiles(outDir, symbol, tf, daysLabel, candles, source) {
  const base = `${symbol}_${tf}_${daysLabel}`;
  const jsonPath = path.join(outDir, `${base}.json`);
  const txtPath = path.join(outDir, `${base}.txt`);
  const slim = candles.map((c) => ({
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  fs.writeFileSync(jsonPath, JSON.stringify(slim), "utf8");
  const t0 = slim[0]?.timestamp;
  const t1 = slim[slim.length - 1]?.timestamp;
  const from = t0 ? new Date(t0).toISOString() : "?";
  const to = t1 ? new Date(t1).toISOString() : "?";
  fs.writeFileSync(txtPath, toTxt(slim, { symbol, tf, source, from, to }), "utf8");
  return { jsonPath, txtPath, n: slim.length, from, to };
}

/** Convert existing *.json cache → *.txt without re-fetch. */
function convertExistingJsonToTxt(outDir, symbol) {
  if (!fs.existsSync(outDir)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.startsWith(`${symbol}_`) || !f.endsWith(".json")) continue;
    const jsonPath = path.join(outDir, f);
    const txtPath = jsonPath.replace(/\.json$/i, ".txt");
    const candles = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    if (!Array.isArray(candles) || !candles.length) continue;
    const m = f.match(new RegExp(`^${symbol}_(.+)_([^_]+)\\.json$`));
    const tf = m ? m[1] : "?";
    const t0 = candles[0]?.timestamp;
    const t1 = candles[candles.length - 1]?.timestamp;
    fs.writeFileSync(
      txtPath,
      toTxt(candles, {
        symbol,
        tf,
        source: "file-cache",
        from: t0 ? new Date(t0).toISOString() : "?",
        to: t1 ? new Date(t1).toISOString() : "?",
      }),
      "utf8",
    );
    console.log(`[wyckoff-dump] converted ${f} → ${path.basename(txtPath)}  n=${candles.length}`);
    n += 1;
  }
  return n;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  fs.mkdirSync(opts.outDir, { recursive: true });

  if (process.argv.includes("--txt-only")) {
    const n = convertExistingJsonToTxt(opts.outDir, opts.symbol);
    console.log(`[wyckoff-dump] wrote ${n} .txt file(s) from existing JSON in ${opts.outDir}`);
    return;
  }

  const cfg = parseCfg([
    "--source", "real",
    "--months", "12",
    "--symbol", opts.symbol,
    "--exchange", opts.exchange,
    "--klines", opts.fetchSource === "exchange" ? "exchange" : "vision",
    "--web-parity", "0",
  ]);

  console.log(
    `[wyckoff-dump] fetch=${opts.fetchSource} symbol=${opts.symbol}`
    + ` exchange=${opts.exchange} → ${opts.outDir}`,
  );

  for (const { tf, daysLabel, periodId, warmupBars = 0 } of TFS) {
    console.log(`[wyckoff-dump] ${tf} …`);
    const loaded = await loadCandles(tf, cfg, { periodId, warmupBars });
    const written = writeCandleFiles(
      opts.outDir, opts.symbol, tf, daysLabel, loaded.candles || [], loaded.source,
    );
    console.log(
      `[wyckoff-dump] wrote ${path.basename(written.jsonPath)} + ${path.basename(written.txtPath)}`
      + `  n=${written.n}  ${written.from.slice(0, 10)} → ${written.to.slice(0, 10)}`
      + `  via ${loaded.source}`,
    );
  }

  console.log("\n[wyckoff-dump] done. Offline backtest:");
  console.log(
    "  node scripts/wyckoff-backtest-report.js --source real --klines file"
    + " --types Scalping,Intraday,Swing --fees 1 --web-parity 1",
  );
}

main().catch((err) => {
  console.error(`[wyckoff-dump] failed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
