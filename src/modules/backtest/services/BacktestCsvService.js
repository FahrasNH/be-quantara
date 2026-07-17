/**
 * BacktestCsvService — export backtest runs ke CSV (format Trade History admin).
 *
 * Strategy Reason Formatters — Per-Strategy Entry Reason Assembly
 *
 * Each strategy has distinct entry-trigger vocabulary (not generic across all).
 * mapBacktestTrade routes trade.entryMeta via resolveEntryReasons().
 *
 * Supported strategies & their reason variability:
 * - SMART_MONEY_CONCEPTS: Hard-gate (sweep+CHoCH+FVG=prerequisites) → low variance
 * - WYCKOFF: Multi-item checklist → very low variance
 * - VOLUME_SPREAD_ANALYSIS: 4 patterns × 3 locations → medium variance
 * - TREND_FOLLOWING: 3-layer checklist → very low variance
 * - MARKET_STRUCTURE: 4-layer checklist → very low variance
 * - AUCTION_MARKET_THEORY: 1-of-4 mutually-exclusive → low variance
 * - MEAN_REVERSION: Hybrid (hard entry + soft regime/confluence) → HIGHEST variance
 * - BREAKOUT_RETEST: 3-phase sequential → very low variance
 *
 * Umbrellas use race-to-confirm: exactly ONE component wins per bar.
 * Trade attribution shows winning component key (SMART_MONEY_CONCEPTS, WYCKOFF, etc).
 *
 * Umbrella_Component scheme: AF_* / TS_* / MEAN_REVERSION / BREAKOUT_RETEST (see strategyReasonFormatters.js).
 */

const { formatDuration } = require("../../../infrastructure/db/database");
const {
  TRADE_EXPORT_COLUMN_KEYS,
  FULL_TRADE_EXPORT_COLUMNS,
  ADMIN_TRADE_EXPORT_COLUMNS,
  pickExportColumns,
  toCsv,
  buildPerformanceSummaryCsv,
  buildDynamicMultiSheetXlsx,
  buildSpecificExportColumns,
  normalizeMlStrategyKey,
} = require("#shared/csv/tradeExportCsv.js");
const {
  formatExitReason,
  resolveEntryReasons,
  normalizeStrategyKey,
  resolveExportColumnKeys,
} = require("../../../server/services/csv/strategyReasonFormatters");

const NA = "N/A";

const TYPE_TRADE_CLASSES = ["Scalping", "Intraday", "Swing"];

// Classify a trade by holding period (hours): <=4h Scalping, <=24h Intraday, else Swing.
function classifyTypeTrade(holdHours) {
  if (holdHours == null || !Number.isFinite(holdHours)) return null;
  if (holdHours <= 4) return "Scalping";
  if (holdHours <= 24) return "Intraday";
  return "Swing";
}

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

/**
 * Map satu trade backtest → baris export (skema sama mapExportRow / admin Trade History).
 */
