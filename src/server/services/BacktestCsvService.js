/**
 * BacktestCsvService — export backtest runs ke CSV
 */

function escapeCsv(val) {
  const s = val == null ? "" : String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function metricsToRow(record) {
  const m = record.metrics || {};
  return {
    id: record.id,
    timestamp: record.timestamp,
    symbol: record.symbol,
    strategy: record.strategy_key || record.config?.strategyKey || "",
    timeframe: record.timeframe || record.config?.timeframe || "",
    period: record.period_label || record.config?.periodLabel || "",
    totalReturn: m.totalReturn ?? m.roi_pct ?? "",
    winRate: m.winRate ?? m.win_rate_pct ?? "",
    maxDrawdown: m.maxDrawdown ?? m.max_drawdown_pct ?? "",
    profitFactor: m.profitFactor ?? m.profit_factor ?? "",
    sharpe: m.sharpe ?? "",
    totalTrades: m.totalTrades ?? m.total_trades ?? "",
    finalCapital: m.finalCapital ?? "",
  };
}

function buildSummaryCsv(records) {
  const headers = [
    "id", "timestamp", "symbol", "strategy", "timeframe", "period",
    "total_return_pct", "win_rate_pct", "max_drawdown_pct",
    "profit_factor", "sharpe", "total_trades", "final_capital",
  ];
  const lines = [headers.join(",")];
  for (const rec of records) {
    const r = metricsToRow(rec);
    lines.push([
      r.id, r.timestamp, r.symbol, r.strategy, r.timeframe, r.period,
      r.totalReturn, r.winRate, r.maxDrawdown, r.profitFactor, r.sharpe,
      r.totalTrades, r.finalCapital,
    ].map(escapeCsv).join(","));
  }
  return lines.join("\n");
}

function buildTradesCsv(records) {
  const headers = [
    "backtest_id", "strategy", "symbol", "trade_date", "side",
    "entry", "exit", "pnl", "pnl_pct", "fee", "reason",
  ];
  const lines = [headers.join(",")];
  for (const rec of records) {
    const trades = rec.trades_data || [];
    const strategy = rec.strategy_key || rec.config?.strategyKey || "";
    for (const t of trades) {
      lines.push([
        rec.id, strategy, rec.symbol, t.date, t.side,
        t.entry, t.exit, t.pnl, t.pnlPct ?? t.pnl_pct, t.fee, t.reason,
      ].map(escapeCsv).join(","));
    }
  }
  return lines.join("\n");
}

function exportBacktests(records, mode = "summary") {
  if (mode === "trades") return buildTradesCsv(records);
  return buildSummaryCsv(records);
}

module.exports = { exportBacktests, buildSummaryCsv, buildTradesCsv };
