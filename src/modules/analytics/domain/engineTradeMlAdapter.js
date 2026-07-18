"use strict";

/**
 * engineTradeMlAdapter.js — Bridge lowercase `trades` store → ML/RAG pipeline.
 *
 * BotEngine persists indicator snapshots in trades.indicators (JSON).
 * Prisma "Trade" is unused; this adapter builds FeatureEngineer-compatible
 * entryContext / exitContext from engine rows for bootstrap, training, and hooks.
 */

const FeatureEngineer = require("../../ml/domain/FeatureEngineer");
const { normalizeStrategyKey: aclNormalizeStrategyKey } = require("../../../config/strategyKeyNormalizer");

function safeParseJSON(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function classifyHtfTrend(htfTrend) {
  const trend = String(htfTrend || "").toUpperCase();
  if (trend === "BULLISH") return "trending_up";
  if (trend === "BEARISH") return "trending_down";
  if (trend === "SIDEWAYS") return "ranging";
  return "volatile";
}

/**
 * Map trades.indicators snapshot (BotEngine enrichedSnapshot) → entryContext.
 */
function indicatorsSnapshotToEntryContext(ind = {}, meta = {}) {
  const price = meta.entryPrice ?? ind.lastClose ?? ind.close ?? 1;
  const atr = ind.atr ?? 0;
  const rsi = ind.rsi ?? 50;
  const confidenceRaw = ind.afAggregateConfidence ?? ind.afConfidence ?? meta.confidence ?? 50;
  let confidenceScore = confidenceRaw;
  if (confidenceScore > 0 && confidenceScore <= 10) confidenceScore *= 10;
  confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore)));

  return {
    capturedAt:       meta.openTime ?? new Date().toISOString(),
    htfRegime:        classifyHtfTrend(ind.htfTrend ?? meta.htfTrend),
    atr:              atr ?? 0,
    atrPct:           ind.atrPct ?? (price > 0 ? +((atr / price) * 100).toFixed(4) : 0),
    ema9:             ind.emaFast ?? ind.ema9 ?? price,
    ema21:            ind.emaSlow ?? ind.ema21 ?? price,
    ema50:            ind.emaTrendVal ?? ind.ema50 ?? price,
    adx:              ind.adx ?? null,
    rsi:              rsi ?? 50,
    bbWidth:          ind.bbWidth ?? 0,
    volume24h:        ind.volume ?? 0,
    volumeRatio:      ind.volumeRatio ?? 1,
    spread:           ind.spread ?? 0,
    fundingRate:      ind.fundingRate ?? null,
    strategyKey:      meta.strategyKey ?? ind.strategy ?? ind.firedByStrategy ?? "UNKNOWN",
    tradeType:        meta.tradeType ?? "Intraday",
    confidenceScore,
    signalComponents: ind.afVotes ?? ind.signalComponents ?? {},
    pairTier:         meta.pairTier ?? "LIQUID",
    leverage:         meta.leverage ?? 1,
    capitalAllocated: meta.capital ?? 0,
    regime:           ind.afMarketCond ?? meta.marketCond ?? null,
    bosScore:         ind.bosScore ?? 0,
    fvgScore:         ind.fvgScore ?? 0,
    source:           meta.source ?? "engine-trades",
  };
}

/**
 * Build entryContext from backtest position snapshot (RealStrategyBacktestService).
 */
function buildBacktestEntryContext(position = {}, meta = {}) {
  const price = position.entry ?? meta.price ?? 1;
  const atr = position.atr ?? 0;
  const rsi = position.entryRsi ?? 50;
  let confidenceScore = position.confidence ?? 50;
  if (confidenceScore > 0 && confidenceScore <= 10) confidenceScore *= 10;
  confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore)));

  return {
    capturedAt:       meta.openTime ?? new Date().toISOString(),
    htfRegime:        classifyHtfTrend(position.htfTrend),
    atr,
    atrPct:           price > 0 ? +((atr / price) * 100).toFixed(4) : 0,
    ema9:             price,
    ema21:            price,
    ema50:            price,
    rsi,
    bbWidth:          0,
    volumeRatio:      1,
    confidenceScore,
    strategyKey:      meta.strategyKey ?? position.strategy ?? "ADAPTIVE_FUSION",
    tradeType:        position.tradeType ?? position.component ?? "Intraday",
    regime:           position.marketCond ?? null,
    signalComponents: position.signalComponents ?? meta.signalComponents ?? meta.afVotes?.breakdown ?? {},
    afVotes:          position.afVotes ?? meta.afVotes ?? null,
    source:           "backtest-simulation",
  };
}