function mapBacktestTrade(trade, ctx, index) {
  const entry = trade.entry ?? trade.entryPrice;
  const exit = trade.exit ?? trade.exitPrice;
  const fee = Number(trade.fee ?? 0);
  const funding = Number(trade.funding ?? 0);
  const grossPnl = trade.grossPnl != null
    ? Number(trade.grossPnl)
    : Number(trade.pnl ?? 0) + fee;
  const pnlNet = trade.pnl != null ? Number(trade.pnl) : grossPnl - fee - funding;
  const size = trade.size ?? null;
  const sl = trade.sl ?? null;
  const tp = trade.tp ?? null;

  const plannedRR =
    sl != null && tp != null && entry != null && Math.abs(entry - sl) > 0
      ? parseFloat((Math.abs(tp - entry) / Math.abs(entry - sl)).toFixed(2))
      : NA;
  const plannedRisk =
    sl != null && size != null && entry != null ? Math.abs(entry - sl) * size : null;
  const actualRR =
    plannedRisk && plannedRisk > 0
      ? parseFloat((pnlNet / plannedRisk).toFixed(2))
      : NA;

  const openTime = trade.openTime ?? trade.openDate ?? trade.date ?? NA;
  const closeTime = trade.closeTime ?? trade.date ?? NA;
  let duration = NA;
  let holdHoursNum = null;
  if (openTime !== NA && closeTime !== NA) {
    const ms = new Date(closeTime).getTime() - new Date(openTime).getTime();
    duration = ms > 0 ? formatDuration(ms) : NA;
    holdHoursNum = ms > 0 ? ms / 3_600_000 : null;
  }
  if (holdHoursNum == null && Number.isFinite(Number(trade.holdHours))) {
    holdHoursNum = Number(trade.holdHours);
  }

  const tradeType = TYPE_TRADE_CLASSES.includes(trade.tradeType)
    ? trade.tradeType
    : classifyTypeTrade(holdHoursNum) ?? NA;

  let hourUtc = trade.hourUtc ?? NA;
  if (openTime !== NA) {
    const openHour = new Date(openTime).getUTCHours();
    if (!Number.isNaN(openHour)) hourUtc = openHour;
  }

  const holdHoursOut =
    holdHoursNum != null ? parseFloat(holdHoursNum.toFixed(2)) : (trade.holdHours ?? NA);

  const reason = trade.reason ?? NA;
  const isPartial = /partial/i.test(String(reason));
  const strategyKeyForReasons =
    trade.winningComponent || trade.strategyKey || ctx.strategy;
  const entryMeta = trade.entryMeta || null;
  const conf = trade.confidence;
  const confidenceOut =
    conf == null
      ? NA
      : typeof conf === "object"
        ? (conf.Scalping ?? conf.Intraday ?? conf.Swing ?? conf.A ?? conf.B ?? conf.C ?? NA)
        : conf;

  // Prefer trade-close enrichment; fall back to live resolve from entryMeta.
  const precomputed =
    trade.entryReasons != null && String(trade.entryReasons).trim() !== ""
      ? String(trade.entryReasons).trim()
      : "";
  const entryReasons =
    precomputed || resolveEntryReasons(strategyKeyForReasons, entryMeta) || NA;

  const atrNum = Number(trade.atr);
  const rsiNum = Number(trade.entryRsi);
  const atrOut =
    trade.atr == null || Array.isArray(trade.atr) || !Number.isFinite(atrNum) || atrNum < 0 || atrNum > 1e9
      ? NA
      : atrNum;
  const rsiOut =
    trade.entryRsi == null || Array.isArray(trade.entryRsi) || !Number.isFinite(rsiNum) || rsiNum < 0 || rsiNum > 100
      ? NA
      : rsiNum;

  return {
    user: ctx.userLabel ?? "Backtest",
    id: trade.id ?? `${ctx.backtestId}-${index + 1}`,
    sessionId: ctx.sessionId ?? `BT-${ctx.backtestId}`,
    symbol: ctx.symbol,
    side: trade.side,
    strategy: ctx.strategy,
    // Preserve for Dynamic ML sheet routing (resolveTradeMlStrategyKey order)
    winningComponent: trade.winningComponent ?? null,
    strategyKey: trade.strategyKey ?? strategyKeyForReasons ?? null,
    status: "Closed",
    entryPrice: entry,
    exitPrice: exit,
    sl: sl ?? NA,
    tp: tp ?? NA,
    size: size ?? NA,
    pnl: grossPnl,
    fee,
    funding,
    pnlNet,
    pnlPct: trade.pnlPct ?? trade.pnl_pct ?? NA,
    plannedRR,
    actualRR,
    duration,
    reason,
    exitReason: formatExitReason(reason === NA ? null : reason) || NA,
    entryReasons,
    confidence: confidenceOut,
    marketCond: trade.marketCond ?? NA,
    htfTrend: trade.htfTrend ?? NA,
    dailyRegime: trade.dailyRegime ?? NA,
    component: trade.winningComponent || trade.component || trade.tradeType || NA,
    tradeType,
    atr: atrOut,
    entryRsi: rsiOut,
    sweepStrength: trade.sweepStrength ?? NA,
    fvgSizeAtr: trade.fvgSizeAtr ?? NA,
    obDistanceAtr: trade.obDistanceAtr ?? NA,
    displacementPct: trade.displacementPct ?? NA,
    htfAdx: trade.htfAdx ?? NA,
    hourUtc,
    volumeRatio: trade.volumeRatio ?? NA,
    bbWidth: trade.bbWidth ?? NA,
    bbSqueezeWidthAtr: trade.bbSqueezeWidthAtr ?? NA,
    breakoutVolumeRatio: trade.breakoutVolumeRatio ?? NA,
    retestDepthAtr: trade.retestDepthAtr ?? NA,
    rejectionWickPct: trade.rejectionWickPct ?? NA,
    consolidationBars: trade.consolidationBars ?? NA,
    breakoutCandleAtr: trade.breakoutCandleAtr ?? NA,
    fundingRateAtEntry: trade.fundingRateAtEntry ?? trade.fundingRate ?? NA,
    fundingForecast24h: trade.fundingForecast24h ?? NA,
    holdHours: holdHoursOut,
    confSweepStrength: trade.confSweepStrength ?? NA,
    confFvgSize: trade.confFvgSize ?? NA,
    confDisplacementPct: trade.confDisplacementPct ?? NA,
    confHtfAlignment: trade.confHtfAlignment ?? NA,
    confMitigationDepth: trade.confMitigationDepth ?? NA,
    confObConfluence: trade.confObConfluence ?? NA,
    vpVwapLevel: trade.vpVwapLevel ?? NA,
    vpVahLevel: trade.vpVahLevel ?? NA,
    vpValLevel: trade.vpValLevel ?? NA,
    vpPocLevel: trade.vpPocLevel ?? NA,
    vpTriggerType: trade.vpTriggerType ?? NA,
    // Sprint 15 strategy ML columns
    tfAdxStrength: trade.tfAdxStrength ?? NA,
    tfDonchianPeriod: trade.tfDonchianPeriod ?? NA,
    tfBarsInTrend: trade.tfBarsInTrend ?? NA,
    tfVolRatio: trade.tfVolRatio ?? NA,
    tfHtfTrendConfirmed: trade.tfHtfTrendConfirmed ?? NA,
    tfEmaCrossover: trade.tfEmaCrossover ?? NA,
    msSwingHighPrice: trade.msSwingHighPrice ?? NA,
    msSwingLowPrice: trade.msSwingLowPrice ?? NA,
    msPullbackDepthAtr: trade.msPullbackDepthAtr ?? NA,
    msHhPattern: trade.msHhPattern ?? NA,
    msLlPattern: trade.msLlPattern ?? NA,
    msPullbackConfirmed: trade.msPullbackConfirmed ?? NA,
    mrRsiValue: trade.mrRsiValue ?? NA,
    mrBbMidLevel: trade.mrBbMidLevel ?? NA,
    mrBbUpperLevel: trade.mrBbUpperLevel ?? NA,
    mrBbLowerLevel: trade.mrBbLowerLevel ?? NA,
    mrVwapLevel: trade.mrVwapLevel ?? NA,
    mrVwapDeviation: trade.mrVwapDeviation ?? NA,
    mrAdxRegime: trade.mrAdxRegime ?? NA,
    sdZoneType: trade.sdZoneType ?? NA,
    sdZoneLevel: trade.sdZoneLevel ?? NA,
    sdZoneSizeAtr: trade.sdZoneSizeAtr ?? NA,
    sdRetestDepthAtr: trade.sdRetestDepthAtr ?? NA,
    sdVolumeConfirmation: trade.sdVolumeConfirmation ?? NA,
    sdTimeToRetestBars: trade.sdTimeToRetestBars ?? NA,
    sdConfluence: trade.sdConfluence ?? NA,
    saZScore: trade.saZScore ?? NA,
    saMaValue: trade.saMaValue ?? NA,
    saStdDev: trade.saStdDev ?? NA,
    saUpperBand: trade.saUpperBand ?? NA,
    saLowerBand: trade.saLowerBand ?? NA,
    saBandTouch: trade.saBandTouch ?? NA,
    saMeanRevertBars: trade.saMeanRevertBars ?? NA,
    ictKillZoneHour: trade.ictKillZoneHour ?? NA,
    ictKillZoneLevel: trade.ictKillZoneLevel ?? NA,
    ictRaidType: trade.ictRaidType ?? NA,
    ictRaidDepthAtr: trade.ictRaidDepthAtr ?? NA,
    ictVolumeRatio: trade.ictVolumeRatio ?? NA,
    ictReversal: trade.ictReversal ?? NA,
    ictMssPct: trade.ictMssPct ?? NA,
    lsOiValue: trade.lsOiValue ?? NA,
    lsOiPercentile: trade.lsOiPercentile ?? NA,
    lsBbWidth: trade.lsBbWidth ?? NA,
    lsBbWidthPercentile: trade.lsBbWidthPercentile ?? NA,
    lsLiquidationLevel: trade.lsLiquidationLevel ?? NA,
    lsWickDepthAtr: trade.lsWickDepthAtr ?? NA,
    lsOiForecast24h: trade.lsOiForecast24h ?? NA,
    vsaPatternType: trade.vsaPatternType ?? NA,
    vsaSpread: trade.vsaSpread ?? NA,
    vsaVolume: trade.vsaVolume ?? NA,
    vsaAvgSpread: trade.vsaAvgSpread ?? NA,
    vsaAvgVolume: trade.vsaAvgVolume ?? NA,
    vsaSwingProximity: trade.vsaSwingProximity ?? NA,
    vsaReversal: trade.vsaReversal ?? NA,
    wyPatternType: trade.wyPatternType ?? NA,
    wyAccumulationBars: trade.wyAccumulationBars ?? NA,
    wyFakeBreakDepthAtr: trade.wyFakeBreakDepthAtr ?? NA,
    wyReclameBars: trade.wyReclameBars ?? NA,
    wyVolumeRatio: trade.wyVolumeRatio ?? NA,
    wySosOrSow: trade.wySosOrSow ?? NA,
    wyLpsLevel: trade.wyLpsLevel ?? NA,
    dryRun: true,
    mode: "backtest",
    exchange: ctx.exchange ?? NA,
    openTime,
    closeTime,
    isPartial,
    result: pnlNet > 0 ? "win" : "loss",
  };
}

