/**
 * tradeExportCsv.js — kolom & helper CSV export trade (selaras admin Trade History).
 *
 * Export variants:
 * - Core (25): ADMIN_TRADE_EXPORT_COLUMNS — compact essentials
 * - Full (31 base + ML union): core + geometry + ML_FIELD_SETS for strategies in batch
 */

const { normalizeStrategyKey } = require("../../config/strategyKeyNormalizer");

/** Kolom user-facing (history.js GET /trades?format=csv) */
const TRADE_EXPORT_COLUMNS = [
  ["id",           "ID"],
  ["symbol",       "Symbol"],
  ["side",         "Side"],
  ["strategy",     "Strategy"],
  ["component",    "Component"],
  ["tradeType",    "Trade Type"],
  ["entryPrice",   "Entry Price"],
  ["exitPrice",    "Exit Price"],
  ["pnl",          "PnL Gross"],
  ["fee",          "Fee"],
  ["pnlNet",       "PnL Net"],
  ["result",       "Result"],
  ["confidence",   "Confidence"],
  ["htfTrend",     "HTF Trend"],
  ["dailyRegime",  "Daily Regime"],
  ["session",      "Session"],
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

/**
 * Backtest/user export core columns. No "User" — backtest & user files belong to
 * a single user, so the column is dead weight (see Quantara export review). The
 * admin multi-user export (admin.js GET /admin/trades/export) prepends its own
 * "User" column since it genuinely spans users.
 */
const ADMIN_TRADE_EXPORT_COLUMNS = [
  ...TRADE_EXPORT_COLUMNS,
];

/** Geometry columns appended after core for Full export (not in Core 24). */
const FULL_EXPORT_GEOMETRY_COLUMNS = [
  ["sl", "SL"],
  ["tp", "TP"],
  ["size", "Size"],
  ["funding", "Funding"],
  ["pnlPct", "PnL %"],
  ["plannedRR", "Planned R:R"],
  ["actualRR", "Actual R:R"],
  ["mfe", "MFE"],
  ["mae", "MAE"],
  ["mfePercent", "MFE %"],
  ["maePercent", "MAE %"],
  ["exitEfficiency", "Exit Efficiency"],
];

/**
 * @deprecated Legacy 37-col Full superset (sessionId, status, marketCond, …).
 * Use buildFullExportColumns() — 31 base + dynamic ML union.
 */
const FULL_TRADE_EXPORT_COLUMNS = [
  ["id", "ID"],
  ["sessionId", "Session ID"],
  ["symbol", "Symbol"],
  ["side", "Side"],
  ["strategy", "Strategy"],
  ["status", "Status"],
  ["entryPrice", "Entry Price"],
  ["exitPrice", "Exit Price"],
  ["sl", "SL"],
  ["tp", "TP"],
  ["size", "Size"],
  ["pnl", "PnL Gross"],
  ["fee", "Fee"],
  ["funding", "Funding"],
  ["pnlNet", "PnL Net"],
  ["pnlPct", "PnL %"],
  ["plannedRR", "Planned R:R"],
  ["actualRR", "Actual R:R"],
  ["confidence", "Confidence"],
  ["htfTrend", "HTF Trend"],
  ["marketCond", "Market Cond"],
  ["dailyRegime", "Daily Regime"],
  ["session", "Session"],
  ["atr", "ATR"],
  ["entryRsi", "Entry RSI"],
  ["component", "Component"],
  ["duration", "Duration"],
  ["reason", "Reason"],
  ["exitReason", "Exit Reason"],
  ["entryReasons", "Entry Reasons"],
  ["dryRun", "DryRun"],
  ["mode", "Mode"],
  ["exchange", "Exchange"],
  ["openTime", "Open Time"],
  ["closeTime", "Close Time"],
  ["isPartial", "Is Partial"],
  ["result", "Result"],
];

const FULL_TRADE_EXPORT_COLUMN_KEYS = FULL_TRADE_EXPORT_COLUMNS.map(([k]) => k);

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
  // No "User" prepend: backtest/user exports are single-user. The admin
  // multi-user export adds its own User column (admin.js). adminFormat is kept
  // for signature compat but no longer injects a column.
  void adminFormat;
  return TRADE_EXPORT_COLUMNS.filter(([k]) => keySet.has(k));
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
  SMART_MONEY_CONCEPTS: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "sweepStrength", "fvgSizeAtr", "obDistanceAtr", "displacementPct",
    "htfAdx", "confSweepStrength", "confFvgSize",
    "confDisplacementPct", "confHtfAlignment", "confMitigationDepth", "confObConfluence",
    "sweepAgeBars", "sweepToChochBars", "chochToEntryBars",
  ]),
  BREAKOUT_RETEST: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "bbSqueezeWidthAtr", "breakoutVolumeRatio", "retestDepthAtr", "rejectionWickPct",
    "consolidationBars", "breakoutCandleAtr", "fundingRateAtEntry", "fundingForecast24h",
    "holdHours", "volumeRatio", "bbWidth",
  ]),
  AUCTION_MARKET_THEORY: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "vpVwapLevel", "vpVahLevel", "vpValLevel", "vpPocLevel", "vpTriggerType",
  ]),
  TREND_FOLLOWING: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "tfAdxStrength", "tfDonchianPeriod", "tfBarsInTrend",
    "tfVolRatio", "tfHtfTrendConfirmed", "tfEmaCrossover",
  ]),
  MARKET_STRUCTURE: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "msSwingHighPrice", "msSwingLowPrice", "msPullbackDepthAtr",
    "msHhPattern", "msLlPattern", "msPullbackConfirmed",
  ]),
  MEAN_REVERSION: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "mrRsiValue", "mrBbMidLevel", "mrBbUpperLevel", "mrBbLowerLevel",
    "mrVwapLevel", "mrVwapDeviation", "mrAdxRegime",
  ]),
  SUPPLY_AND_DEMAND: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "sdZoneType", "sdZoneLevel", "sdZoneSizeAtr", "sdRetestDepthAtr",
    "sdVolumeConfirmation", "sdTimeToRetestBars", "sdConfluence",
  ]),
  STATISTICAL_ARBITRAGE: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "saZScore", "saMaValue", "saStdDev", "saUpperBand",
    "saLowerBand", "saBandTouch", "saMeanRevertBars",
  ]),
  WYCKOFF: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "wyPatternType", "wyAccumulationBars", "wyFakeBreakDepthAtr", "wyReclameBars",
    "wyVolumeRatio", "wySosOrSow", "wyLpsLevel",
  ]),
  VOLUME_SPREAD_ANALYSIS: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "vsaPatternType", "vsaSpread", "vsaVolume", "vsaAvgSpread",
    "vsaAvgVolume", "vsaSwingProximity", "vsaReversal",
  ]),
  ICT_STYLE_TRADING: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "ictKillZoneHour", "ictKillZoneLevel", "ictRaidType", "ictRaidDepthAtr",
    "ictVolumeRatio", "ictReversal", "ictMssPct",
  ]),
  LIQUIDATION_SQUEEZE: Object.freeze([
    "gradedScore", "gradedScoreBreakdown", "scoringStrategyKey",
    "lsOiValue", "lsOiPercentile", "lsBbWidth", "lsBbWidthPercentile",
    "lsLiquidationLevel", "lsWickDepthAtr", "lsOiForecast24h",
  ]),
});

