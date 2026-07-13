/**
 * tradeExportCsv.js — kolom & helper CSV export trade (selaras admin Trade History).
 */

/** Kolom user-facing (history.js GET /trades?format=csv) */
const TRADE_EXPORT_COLUMNS = [
  ["id",          "ID"],
  ["sessionId",   "Session ID"],
  ["symbol",      "Symbol"],
  ["side",        "Side"],
  ["strategy",    "Strategy"],
  ["status",      "Status"],
  ["entryPrice",  "Entry Price"],
  ["exitPrice",   "Exit Price"],
  ["sl",          "SL"],
  ["tp",          "TP"],
  ["size",        "Size"],
  ["pnl",         "PnL Gross"],
  ["fee",         "Fee"],
  ["funding",     "Funding"],
  ["pnlNet",      "PnL Net"],
  ["pnlPct",      "PnL %"],
  ["plannedRR",   "Planned R:R"],
  ["actualRR",    "Actual R:R"],
  ["duration",    "Duration"],
  ["reason",      "Reason"],
  ["exitReason",  "Exit Reason"],
  ["entryReasons","Entry Reasons"],
  ["confidence",  "Confidence"],
  ["marketCond",  "Market Cond"],
  ["htfTrend",    "HTF Trend"],
  ["dailyRegime", "Daily Regime"],
  ["component",   "Component"],
  ["tradeType",   "Trade Type"],
  ["atr",         "ATR"],
  ["entryRsi",    "Entry RSI"],
  // Sprint 13 — SMC Scalping ML / confidence forensics
  ["sweepStrength", "Sweep Strength"],
  ["fvgSizeAtr", "FVG Size ATR"],
  ["obDistanceAtr", "OB Distance ATR"],
  ["displacementPct", "Displacement %"],
  ["htfAdx", "HTF ADX"],
  ["hourUtc", "Hour UTC"],
  ["volumeRatio", "Volume Ratio"],
  ["bbWidth", "BB Width"],
  ["confSweepStrength", "Conf Sweep"],
  ["confFvgSize", "Conf FVG"],
  ["confDisplacementPct", "Conf Disp %"],
  ["confHtfAlignment", "Conf HTF Align"],
  ["dryRun",      "DryRun"],
  ["mode",        "Mode"],
  ["exchange",    "Exchange"],
  ["openTime",    "Open Time"],
  ["closeTime",   "Close Time"],
  ["isPartial",   "Is Partial"],
  ["result",      "Result"],
];

/** Admin export — kolom User di depan (admin.js GET /admin/trades/export) */
const ADMIN_TRADE_EXPORT_COLUMNS = [
  ["user", "User"],
  ...TRADE_EXPORT_COLUMNS,
];

function escapeCsv(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function toCsv(data, columns = TRADE_EXPORT_COLUMNS) {
  const header = columns.map(([, label]) => label).join(",");
  const rows = data.map(r =>
    columns.map(([key]) => escapeCsv(r[key])).join(",")
  );
  return [header, ...rows].join("\n");
}

function buildPerformanceSummaryCsv(data) {
  const closed = data.filter(r => r.status === "Closed");
  const wins = closed.filter(r => r.result === "win").length;
  const losses = closed.filter(r => r.result === "loss").length;
  const open = data.filter(r => r.status === "Open").length;
  const cancelled = data.filter(r => r.status === "Cancelled").length;
  const netPnl = closed.reduce((s, r) => s + (Number(r.pnlNet) || 0), 0);
  const winRate = closed.length ? ((wins / closed.length) * 100).toFixed(1) : "0.0";

  const metrics = [
    ["Performance Summary", ""],
    ["Total Trades (exported)", data.length],
    ["Closed Trades", closed.length],
    ["Open Trades", open],
    ["Cancelled Trades", cancelled],
    ["Wins", wins],
    ["Losses", losses],
    ["Win Rate %", winRate],
    ["Net PnL", netPnl.toFixed(4)],
  ];
  const rows = metrics.map(([m, v]) => `${escapeCsv(m)},${escapeCsv(v)}`);
  return ["Metric,Value", ...rows].join("\n");
}

module.exports = {
  TRADE_EXPORT_COLUMNS,
  ADMIN_TRADE_EXPORT_COLUMNS,
  escapeCsv,
  toCsv,
  buildPerformanceSummaryCsv,
};