function collectTradeRows(records, { adminFormat = true } = {}) {
  const rows = [];
  for (const rec of records) {
    const trades = rec.trades_data || [];
    const strategy = rec.strategy_key || rec.config?.strategyKey || "";
    const ctx = {
      backtestId: rec.id,
      symbol: rec.symbol,
      strategy,
      exchange: rec.config?.exchange ?? rec.exchange ?? NA,
      sessionId: `BT-${rec.id}`,
      userLabel: "Backtest",
    };
    trades.forEach((t, i) => rows.push(mapBacktestTrade(t, ctx, i)));
  }
  return rows;
}

function collectExportComponents(rows, records) {
  const fromRows = rows
    .map((r) => r.component)
    .filter((c) => c != null && c !== "" && c !== NA);
  if (fromRows.length) return [...new Set(fromRows)];

  const fromRecords = (records || [])
    .map((rec) => normalizeStrategyKey(rec.strategy_key || rec.config?.strategyKey || ""))
    .filter(Boolean);
  return [...new Set(fromRecords)];
}

/**
 * Resolve CSV columns for a given export variant. The three variants are now
 * genuinely distinct (previously every CSV collapsed to the 37-col Full superset):
 *   - full     → FULL_TRADE_EXPORT_COLUMNS (37): all execution + context columns
 *   - core     → ADMIN_TRADE_EXPORT_COLUMNS (23): compact essentials for quick review
 *   - specific → core (23) + per-strategy ML feature columns (entry-quality analysis)
 */
