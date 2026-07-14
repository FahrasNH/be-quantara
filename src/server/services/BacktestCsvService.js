/**
 * BacktestCsvService — export backtest runs ke CSV (format Trade History admin).
 *
 * Strategy Reason Formatters — Per-Strategy Entry Reason Assembly
 *
 * Each strategy has distinct entry-trigger vocabulary (not generic across all).
 * mapBacktestTrade routes trade.entryMeta via resolveEntryReasons().
 *
 * Supported strategies & their reason variability:
 * - AF_SMC: Hard-gate (sweep+CHoCH+FVG=prerequisites) → low variance
 * - AF_WYCKOFF: Multi-item checklist → very low variance
 * - AF_VSA: 4 patterns × 3 locations → medium variance
 * - TS_TF: 3-layer checklist → very low variance
 * - TS_MS: 4-layer checklist → very low variance
 * - TS_VP: 1-of-4 mutually-exclusive → low variance
 * - MD_MR: Hybrid (hard entry + soft regime/confluence) → HIGHEST variance
 * - BS_BR: 3-phase sequential → very low variance
 *
 * Umbrellas use race-to-confirm: exactly ONE component wins per bar.
 * Trade attribution shows winning component key (AF_SMC, AF_WYCKOFF, etc).
 *
 * Umbrella_Component scheme: AF_* / TS_* / MD_MR / BS_BR (see strategyReasonFormatters.js).
 */

const { formatDuration } = require("../../infrastructure/db/database");
const {
  ADMIN_TRADE_EXPORT_COLUMNS,
  TRADE_EXPORT_COLUMNS,
  toCsv,
  buildPerformanceSummaryCsv,
} = require("../../domain/tradeExportCsv");
const {
  formatExitReason,
  resolveEntryReasons,
} = require("./csv/strategyReasonFormatters");

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
    component: trade.component ?? trade.tradeType ?? NA,
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

function buildTradesCsv(records, opts = {}) {
  const { includeSummary = true, adminFormat = true } = opts;
  const rows = collectTradeRows(records, { adminFormat });
  const columns = adminFormat ? ADMIN_TRADE_EXPORT_COLUMNS : TRADE_EXPORT_COLUMNS;
  const body = toCsv(rows, columns);
  if (!includeSummary) return body;
  const summary = buildPerformanceSummaryCsv(rows);
  return `${summary}\n${body}`;
}

function exportBacktests(records, mode = "trades") {
  if (mode === "summary") return buildSummaryCsv(records);
  return buildTradesCsv(records, { includeSummary: true, adminFormat: true });
}

module.exports = {
  exportBacktests,
  buildSummaryCsv,
  buildTradesCsv,
  mapBacktestTrade,
  collectTradeRows,
};
