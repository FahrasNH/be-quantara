"use strict";

/**
 * StrategyPerformanceAggregation.js — Sprint 16 Phase 2 / Task 2.2
 *
 * Daily aggregation from BotEngine lowercase `trades` store → StrategyPerformance.
 * Complements StrategyPerformanceService (Prisma Trade model) so live engine trades
 * populate win-rate / sharpe per regime + strategy + pair tier.
 *
 * Scheduled via performanceAggregationCron @ 02:00 UTC.
 */

const { _pool } = require("../../../infrastructure/db/database");
const StrategyPerformanceService = require("../../analytics/services/StrategyPerformanceService");
const {
  safeParseJSON,
  classifyHtfTrend,
  indicatorsSnapshotToEntryContext,
} = require("../../analytics/domain/engineTradeMlAdapter");

function toMidnightUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Transform a lowercase `trades` row into StrategyPerformanceService trade shape.
 */
function transformEngineRow(row) {
  const ecRaw = row.entry_context
    ? (typeof row.entry_context === "string" ? safeParseJSON(row.entry_context) : row.entry_context)
    : null;
  const ind = safeParseJSON(row.indicators);

  const entryContext = ecRaw || indicatorsSnapshotToEntryContext(ind, {
    strategyKey: row.strategy_name || ind?.strategy || ind?.firedByStrategy || "UNKNOWN",
    symbol:      row.symbol,
    side:        row.side,
    entryPrice:  row.entry_price,
    openTime:    row.open_time,
    pairTier:    row.pair_tier || "LIQUID",
    marketCond:  ind?.afMarketCond,
    htfTrend:    ind?.htfTrend,
  });

  if (!entryContext.pairTier && row.pair_tier) {
    entryContext.pairTier = row.pair_tier;
  }
  if (!entryContext.strategyKey && row.strategy_name) {
    entryContext.strategyKey = row.strategy_name;
  }
  if (!entryContext.market?.regime && entryContext.regime) {
    entryContext.market = { regime: entryContext.regime };
  }
  if (!entryContext.htfRegime && ind?.htfTrend) {
    entryContext.htfRegime = classifyHtfTrend(ind.htfTrend);
  }

  return {
    id:           String(row.id),
    pnl:          parseFloat(row.pnl) || 0,
    pnlPercent:   parseFloat(row.pnl_pct) || 0,
    entryContext,
    exitContext:  row.exit_context
      ? (typeof row.exit_context === "string" ? safeParseJSON(row.exit_context) : row.exit_context)
      : null,
    enteredAt:    row.open_time,
    exitedAt:     row.close_time,
    entry:        row.entry_price,
    slPrice:      ind?.slPrice ?? ind?.sl ?? null,
    tpPrice:      ind?.tpPrice ?? ind?.tp ?? null,
    symbol:       row.symbol,
  };
}

/**
 * Fetch closed engine trades for a calendar day (UTC).
 */
async function fetchEngineTradesForDay(targetDay) {
  const dayStart = toMidnightUTC(targetDay);
  const dayEnd   = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const { rows } = await _pool.query(
    `SELECT id, symbol, side, entry_price, open_time, close_time,
            pnl, pnl_pct, reason, strategy_name, indicators,
            entry_context, exit_context, pair_tier, winning_component, status
       FROM trades
      WHERE status = 'closed'
        AND close_time >= $1
        AND close_time < $2
        AND status IS DISTINCT FROM 'cancelled'`,
    [dayStart, dayEnd]
  );

  return rows.map(transformEngineRow);
}

class StrategyPerformanceAggregation {
  /**
   * Aggregate closed trades for a calendar day into StrategyPerformance rows.
   * Runs both Prisma Trade aggregation and engine `trades` aggregation.
   *
   * @param {Date|string} [date] — defaults to yesterday UTC
   * @returns {Promise<object[]>}
   */
  static async aggregateDaily(date) {
    const targetDay = date ? toMidnightUTC(date) : (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    })();

    const dayLabel = targetDay.toISOString().slice(0, 10);
    const results  = [];

    // Prisma Trade path (legacy / multi-strategy bots)
    try {
      const prismaResults = await StrategyPerformanceService.aggregateDaily(targetDay);
      results.push(...prismaResults);
    } catch (err) {
      console.warn(`[StrategyPerformanceAggregation] Prisma path failed: ${err.message}`);
    }

    // Engine trades path (BotEngine lowercase store — primary live path)
    const engineTrades = await fetchEngineTradesForDay(targetDay);
    if (engineTrades.length === 0) {
      console.log(`[StrategyPerformanceAggregation] No engine trades for ${dayLabel}`);
      return results;
    }

    const groups        = StrategyPerformanceService._groupTrades(engineTrades);
    const engineResults = await StrategyPerformanceService._upsertGroups(groups, targetDay, "daily");
    results.push(...engineResults);

    console.log(
      `[StrategyPerformanceAggregation] ${dayLabel}: ${engineResults.length} engine groups ` +
      `(${engineTrades.length} trades)`
    );
    return results;
  }
}

module.exports = StrategyPerformanceAggregation;
module.exports.fetchEngineTradesForDay = fetchEngineTradesForDay;
module.exports.transformEngineRow = transformEngineRow;
