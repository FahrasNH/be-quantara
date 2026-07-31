/**
 * Fast per-leg Wyckoff tuner using cached Binance Vision candles.
 * Usage: node scripts/wyckoff-leg-tune.js [Scalping|Intraday|Swing|all]
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const cacheDir = path.join("tmp", "wyckoff-bt-cache");
const load = (tf) =>
  JSON.parse(fs.readFileSync(path.join(cacheDir, `BTCUSDT_${tf}_365d.json`), "utf8"));

const { runTripleTypeBacktest } = require("../src/modules/backtest/services/RealStrategyBacktestService.js");
const { applyStrategyJobDefaults } = require("../src/modules/backtest/services/runBacktestJob.js");
const { STRATEGIES } = require("../src/config/strategyDefaults.js");

const w = STRATEGIES.WYCKOFF;
const e5 = load("5m");
const e15 = load("15m");
const e1h = load("1h");
const e4h = load("4h");

const _log = console.log.bind(console);
console.log = () => {};

async function runType(type, ov, feeRate = 0.001) {
  const config = applyStrategyJobDefaults("WYCKOFF", {
    activeTypes: [type],
    entryModel: "balanced",
    ...w,
    typeOverrides: { ...w.typeOverrides, [type]: { ...w.typeOverrides[type], ...ov } },
  });
  Object.assign(config, w, { entryModel: "balanced", typeOverrides: config.typeOverrides });
  const result = await runTripleTypeBacktest({
    strategyKey: "WYCKOFF",
    capital: 1000,
    enableFees: true,
    enableSlippage: false,
    feeRate,
    typeOrder: [type],
    entryCandles: { Scalping: e5, Intraday: e15, Swing: e1h },
    htfCandles: { Scalping: e1h, Intraday: e1h, Swing: e4h },
    dailyCandles: [],
    config,
    symbol: "BTCUSDT",
  });
  const trades = (result.trades || []).filter((x) => x.tradeType === type || x.component === type);
  const wins = trades.filter((x) => (x.pnlNet ?? x.pnl ?? 0) > 0);
  const pnl = trades.reduce((a, x) => a + (x.pnlNet ?? x.pnl ?? 0), 0);
  const fees = trades.reduce((a, x) => a + (x.fee ?? x.fees ?? 0), 0);
  const need = type === "Scalping" ? 200 : type === "Intraday" ? 50 : 40;
  return {
    n: trades.length,
    wr: trades.length ? (100 * wins.length) / trades.length : 0,
    pnl,
    fees,
    ok: trades.length >= need && pnl > 0,
  };
}

function line(label, r) {
  _log(
    `${r.ok ? "***" : "   "} ${label.padEnd(36)} n=${String(r.n).padStart(4)} WR=${r.wr.toFixed(1).padStart(5)}% PnL=${(r.pnl >= 0 ? "+" : "") + r.pnl.toFixed(2)} fee=${r.fees.toFixed(0)}`,
  );
}

const TRIALS = {
  Scalping: [
    ["base", {}],
    ["minSl0.5 RR2.5", { minSlPct: 0.005, minRr: 2.5, slAtrMult: 1.4, tpAtrMult: 3.5, blockLong: true }],
    ["minSl0.5 RR2 fee0.04%", { minSlPct: 0.005, minRr: 2.0, blockLong: true }],
    ["fee0.04% base", {}],
    ["reject-style atrAbs0.18 RR2", { atrGateRelative: false, atrMinMult: 0.18, minRr: 2.0, blockLong: true, volumeConfirmMult: 1.35 }],
    ["atrR0.55 noSide RR2.2", { atrRelMin: 0.55, allowHtfSideways: false, minRr: 2.2, blockLong: true, cooldownBars: 2 }],
  ],
  Intraday: [
    ["base", {}],
    ["atr.34 cd2", { atrMinMult: 0.34, cooldownBars: 2 }],
    ["atr.335 cd2", { atrMinMult: 0.335, cooldownBars: 2, longVolumeConfirmMult: 1.7 }],
    ["atr.34 bb1.03", { atrMinMult: 0.34, cooldownBars: 3, bbWidthMeanMult: 1.03 }],
    ["atr.34 shortBias RR2", { atrMinMult: 0.34, cooldownBars: 2, longVolumeConfirmMult: 2.5, minRr: 2.0 }],
    ["atr.36 noSide", { atrMinMult: 0.36, allowHtfSideways: false, cooldownBars: 2 }],
  ],
  Swing: [
    ["base", {}],
    ["longOnly atr0.35", { blockShort: true, blockLong: false, atrGateRelative: false, atrMinMult: 0.35, allowHtfSidewaysLong: true, sidewaysShortOnly: false, longVolumeConfirmMult: 1.25, minRr: 2.0 }],
    ["longOnly atrR.4 noSide", { blockShort: true, blockLong: false, atrRelMin: 0.4, allowHtfSideways: false, longVolumeConfirmMult: 1.2, minRr: 2.0 }],
    ["both atr0.4 noSide", { blockLong: false, atrGateRelative: false, atrMinMult: 0.4, allowHtfSideways: false, allowHtfSidewaysLong: true, sidewaysShortOnly: false, minRr: 2.2 }],
    ["short atr0.55 noSide RR3", { blockLong: true, atrGateRelative: false, atrMinMult: 0.55, allowHtfSideways: false, minRr: 3.0, minSlPct: 0.01 }],
  ],
};

async function main() {
  const arg = (process.argv[2] || "Intraday,Swing").split(",").map((s) => s.trim());
  const types = arg.includes("all") ? ["Intraday", "Swing", "Scalping"] : arg;
  for (const type of types) {
    _log(`\n=== ${type} ===`);
    const trials = TRIALS[type] || [["base", {}]];
    for (const [label, ov] of trials) {
      const feeRate = /fee0\.04/.test(label) ? 0.0004 : 0.001;
      const r = await runType(type, ov, feeRate);
      line(label, r);
    }
  }
  _log("\nDONE");
}

main().catch((e) => {
  console.log = _log;
  console.error(e);
  process.exit(1);
});
