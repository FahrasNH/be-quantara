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
  ADMIN_TRADE_EXPORT_COLUMNS,
  pickExportColumns,
  toCsv,
  buildPerformanceSummaryCsv,
  buildDynamicMultiSheetXlsx,
  buildFullExportColumns,
  normalizeMlStrategyKey,
  resolveTradeMlStrategyKey,
} = require("#shared/csv/tradeExportCsv.js");
const {
  formatExitReason,
  resolveEntryReasons,
  normalizeStrategyKey,
  resolveExportColumnKeys,
} = require("../../../server/services/csv/strategyReasonFormatters");
const { enrichMetaWithGradedScore } = require("../../../core/strategy-engine/scoring/ComponentScoringEngine");
const { extractGradedScoreEnrichment } = require("../../../shared/csv/strategyMlEnrichment");
const { STRATEGIES } = require("#config/strategyDefaults.js");

const NA = "N/A";

const TYPE_TRADE_CLASSES = ["Scalping", "Intraday", "Swing"];

/**
 * Race component → umbrella engine key. Every trade is attributed to the winning
 * component; the Strategy column shows its parent umbrella (what the user picked).
 */
const COMPONENT_TO_ENGINE = {
  SMART_MONEY_CONCEPTS: "SMART_MONEY_CONCEPTS",
  WYCKOFF: "SMART_MONEY_CONCEPTS",
  VOLUME_SPREAD_ANALYSIS: "SMART_MONEY_CONCEPTS",
  TREND_FOLLOWING: "TREND_FOLLOWING",
  MARKET_STRUCTURE: "TREND_FOLLOWING",
  AUCTION_MARKET_THEORY: "TREND_FOLLOWING",
  MEAN_REVERSION: "MEAN_REVERSION",
  SUPPLY_AND_DEMAND: "MEAN_REVERSION",
  STATISTICAL_ARBITRAGE: "MEAN_REVERSION",
  BREAKOUT_RETEST: "BREAKOUT_RETEST",
  ICT_STYLE_TRADING: "BREAKOUT_RETEST",
  LIQUIDATION_SQUEEZE: "BREAKOUT_RETEST",
};

/**
 * Umbrella engine → user-facing umbrella name (what user selected in UI).
 * E.g., SMART_MONEY_CONCEPTS → "Adaptive Fusion", TREND_FOLLOWING → "Trend Surge"
 */
const UMBRELLA_DISPLAY_NAMES = {
  SMART_MONEY_CONCEPTS: "Adaptive Fusion",
  TREND_FOLLOWING: "Trend Surge",
  MEAN_REVERSION: "Mean Drift",
  BREAKOUT_RETEST: "Breakout Storm",
};

/**
 * Get the umbrella display name for any strategy/component key.
 * Wyckoff / VSA / SMC → "Adaptive Fusion"; Dow / AMT / TF → "Trend Surge"; etc.
 */
