const assert = require("assert");
const { exportBacktests } = require("../src/server/services/BacktestCsvService");

const sample = [{
  id: 1,
  timestamp: "2026-06-26T00:00:00.000Z",
  symbol: "BTCUSDT",
  strategy_key: "ADAPTIVE_FUSION",
  timeframe: "1h",
  period_label: "500",
  metrics: { totalReturn: "12.5", winRate: "55.0", maxDrawdown: "8.2", profitFactor: "1.4", sharpe: "1.1", totalTrades: 20 },
  trades_data: [{ date: "2026-01-01", side: "LONG", entry: 100, exit: 110, pnl: 10, pnlPct: 10, fee: 0.5, reason: "TP" }],
}];

const summary = exportBacktests(sample, "summary");
assert(summary.includes("ADAPTIVE_FUSION"), "summary CSV should include strategy");
assert(summary.includes("BTCUSDT"), "summary CSV should include symbol");

const trades = exportBacktests(sample, "trades");
assert(trades.includes("LONG"), "trades CSV should include side");
// "trades" defaults to the FULL variant (superset). No leading "User" column —
// backtest is single-user (User lives only on the admin multi-user export).
assert(trades.includes("ID,Session ID,Symbol,Side,Strategy"), "trades CSV should use FULL columns, no User");
assert(!trades.includes("User,"), "trades CSV must not carry a User column");
assert(trades.includes("Entry Reasons"), "trades CSV should include Entry Reasons");
assert(trades.includes("Performance Summary"), "trades CSV should include performance summary");
assert(!trades.includes("Sweep Strength"), "trades CSV must omit stale ML columns");

console.log("✓ BacktestCsvService tests passed");
