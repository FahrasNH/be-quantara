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

/**
 * Per-strategy ML columns for Dynamic ML multi-sheet export (Sprint 15).
 * Keys must match trade object fields populated by strategy enrichment.
 */
const ML_FIELD_SETS = Object.freeze({
  AF_SMC: Object.freeze([
    "sweepStrength", "fvgSizeAtr", "obDistanceAtr", "displacementPct",
    "htfAdx", "hourUtc", "confSweepStrength", "confFvgSize",
    "confDisplacementPct", "confHtfAlignment", "confMitigationDepth", "confObConfluence",
  ]),
  BS_BR: Object.freeze([
    "bbSqueezeWidthAtr", "breakoutVolumeRatio", "retestDepthAtr", "rejectionWickPct",
    "consolidationBars", "breakoutCandleAtr", "fundingRateAtEntry", "fundingForecast24h",
    "holdHours", "volumeRatio", "bbWidth",
  ]),
  TS_VP: Object.freeze([
    "vpVwapLevel", "vpVahLevel", "vpValLevel", "vpPocLevel", "vpTriggerType",
  ]),
  TS_TF: Object.freeze([
    "tfAdxStrength", "tfDonchianPeriod", "tfBarsInTrend",
    "tfVolRatio", "tfHtfTrendConfirmed", "tfEmaCrossover",
  ]),
  TS_MS: Object.freeze([
    "msSwingHighPrice", "msSwingLowPrice", "msPullbackDepthAtr",
    "msHhPattern", "msLlPattern", "msPullbackConfirmed",
  ]),
  MD_MR: Object.freeze([
    "mrRsiValue", "mrBbMidLevel", "mrBbUpperLevel", "mrBbLowerLevel",
    "mrVwapLevel", "mrVwapDeviation", "mrAdxRegime",
  ]),
  MD_SD: Object.freeze([
    "sdZoneType", "sdZoneLevel", "sdZoneSizeAtr", "sdRetestDepthAtr",
    "sdVolumeConfirmation", "sdTimeToRetestBars", "sdConfluence",
  ]),
  MD_SA: Object.freeze([
    "saZScore", "saMaValue", "saStdDev", "saUpperBand",
    "saLowerBand", "saBandTouch", "saMeanRevertBars",
  ]),
  AF_WYCKOFF: Object.freeze([
    "wyPatternType", "wyAccumulationBars", "wyFakeBreakDepthAtr", "wyReclameBars",
    "wyVolumeRatio", "wySosOrSow", "wyLpsLevel",
  ]),
  AF_VSA: Object.freeze([
    "vsaPatternType", "vsaSpread", "vsaVolume", "vsaAvgSpread",
    "vsaAvgVolume", "vsaSwingProximity", "vsaReversal",
  ]),
  BS_ICT: Object.freeze([
    "ictKillZoneHour", "ictKillZoneLevel", "ictRaidType", "ictRaidDepthAtr",
    "ictVolumeRatio", "ictReversal", "ictMssPct",
  ]),
  BS_LS: Object.freeze([
    "lsOiValue", "lsOiPercentile", "lsBbWidth", "lsBbWidthPercentile",
    "lsLiquidationLevel", "lsWickDepthAtr", "lsOiForecast24h",
  ]),
});

const ML_STRATEGY_ALIASES = Object.freeze({
  TREND_FOLLOWING: "TS_TF",
  MARKET_STRUCTURE: "TS_MS",
  VOLUME_PROFILE: "TS_VP",
  MEAN_REVERSION: "MD_MR",
  SUPPLY_AND_DEMAND: "MD_SD",
  STATISTICAL_ARBITRAGE: "MD_SA",
  BREAKOUT_RETEST: "BS_BR",
  BREAKOUT_TRADING: "BS_BR",
  SMART_MONEY_CONCEPTS: "AF_SMC",
  ADAPTIVE_FUSION: "AF_SMC",
  WYCKOFF: "AF_WYCKOFF",
  VSA: "AF_VSA",
  ICT: "BS_ICT",
  LIQUIDATION_SQUEEZE: "BS_LS",
});