function getStrategyLabel(key) {
  if (!key) return NA;
  const normalized = normalizeStrategyKey(String(key).toUpperCase());
  const engine = COMPONENT_TO_ENGINE[normalized] || normalized;
  if (UMBRELLA_DISPLAY_NAMES[engine]) return UMBRELLA_DISPLAY_NAMES[engine];

  // Fallback: STRATEGIES label, else title-case the raw key.
  const strat = STRATEGIES[normalized];
  if (strat?.label) return strat.label;
  return String(key)
    .split(/[\s_-]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

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

/**
 * Detect market session from UTC hour (0-23).
 * Sydney: 22:00-06:59 UTC (ASX); Tokyo: 00:00-08:59 UTC (JPX)
 * London: 08:00-16:59 UTC (LSE); New York: 13:00-21:59 UTC (NYSE)
 */
/** Resolve gradedScore fields for CSV / ML export from trade row or entry meta. */
function resolveGradedScoreFields(trade, ctx) {
  const mlKey = resolveTradeMlStrategyKey({
    winningComponent: trade.winningComponent,
    component: trade.component,
    strategyKey: trade.strategyKey,
    strategy: ctx.strategy,
  });
  if (trade.gradedScore != null && trade.gradedScore !== NA) {
    return {
      gradedScore: trade.gradedScore,
      gradedScoreBreakdown: trade.gradedScoreBreakdown ?? NA,
      scoringStrategyKey: trade.scoringStrategyKey ?? mlKey ?? NA,
    };
  }
  if (!mlKey) {
    return { gradedScore: NA, gradedScoreBreakdown: NA, scoringStrategyKey: NA };
  }
  const enriched = enrichMetaWithGradedScore(
    {
      ...trade,
      winningComponent: mlKey,
      tradeType: trade.tradeType ?? trade.component,
    },
    mlKey,
  );
  const graded = extractGradedScoreEnrichment(enriched);
  return {
    gradedScore: graded.gradedScore ?? NA,
    gradedScoreBreakdown: graded.gradedScoreBreakdown ?? NA,
    scoringStrategyKey: graded.scoringStrategyKey ?? mlKey,
  };
}

function detectMarketSession(hourUtc) {
  if (hourUtc == null || !Number.isFinite(Number(hourUtc))) return NA;
  const h = Number(hourUtc);
  if ((h >= 22 && h <= 23) || (h >= 0 && h <= 6)) return "Sydney";
  if (h >= 0 && h <= 8) return "Tokyo"; // Overlaps Sydney early hours (both active)
  if (h >= 8 && h <= 16) return "London";
  if (h >= 13 && h <= 21) return "New York";
  return NA;
}

/**
 * Format ISO datetime to readable UTC: "20 April 2026, 01:25 AM UTC"
 */
function formatDateTime(isoStr) {
  if (!isoStr || isoStr === NA) return NA;
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return NA;
    const day = d.getUTCDate();
    const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const year = d.getUTCFullYear();
    const time = d.toLocaleString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
      timeZone: "UTC"
    });
    return `${day} ${month} ${year}, ${time} UTC`;
  } catch {
    return NA;
  }
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

  // Detect market session from open time
  let session = NA;
  if (openTime !== NA) {
    const openHour = new Date(openTime).getUTCHours();
    if (!Number.isNaN(openHour)) session = detectMarketSession(openHour);
  }
  if (!session || session === NA) {
    session = detectMarketSession(trade.hourUtc) ?? NA;
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

  let hourUtcOut = trade.hourUtc;
  if (hourUtcOut == null && openTime !== NA) {
    const openMs = new Date(openTime).getTime();
    if (Number.isFinite(openMs)) hourUtcOut = new Date(openMs).getUTCHours();
  }
  const gradedFields = resolveGradedScoreFields(trade, ctx);

  return {
    user: ctx.userLabel ?? "Backtest",
    id: trade.id ?? `${ctx.backtestId}-${index + 1}`,
    sessionId: ctx.sessionId ?? `BT-${ctx.backtestId}`,
    symbol: ctx.symbol,
    side: trade.side,
    // Use per-trade component as strategy, with user-friendly label (e.g., "Wyckoff" not "WYCKOFF")
    strategy: getStrategyLabel(trade.winningComponent || trade.component || ctx.strategy),
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
    session,
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
    sweepAgeBars: trade.sweepAgeBars ?? NA,
    sweepToChochBars: trade.sweepToChochBars ?? NA,
    chochToEntryBars: trade.chochToEntryBars ?? NA,
    mfe: trade.mfe ?? NA,
    mae: trade.mae ?? NA,
    mfePercent: trade.mfePercent ?? NA,
    maePercent: trade.maePercent ?? NA,
    exitEfficiency: trade.exitEfficiency ?? NA,
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
    hourUtc: hourUtcOut ?? NA,
    gradedScore: gradedFields.gradedScore,
    gradedScoreBreakdown: gradedFields.gradedScoreBreakdown,
    scoringStrategyKey: gradedFields.scoringStrategyKey,
    dryRun: true,
    mode: "backtest",
    exchange: ctx.exchange ?? NA,
    openTime: formatDateTime(openTime),
    closeTime: formatDateTime(closeTime),
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
 * Resolve CSV columns for a given export variant:
 *   - core     → ADMIN_TRADE_EXPORT_COLUMNS (24): compact essentials
 *   - full     → buildFullExportColumns (31 base + ML union)
 *   - specific → alias of full (API back-compat)
 */
function resolveVariantColumns(variant, rows, records, { adminFormat = true, strategies = null } = {}) {
  if (variant === "full" || variant === "specific") {
    return buildFullExportColumns(rows, { adminFormat, strategies });
  }
  if (variant === "core") {
    // ADMIN cols no longer carry a leading "User" column, so both formats resolve
    // to the same 24-col core set (backtest is single-user).
    return ADMIN_TRADE_EXPORT_COLUMNS;
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
