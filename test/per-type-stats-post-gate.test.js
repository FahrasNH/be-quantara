/**
 * perTypeStats must reflect post-RAG/post-Grok survivors, not pre-gate engine counts.
 */
"use strict";

const assert = require("node:assert/strict");
const { _refreshPerTypeStatsFromTrades } = require("../src/modules/backtest/services/RealStrategyBacktestService");

function trade(type, pnl) {
  return { component: type, tradeType: type, pnl, result: pnl > 0 ? "win" : "loss" };
}

const preGate = {
  Scalping: { trades: 30, wins: 12, entryBars: 5000 },
  Intraday: { trades: 3, wins: 2, entryBars: 8000 },
  Swing: { trades: 7, wins: 5, entryBars: 1200 },
};

// 2 swing trades rejected by RAG: 30+3+5=38 survivors
const postGateTrades = [
  ...Array.from({ length: 30 }, (_, i) => trade("Scalping", i % 3 === 0 ? -2 : 1)),
  trade("Intraday", 15),
  trade("Intraday", 20),
  trade("Intraday", -5),
  trade("Swing", 50),
  trade("Swing", 30),
  trade("Swing", 10),
  trade("Swing", -8),
  trade("Swing", 5),
];

const refreshed = _refreshPerTypeStatsFromTrades(preGate, postGateTrades, 1000);

assert.equal(refreshed.Scalping.trades, 30);
assert.equal(refreshed.Intraday.trades, 3);
assert.equal(refreshed.Swing.trades, 5, "Swing count drops from 7 pre-gate to 5 post-gate");
assert.equal(refreshed.Swing.postGate, true);

const swingPnl = 50 + 30 + 10 - 8 + 5;
assert.equal(refreshed.Swing.totalReturn, ((swingPnl / 1000) * 100).toFixed(2));

const totalPnl = postGateTrades.reduce((s, t) => s + t.pnl, 0);
const legSumReturn =
  parseFloat(refreshed.Scalping.totalReturn)
  + parseFloat(refreshed.Intraday.totalReturn)
  + parseFloat(refreshed.Swing.totalReturn);
const allReturn = (totalPnl / 1000) * 100;
assert.ok(Math.abs(legSumReturn - allReturn) < 0.05, "sum of leg NET% ≈ All Type NET% on shared capital");

console.log("per-type-stats-post-gate.test.js: OK");
