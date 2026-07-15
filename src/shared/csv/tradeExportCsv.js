/**
 * tradeExportCsv.js — kolom & helper CSV export trade (selaras admin Trade History).
 *
 * Sprint 14 redesign: ~20 CORE universal columns + strategy-aware `Entry Reasons`.
 * Stale ML numerics (sweepStrength, conf*, bbSqueezeWidthAtr, …) are NOT exported
 * here — ML datasets use SMC_ML_CSV_COLUMNS / dedicated expand scripts.
 */

/** Kolom user-facing (history.js GET /trades?format=csv) */
const TRADE_EXPORT_COLUMNS = [
  ["id",           "ID"],
  ["symbol",       "Symbol"],
  ["side",         "Side"],
  ["strategy",     "Strategy"],
  ["component",    "Component"],
  ["entryPrice",   "Entry Price"],
  ["exitPrice",    "Exit Price"],
  ["pnl",          "PnL Gross"],
  ["fee",          "Fee"],
  ["pnlNet",       "PnL Net"],
  ["result",       "Result"],
  ["confidence",   "Confidence"],
  ["htfTrend",     "HTF Trend"],
  ["dailyRegime",  "Daily Regime"],
  ["atr",          "ATR"],
  ["entryReasons", "Entry Reasons"],
  ["exitReason",   "Exit Reason"],
  ["duration",     "Duration"],
  ["openTime",     "Open Time"],
  ["closeTime",    "Close Time"],
  ["mode",         "Mode"],
  ["exchange",     "Exchange"],
  ["dryRun",       "DryRun"],
];

/** Admin export — kolom User di depan (admin.js GET /admin/trades/export) */
const ADMIN_TRADE_EXPORT_COLUMNS = [
  ["user", "User"],
  ...TRADE_EXPORT_COLUMNS,
];

/** Stale ML / forensics columns removed from human-readable CSV exports. */
const DROPPED_ML_CSV_COLUMN_KEYS = Object.freeze([
  "sweepStrength",
  "fvgSizeAtr",
  "obDistanceAtr",
  "displacementPct",
  "htfAdx",
  "hourUtc",
  "volumeRatio",
  "bbWidth",
  "bbSqueezeWidthAtr",
  "breakoutVolumeRatio",
  "retestDepthAtr",
  "rejectionWickPct",
  "consolidationBars",
  "breakoutCandleAtr",
  "fundingRateAtEntry",
  "fundingForecast24h",
  "holdHours",
  "confSweepStrength",
  "confFvgSize",
  "confDisplacementPct",
  "confHtfAlignment",
  "confMitigationDepth",
  "confObConfluence",
]);

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

/** Master column order (keys only) — used to preserve stable CSV header ordering. */
const TRADE_EXPORT_COLUMN_KEYS = TRADE_EXPORT_COLUMNS.map(([k]) => k);

/**
 * Pick [key, label] tuples for export from a resolved key list.
 * @param {string[]} columnKeys
 * @param {{ adminFormat?: boolean }} [opts]
 * @returns {[string, string][]}
 */
function pickExportColumns(columnKeys, { adminFormat = false } = {}) {
  const keySet = new Set(columnKeys);
  const cols = TRADE_EXPORT_COLUMNS.filter(([k]) => keySet.has(k));
  return adminFormat ? [["user", "User"], ...cols] : cols;
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
  TRADE_EXPORT_COLUMN_KEYS,
  DROPPED_ML_CSV_COLUMN_KEYS,
  escapeCsv,
  toCsv,
  pickExportColumns,
  buildPerformanceSummaryCsv,
};