function normalizeMlStrategyKey(key) {
  const raw = String(key || "").trim().toUpperCase();
  if (!raw) return "";
  if (ML_FIELD_SETS[raw]) return raw;
  return ML_STRATEGY_ALIASES[raw] || raw;
}

/**
 * Project a trade onto ML columns for a strategy (ML_* sheet rows).
 * @param {object} trade
 * @param {string} strategyKey
 * @returns {Record<string, unknown>}
 */
function projectMlFields(trade, strategyKey) {
  const key = normalizeMlStrategyKey(strategyKey);
  const fields = ML_FIELD_SETS[key] || [];
  const out = {};
  for (const f of fields) {
    out[f] = trade?.[f] ?? null;
  }
  return out;
}

/**
 * Resolve which strategy key a mapped trade row belongs to for ML sheet filtering.
 */
function resolveTradeMlStrategyKey(trade) {
  const candidates = [
    trade?.winningComponent,
    trade?.component,
    trade?.strategyKey,
    trade?.strategy,
  ];
  for (const c of candidates) {
    const n = normalizeMlStrategyKey(c);
    if (n && ML_FIELD_SETS[n]) return n;
  }
  return "";
}

/**
 * Build Dynamic ML multi-sheet XLSX workbook buffer.
 * Sheet 1 = User Export (CORE columns). Sheets 2+ = ML_<STRAT> for each
 * selected strategy that has at least one trade.
 *
 * @param {object[]} trades — mapped trade rows (mapBacktestTrade output)
 * @param {string[]|null} selectedStrategies — subset of ML_FIELD_SETS keys; null = auto from trades
 * @param {{ adminFormat?: boolean }} [opts]
 * @returns {Buffer}
 */
function buildDynamicMultiSheetXlsx(trades, selectedStrategies = null, opts = {}) {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  const rows = Array.isArray(trades) ? trades : [];

  const coreCols = opts.adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : TRADE_EXPORT_COLUMNS;
  const coreAoA = [
    coreCols.map(([, label]) => label),
    ...rows.map((r) => coreCols.map(([key]) => {
      const v = r?.[key];
      return v === undefined || v === null ? "" : v;
    })),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(coreAoA), "User Export");

  let stratList = Array.isArray(selectedStrategies) && selectedStrategies.length
    ? selectedStrategies.map(normalizeMlStrategyKey).filter((k) => ML_FIELD_SETS[k])
    : [...new Set(rows.map(resolveTradeMlStrategyKey).filter(Boolean))];

  // Stable order: follow ML_FIELD_SETS declaration order
  const order = Object.keys(ML_FIELD_SETS);
  stratList = order.filter((k) => stratList.includes(k));

  for (const strat of stratList) {
    const fields = ML_FIELD_SETS[strat] || [];
    if (!fields.length) continue;
    const mlRows = rows.filter((t) => resolveTradeMlStrategyKey(t) === strat);
    if (!mlRows.length) continue;

    const headers = ["id", "symbol", "side", "component", "openTime", "closeTime", "pnlNet", "result", ...fields];
    const aoa = [
      headers,
      ...mlRows.map((r) => {
        const ml = projectMlFields(r, strat);
        return headers.map((h) => {
          if (h in ml) return ml[h] ?? "";
          const v = r?.[h];
          return v === undefined || v === null ? "" : v;
        });
      }),
    ];
    const sheetName = `ML_${strat}`.slice(0, 31);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = {
  TRADE_EXPORT_COLUMNS,
  ADMIN_TRADE_EXPORT_COLUMNS,
  TRADE_EXPORT_COLUMN_KEYS,
  DROPPED_ML_CSV_COLUMN_KEYS,
  ML_FIELD_SETS,
  ML_STRATEGY_ALIASES,
  escapeCsv,
  toCsv,
  pickExportColumns,
  buildPerformanceSummaryCsv,
  projectMlFields,
  normalizeMlStrategyKey,
  resolveTradeMlStrategyKey,
  buildDynamicMultiSheetXlsx,
};