function buildExitContextFromEngineRow(row) {
  const pnl = parseFloat(row.pnl) || 0;
  const pnlPct = parseFloat(row.pnl_pct) || 0;
  const isWin = pnl > 0;
  return {
    pnl,
    pnlPct,
    outcome: isWin ? "win" : "loss",
    reason:  row.reason ?? null,
    closedAt: row.close_time ?? null,
  };
}

/**
 * Detect trading session from UTC hour (Sprint 16 ML readiness).
 * @returns {"London"|"NY"|"Asia"}
 */
function detectTradingSession(hourUtc) {
  const h = Number(hourUtc);
  if (!Number.isFinite(h)) return "Asia";
  if (h >= 13 && h <= 21) return "NY";
  if (h >= 8 && h <= 16) return "London";
  return "Asia";
}

/**
 * Compute intraday HOD/LOD/sessionOpen from candle array for entry enrichment.
 */
function computeIntradayPriceContext(candles = [], entryTime = new Date()) {
  const entryMs = entryTime instanceof Date ? entryTime.getTime() : new Date(entryTime).getTime();
  const dayStart = new Date(entryMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();

  const dayCandles = candles.filter((c) => {
    const ts = c.timestamp ?? c.time ?? c.openTime ?? 0;
    return ts >= dayStartMs && ts <= entryMs;
  });

  if (!dayCandles.length) {
    return { hodPrice: null, lodPrice: null, sessionOpen: null };
  }

  const hodPrice = Math.max(...dayCandles.map((c) => c.high ?? c.close ?? 0));
  const lodPrice = Math.min(...dayCandles.map((c) => c.low ?? c.close ?? Infinity));
  const sessionOpen = dayCandles[0].open ?? dayCandles[0].close ?? null;

  return { hodPrice, lodPrice, sessionOpen };
}

/**
 * Resolve signal delay in ms between signal generation and entry fill.
 */
function resolveSignalDelayMs(signalTimestamp, entryTimestamp) {
  const signalMs = Number(signalTimestamp);
  const entryMs = entryTimestamp instanceof Date
    ? entryTimestamp.getTime()
    : new Date(entryTimestamp).getTime();
  if (!Number.isFinite(signalMs) || !Number.isFinite(entryMs)) return 0;
  return Math.max(0, Math.round(entryMs - signalMs));
}

/**
 * Extract liquidation levels from indicator snapshot (fail-open fallback).
 */
function extractLiquidationLevels(snapshot = {}) {
  const level = snapshot.lsLiquidationLevel ?? snapshot.liquidationLevel ?? null;
  if (level == null) return null;
  return { nearestLevel: level, source: "indicator_snapshot" };
}

/**
 * Normalize exit reason to ML vocabulary.
 */
function normalizeExitReason(reason) {
  const raw = String(reason || "MANUAL").toUpperCase();
  if (raw.includes("TP") || raw === "TP_HIT") return "TP_HIT";
  if (raw.includes("SL") || raw === "SL_HIT") return "SL_HIT";
  if (raw.includes("TIME") || raw === "TIMEOUT" || raw === "TIME_STOP") return "TIME_STOP";
  if (raw.includes("REGIME") || raw === "REGIME_FLIP") return "REGIME_FLIP";
  if (raw.includes("EMERGENCY") || raw.includes("GROK")) return "EMERGENCY";
  return raw;
}

/**
 * Build live entryContext enrichment (Sprint 16 / Task 1.2).
 */
function enrichEntryContextLive(baseContext = {}, opts = {}) {
  const {
    entryTime = new Date(),
    candles = [],
    snapshot = {},
    pairTier = "LIQUID",
    signalDelayMs = 0,
    winningComponent = null,
    htfTrend = null,
    htfTrendStrength = null,
    regime = null,
  } = opts;

  const et = entryTime instanceof Date ? entryTime : new Date(entryTime);
  const { hodPrice, lodPrice, sessionOpen } = computeIntradayPriceContext(candles, et);
  const session = detectTradingSession(et.getUTCHours());

  return {
    ...baseContext,
    session,
    dayOfWeek: et.getUTCDay(),
    hodPrice,
    lodPrice,
    sessionOpen,
    liquidationLevels: extractLiquidationLevels(snapshot),
    iv30d: snapshot.iv30d ?? null,
    skew: snapshot.skew ?? null,
    pairTier: pairTier ?? baseContext.pairTier ?? "LIQUID",
    signalDelayMs,
    winningComponent: winningComponent ?? snapshot.winningComponent ?? baseContext.winningComponent ?? null,
    htfAlignment: htfTrend ?? snapshot.htfTrend ?? null,
    htfTrendStrength: htfTrendStrength ?? snapshot.htfTrendStrength ?? null,
    afRace: snapshot.afRace ?? null,
    tsRace: snapshot.tsRace ?? null,
    regime: regime ?? snapshot.afMarketCond ?? baseContext.regime ?? null,
    correlationRisk: pairTier === "MICRO" || pairTier === "VOLATILE" ? "elevated" : "normal",
    liquidationBuffer: snapshot.liquidationBuffer ?? null,
    source: baseContext.source ?? "live-enriched",
  };
}

/**
 * Build live exitContext enrichment (Sprint 16 / Task 1.3).
 */
function enrichExitContextLive(baseContext = {}, opts = {}) {
  const {
    pnl = 0,
    pnlPct = 0,
    exitPrice = 0,
    expectedPrice = null,
    fundingCost = 0,
    regimeAtExit = null,
    exitReason = "MANUAL",
    closedAt = new Date().toISOString(),
  } = opts;

  const isWin = (parseFloat(pnl) || 0) > 0;
  const slippage = expectedPrice != null && Number.isFinite(expectedPrice)
    ? parseFloat((exitPrice - expectedPrice).toFixed(8))
    : null;

  return {
    ...baseContext,
    pnl: parseFloat(pnl) || 0,
    pnlPct: parseFloat(pnlPct) || 0,
    outcome: isWin ? "win" : "loss",
    exitReason: normalizeExitReason(exitReason),
    slippage,
    fundingCost: parseFloat(fundingCost) || 0,
    regimeAtExit,
    closedAt,
  };
}

function normalizeStrategyKey(raw) {
  if (!raw) return "SMART_MONEY_CONCEPTS";
  return aclNormalizeStrategyKey(String(raw).toUpperCase());
}

/**
 * Load closed engine trades with indicators from lowercase `trades` table.
 */
async function fetchClosedEngineTrades(pool, { limit = 5000, minRows = 0 } = {}) {
  const maxRows = Math.min(limit || 5000, 10000);
  const { rows } = await pool.query(
    `SELECT id, symbol, side, entry_price, open_time, close_time,
            pnl, pnl_pct, reason, strategy_name, indicators, status
     FROM trades
     WHERE status = 'closed'
       AND close_time IS NOT NULL
       AND status IS DISTINCT FROM 'cancelled'
     ORDER BY open_time ASC
     LIMIT $1`,
    [maxRows]
  );
  if (minRows > 0 && rows.length < minRows) {
    return { rows, warning: `Only ${rows.length} closed trades (need >= ${minRows})` };
  }
  return { rows, warning: null };
}

/**
 * Build ML dataset + embedding batch from engine trade rows.
 */
function buildMlArtifactsFromEngineRows(rows, featureEngineer = null) {
  const fe = featureEngineer || new FeatureEngineer();
  const dataset = [];
  const embeddings = [];
  let skipped = 0;

  for (const row of rows) {
    try {
      const ind = safeParseJSON(row.indicators);
      const strategyKey = normalizeStrategyKey(row.strategy_name ?? ind.strategy ?? ind.firedByStrategy);
      const entryContext = indicatorsSnapshotToEntryContext(ind, {
        strategyKey,
        symbol:      row.symbol,
        side:        row.side,
        entryPrice:  row.entry_price,
        openTime:    row.open_time,
        marketCond:  ind.afMarketCond,
        htfTrend:    ind.htfTrend,
      });
      const exitContext = buildExitContextFromEngineRow(row);
      const label = exitContext.outcome === "win" ? 1 : 0;

      const features = fe.buildFeatureVector(entryContext, {
        strategyKey,
        symbol: row.symbol,
        side:   row.side,
      });

      dataset.push({
        tradeId:     String(row.id),
        features,
        label,
        timestamp:   row.open_time,
        entryContext,
        exitContext,
      });

      embeddings.push({
        tradeId:  String(row.id),
        vector:   features,
        metadata: {
          strategyKey,
          symbol:    row.symbol,
          side:      row.side,
          regime:    entryContext.regime,
          outcome:   exitContext.outcome,
          pnlPct:    exitContext.pnlPct,
          timestamp: row.open_time instanceof Date
            ? row.open_time.toISOString()
            : String(row.open_time),
        },
      });
    } catch {
      skipped += 1;
    }
  }

  return { dataset, embeddings, skipped };
}

module.exports = {
  safeParseJSON,
  classifyHtfTrend,
  indicatorsSnapshotToEntryContext,
  buildBacktestEntryContext,
  buildExitContextFromEngineRow,
  detectTradingSession,
  computeIntradayPriceContext,
  resolveSignalDelayMs,
  extractLiquidationLevels,
  normalizeExitReason,
  enrichEntryContextLive,
  enrichExitContextLive,
  normalizeStrategyKey,
  fetchClosedEngineTrades,
  buildMlArtifactsFromEngineRows,
};