/** Short labels for strategy-specific XLSX sheet names (e.g. SMC_specific). */
const ML_STRATEGY_SHORT_LABELS = Object.freeze({
  SMART_MONEY_CONCEPTS: "SMC",
  ICT_STYLE_TRADING: "ICT",
  SUPPLY_AND_DEMAND: "S&D",
  TREND_FOLLOWING: "TF",
  MEAN_REVERSION: "MR",
  BREAKOUT_RETEST: "BR",
  MARKET_STRUCTURE: "MS",
  WYCKOFF: "Wyckoff",
  VOLUME_SPREAD_ANALYSIS: "VSA",
  AUCTION_MARKET_THEORY: "AMT",
  STATISTICAL_ARBITRAGE: "StatArb",
  LIQUIDATION_SQUEEZE: "LiqSqz",
});

const ML_STRATEGY_ALIASES = Object.freeze({
  "TREND FOLLOWING": "TREND_FOLLOWING",
  MARKET_STRUCTURE: "MARKET_STRUCTURE",
  "MARKET STRUCTURE": "MARKET_STRUCTURE",
  VOLUME_PROFILE: "AUCTION_MARKET_THEORY",
  "VOLUME PROFILE": "AUCTION_MARKET_THEORY",
  "MEAN REVERSION": "MEAN_REVERSION",
  SUPPLY_AND_DEMAND: "SUPPLY_AND_DEMAND",
  "SUPPLY AND DEMAND": "SUPPLY_AND_DEMAND",
  STATISTICAL_ARBITRAGE: "STATISTICAL_ARBITRAGE",
  "STATISTICAL ARBITRAGE": "STATISTICAL_ARBITRAGE",
  "BREAKOUT RETEST": "BREAKOUT_RETEST",
  BREAKOUT_TRADING: "BREAKOUT_RETEST",
  "BREAKOUT TRADING": "BREAKOUT_RETEST",
  "SMART MONEY CONCEPTS": "SMART_MONEY_CONCEPTS",
  "ADAPTIVE FUSION": "SMART_MONEY_CONCEPTS",
  WYCKOFF: "WYCKOFF",
  VSA: "VOLUME_SPREAD_ANALYSIS",
  "VOLUME SPREAD ANALYSIS": "VOLUME_SPREAD_ANALYSIS",
  VOLUME_SPREAD_ANALYSIS: "VOLUME_SPREAD_ANALYSIS",
  ICT: "ICT_STYLE_TRADING",
  "ICT-STYLE TRADING": "ICT_STYLE_TRADING",
  "ICT STYLE TRADING": "ICT_STYLE_TRADING",
  ICT_STYLE_TRADING: "ICT_STYLE_TRADING",
  LIQUIDATION_SQUEEZE: "LIQUIDATION_SQUEEZE",
  "LIQUIDATION SQUEEZE": "LIQUIDATION_SQUEEZE",
});