function resolveVariantColumns(variant, rows, records, { adminFormat = true, strategies = null } = {}) {
  if (variant === "full") return FULL_TRADE_EXPORT_COLUMNS;
  if (variant === "specific") {
    return buildSpecificExportColumns(rows, { adminFormat, strategies });
  }
  if (variant === "core") {
    return adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : ADMIN_TRADE_EXPORT_COLUMNS.slice(1);
  }
  // Legacy strategy-aware auto-pick (unchanged fallback)
  const components = collectExportComponents(rows, records);
  return pickExportColumns(resolveExportColumnKeys(components, TRADE_EXPORT_COLUMN_KEYS), { adminFormat });
}

function buildTradesCsv(records, opts = {}) {
  const { includeSummary = true, adminFormat = true, variant = "auto", strategies = null } = opts;
  const rows = collectTradeRows(records, { adminFormat });
  // Back-compat: fullFormat:true is shorthand for variant:"full".
  const effVariant = opts.fullFormat ? "full" : variant;
  const columns = resolveVariantColumns(effVariant, rows, records, { adminFormat, strategies });
  const body = toCsv(rows, columns);
  if (!includeSummary) return body;
  const summary = buildPerformanceSummaryCsv(rows);
  return `${summary}\n${body}`;
}

/**
 * @param {object[]} records
 * @param {string} [mode="trades"] — "trades" | "summary"
 * @param {{ variant?: "core"|"full"|"specific", strategies?: string[]|null }} [opts]
 */
function exportBacktests(records, mode = "trades", opts = {}) {
  if (mode === "summary") return buildSummaryCsv(records);
  const variant = opts.variant || "full";
  return buildTradesCsv(records, {
    includeSummary: true,
    adminFormat: true,
    variant,
    strategies: opts.strategies || null,
  });
}

/**
 * Sprint 15 Dynamic ML multi-sheet XLSX export.
 * @param {object[]} records — backtest archive rows
 * @param {{ strategies?: string[], adminFormat?: boolean, coreOnly?: boolean }} [opts]
 * @returns {Buffer}
 */
function exportBacktestsXlsx(records, opts = {}) {
  const rows = collectTradeRows(records, { adminFormat: opts.adminFormat !== false });
  const selected = Array.isArray(opts.strategies)
    ? opts.strategies.map(normalizeMlStrategyKey).filter(Boolean)
    : null;
  return buildDynamicMultiSheetXlsx(rows, selected, {
    adminFormat: opts.adminFormat !== false,
    coreOnly: Boolean(opts.coreOnly),
  });
}

module.exports = {
  exportBacktests,
  exportBacktestsXlsx,
  buildSummaryCsv,
  buildTradesCsv,
  mapBacktestTrade,
  collectTradeRows,
  collectExportComponents,
};
