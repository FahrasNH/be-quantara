"use strict";

/**
 * engineTradeMlAdapter.js — Bridge lowercase `trades` store → ML/RAG pipeline.
 *
 * BotEngine persists indicator snapshots in trades.indicators (JSON).
 * Prisma "Trade" is unused; this adapter builds FeatureEngineer-compatible
 * entryContext / exitContext from engine rows for bootstrap, training, and hooks.
 */

const FeatureEngineer = require("../../ml/domain/FeatureEngineer");

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

function normalizeStrategyKey(raw) {
  if (!raw) return "ADAPTIVE_FUSION";
  const u = String(raw).toUpperCase();
  const map = {
    AF_SMC: "ADAPTIVE_FUSION",
    ADAPTIVE_FUSION: "ADAPTIVE_FUSION",
    TS_TF: "TREND_FOLLOWING",
    TREND_FOLLOWING: "TREND_FOLLOWING",
    MD_MR: "MEAN_REVERSION",
    MEAN_REVERSION: "MEAN_REVERSION",
    BS_BR: "BREAKOUT_RETEST",
    BREAKOUT_RETEST: "BREAKOUT_RETEST",
  };
  return map[u] ?? u;
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
  normalizeStrategyKey,
  fetchClosedEngineTrades,
  buildMlArtifactsFromEngineRows,
};