function normalizeMlStrategyKey(key) {
  const raw = String(key || "").trim().toUpperCase();
  if (!raw) return "";
  const acl = normalizeStrategyKey(raw);
  if (ML_FIELD_SETS[acl]) return acl;
  if (ML_STRATEGY_ALIASES[acl]) return ML_STRATEGY_ALIASES[acl];
  if (ML_FIELD_SETS[raw]) return raw;
  if (ML_STRATEGY_ALIASES[raw]) return ML_STRATEGY_ALIASES[raw];
  // "ICT-style trading" → ICT_STYLE_TRADING / ICT-STYLE TRADING
  const underscored = raw.replace(/[\s\-]+/g, "_");
  if (ML_FIELD_SETS[underscored]) return underscored;
  if (ML_STRATEGY_ALIASES[underscored]) return ML_STRATEGY_ALIASES[underscored];
  const spaced = raw.replace(/[\s\-_]+/g, " ");
  if (ML_STRATEGY_ALIASES[spaced]) return ML_STRATEGY_ALIASES[spaced];
  return raw;
}

/** camelCase ML field key → human header label (e.g. sweepStrength → "Sweep Strength"). */
function mlFieldLabel(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAtr\b/g, "ATR")
    .replace(/\bRr\b/g, "R:R")
    .replace(/\bPct\b/g, "%")
    .replace(/\bUtc\b/g, "UTC")
    .replace(/\bHtf\b/g, "HTF")
    .replace(/\bOb\b/g, "OB")
    .replace(/\bFvg\b/g, "FVG")
    .replace(/\bBb\b/g, "BB")
    .replace(/\bOi\b/g, "OI");
}

function resolveMlStrategyList(rows, strategies) {
  let stratList = Array.isArray(strategies) && strategies.length
    ? strategies.map(normalizeMlStrategyKey).filter((k) => ML_FIELD_SETS[k])
    : [...new Set((rows || []).map(resolveTradeMlStrategyKey).filter(Boolean))];
  const order = Object.keys(ML_FIELD_SETS);
  return order.filter((k) => stratList.includes(k));
}

function buildMlExportColumns(stratList) {
  const mlCols = [];
  const seen = new Set();
  for (const strat of stratList) {
    for (const f of ML_FIELD_SETS[strat]) {
      if (seen.has(f)) continue;
      seen.add(f);
      mlCols.push([f, mlFieldLabel(f)]);
    }
  }
  return mlCols;
}

/**
 * Full export columns: 24 core + 7 geometry + union ML_FIELD_SETS for strategies
 * present in the batch (no SMC downgrade).
 * @param {object[]} rows — mapped trade rows (mapBacktestTrade output)
 * @param {{ adminFormat?: boolean, strategies?: string[]|null }} [opts]
 * @returns {Array<[string,string]>} column [key,label] tuples
 */
function buildFullExportColumns(rows, { adminFormat = true, strategies = null } = {}) {
  const coreCols = adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : TRADE_EXPORT_COLUMNS;
  const stratList = resolveMlStrategyList(rows, strategies);
  const mlCols = buildMlExportColumns(stratList);
  return [...coreCols, ...FULL_EXPORT_GEOMETRY_COLUMNS, ...mlCols];
}

/**
 * Specific export columns (flat CSV): CORE columns + the ML feature columns of
 * every strategy present in the rows (no geometry — use buildFullExportColumns).
 * @param {object[]} rows — mapped trade rows (mapBacktestTrade output)
 * @param {{ adminFormat?: boolean, strategies?: string[]|null }} [opts]
 * @returns {Array<[string,string]>} column [key,label] tuples
 */
function buildSpecificExportColumns(rows, { adminFormat = true, strategies = null } = {}) {
  const coreCols = adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : TRADE_EXPORT_COLUMNS;
  const stratList = resolveMlStrategyList(rows, strategies);
  const mlCols = buildMlExportColumns(stratList);
  return [...coreCols, ...mlCols];
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
    const v = trade?.[f];
    out[f] = v == null || v === "N/A" || v === "" ? null : v;
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

function specificSheetName(strat) {
  const short = ML_STRATEGY_SHORT_LABELS[strat] || strat;
  return `${short}_specific`.slice(0, 31);
}

/**
 * Build multi-sheet XLSX workbook buffer.
 * - coreOnly: single "User Export" sheet (24 CORE columns, all strategies merged).
 * - strategy mode: one self-contained "<SHORT>_specific" sheet per strategy
 *   (CORE + that strategy's ML columns merged; no separate User Export / ML_* sheets).
 *
 * @param {object[]} trades — mapped trade rows (mapBacktestTrade output)
 * @param {string[]|null} selectedStrategies — subset of ML_FIELD_SETS keys; null/[] = auto from trades
 * @param {{ adminFormat?: boolean, coreOnly?: boolean }} [opts]
 * @returns {Buffer}
 */
function buildDynamicMultiSheetXlsx(trades, selectedStrategies = null, opts = {}) {
  const XLSX = require("xlsx");
  const wb = XLSX.utils.book_new();
  const rows = Array.isArray(trades) ? trades : [];
  const adminFormat = opts.adminFormat !== false;
  const coreCols = adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : TRADE_EXPORT_COLUMNS;

  if (opts.coreOnly) {
    const coreAoA = [
      coreCols.map(([, label]) => label),
      ...rows.map((r) => coreCols.map(([key]) => {
        const v = r?.[key];
        return v === undefined || v === null || v === "N/A" ? "" : v;
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(coreAoA), "User Export");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  }

  let stratList = Array.isArray(selectedStrategies) && selectedStrategies.length
    ? selectedStrategies.map(normalizeMlStrategyKey).filter((k) => ML_FIELD_SETS[k])
    : [...new Set(rows.map(resolveTradeMlStrategyKey).filter(Boolean))];

  const order = Object.keys(ML_FIELD_SETS);
  stratList = order.filter((k) => stratList.includes(k));

  for (const strat of stratList) {
    const stratRows = rows.filter((t) => resolveTradeMlStrategyKey(t) === strat);
    if (!stratRows.length) continue;

    const cols = buildFullExportColumns(stratRows, { adminFormat, strategies: [strat] });
    const aoa = [
      cols.map(([, label]) => label),
      ...stratRows.map((r) => cols.map(([key]) => {
        const v = r?.[key];
        return v === undefined || v === null || v === "N/A" ? "" : v;
      })),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), specificSheetName(strat));
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

module.exports = {
  TRADE_EXPORT_COLUMNS,
  ADMIN_TRADE_EXPORT_COLUMNS,
  FULL_EXPORT_GEOMETRY_COLUMNS,
  FULL_TRADE_EXPORT_COLUMNS,
  TRADE_EXPORT_COLUMN_KEYS,
  FULL_TRADE_EXPORT_COLUMN_KEYS,
  DROPPED_ML_CSV_COLUMN_KEYS,
  ML_FIELD_SETS,
  ML_STRATEGY_SHORT_LABELS,
  ML_STRATEGY_ALIASES,
  specificSheetName,
  escapeCsv,
  toCsv,
  pickExportColumns,
  buildPerformanceSummaryCsv,
  projectMlFields,
  normalizeMlStrategyKey,
  resolveTradeMlStrategyKey,
  buildDynamicMultiSheetXlsx,
  buildFullExportColumns,
  buildSpecificExportColumns,
  mlFieldLabel,
};
