/**
 * StrategyPerformanceService.js — Feature Store (Sprint 1 / FS-4)
 *
 * Daily aggregation of closed Trade records grouped by
 *   (strategyKey, symbol, regime, tradeType, pairTier)
 *
 * Results are upserted into the StrategyPerformance Prisma table.
 * Called by the cron job at 02:00 UTC via performanceAggregationCron.js.
 */

"use strict";

const prisma = require("../../infrastructure/db/prismaClient");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Floor a Date to midnight UTC (strip time component). */
function toMidnightUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Safe statistics over an array of numbers. Returns { mean, stdDev }. */
function stats(arr) {
  if (!arr || arr.length === 0) return { mean: 0, stdDev: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Compute Sharpe ratio (annualised, daily returns proxy).
 * Returns null when stdDev is 0 (avoid division by zero).
 */
function sharpe(pnlPcts) {
  const { mean, stdDev } = stats(pnlPcts);
  if (stdDev === 0) return null;
  return +(mean / stdDev * Math.sqrt(252)).toFixed(4);
}

/**
 * Max drawdown %: largest peak-to-trough decline in cumulative PnL.
 */
function maxDrawdown(pnlPcts) {
  let peak = 0, trough = 0, cum = 0;
  for (const p of pnlPcts) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > trough) trough = dd;
  }
  return +trough.toFixed(4);
}

/**
 * Profit factor: sum(winning pnl) / |sum(losing pnl)|.
 * Returns 0 when there are no losses (perfect — handled as a large positive).
 */
function profitFactor(pnlPcts) {
  const wins  = pnlPcts.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const losses = Math.abs(pnlPcts.filter(p => p < 0).reduce((s, p) => s + p, 0));
  if (losses === 0) return wins > 0 ? 999 : 0;
  return +(wins / losses).toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────────
// StrategyPerformanceService
// ─────────────────────────────────────────────────────────────────────────────

class StrategyPerformanceService {

  /**
   * Aggregate all closed trades from a single calendar day and upsert results
   * into StrategyPerformance.
   *
   * @param {Date|string} date — any value parseable by `new Date()`;
   *                             defaults to yesterday (safe for a 02:00 UTC cron)
   * @returns {object[]} array of upserted StrategyPerformance records
   */
  static async aggregateDaily(date) {
    const targetDay = date ? toMidnightUTC(date) : (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - 1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    })();

    const dayStart = new Date(targetDay);
    const dayEnd   = new Date(targetDay);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    // Load closed trades with entryContext for the day
    const trades = await prisma.trade.findMany({
      where: {
        status:   "CLOSED",
        exitedAt: { gte: dayStart, lt: dayEnd },
        entryContext: { not: null },
      },
      select: {
        id:              true,
        pnl:             true,
        pnlPercent:      true,
        entryContext:    true,
        exitContext:     true,
        enteredAt:       true,
        exitedAt:        true,
      },
    });

    if (trades.length === 0) {
      console.log(`[StrategyPerformanceService] No trades found for ${targetDay.toISOString().slice(0, 10)}`);
      return [];
    }

    // Group trades by the aggregation key
    const groups = new Map();

    for (const trade of trades) {
      const ec = trade.entryContext || {};
      const key = JSON.stringify({
        strategyKey: ec.strategyKey ?? "UNKNOWN",
        symbol:      trade.symbol   ?? ec.symbol ?? "UNKNOWN",
        regime:      ec.htfRegime   ?? "unknown",
        tradeType:   ec.tradeType   ?? null,
        pairTier:    ec.pairTier    ?? null,
      });

      if (!groups.has(key)) groups.set(key, { meta: JSON.parse(key), trades: [] });
      groups.get(key).trades.push(trade);
    }

    const results = [];

    for (const { meta, trades: groupTrades } of groups.values()) {
      const pnlPcts      = groupTrades.map(t => t.pnlPercent ?? t.pnl ?? 0);
      const holdingTimes = groupTrades.map(t => {
        if (t.enteredAt && t.exitedAt) {
          return new Date(t.exitedAt).getTime() - new Date(t.enteredAt).getTime();
        }
        return (t.exitContext?.holdingDurationMs) ?? 0;
      });

      const winCount  = pnlPcts.filter(p => p > 0).length;
      const lossCount = pnlPcts.filter(p => p <= 0).length;
      const total     = groupTrades.length;

      const record = {
        strategyKey:   meta.strategyKey,
        symbol:        meta.symbol,
        regime:        meta.regime,
        tradeType:     meta.tradeType,
        pairTier:      meta.pairTier,
        periodDate:    targetDay,

        tradeCount:    total,
        winCount,
        lossCount,
        winRate:       total > 0 ? +(winCount / total).toFixed(4) : 0,
        profitFactor:  profitFactor(pnlPcts),
        avgPnlPct:     +stats(pnlPcts).mean.toFixed(4),
        maxDrawdownPct: maxDrawdown(pnlPcts),
        sharpeRatio:   sharpe(pnlPcts),
        avgHoldingMs:  holdingTimes.length > 0
          ? +(holdingTimes.reduce((s, v) => s + v, 0) / holdingTimes.length).toFixed(0)
          : null,
        updatedAt:     new Date(),
      };

      const upserted = await prisma.strategyPerformance.upsert({
        where: {
          strategyKey_symbol_regime_tradeType_pairTier_periodDate: {
            strategyKey: record.strategyKey,
            symbol:      record.symbol,
            regime:      record.regime,
            tradeType:   record.tradeType ?? "",
            pairTier:    record.pairTier  ?? "",
            periodDate:  record.periodDate,
          },
        },
        update: {
          tradeCount:    record.tradeCount,
          winCount:      record.winCount,
          lossCount:     record.lossCount,
          winRate:       record.winRate,
          profitFactor:  record.profitFactor,
          avgPnlPct:     record.avgPnlPct,
          maxDrawdownPct: record.maxDrawdownPct,
          sharpeRatio:   record.sharpeRatio,
          avgHoldingMs:  record.avgHoldingMs,
          updatedAt:     record.updatedAt,
        },
        create: record,
      });

      results.push(upserted);
    }

    console.log(`[StrategyPerformanceService] aggregateDaily ${targetDay.toISOString().slice(0, 10)}: ${results.length} groups upserted from ${trades.length} trades`);
    return results;
  }

  /**
   * Query performance records with optional filters.
   *
   * @param {string} strategyKey
   * @param {string} symbol
   * @param {object} opts  — { regime, pairTier, tradeType, startDate, endDate, limit }
   * @returns {object[]}
   */
  static async getPerformance(strategyKey, symbol, opts = {}) {
    const { regime, pairTier, tradeType, startDate, endDate, limit = 100 } = opts;

    const where = {};
    if (strategyKey) where.strategyKey = strategyKey;
    if (symbol)      where.symbol      = symbol;
    if (regime)      where.regime      = regime;
    if (pairTier)    where.pairTier    = pairTier;
    if (tradeType)   where.tradeType   = tradeType;
    if (startDate || endDate) {
      where.periodDate = {};
      if (startDate) where.periodDate.gte = new Date(startDate);
      if (endDate)   where.periodDate.lte = new Date(endDate);
    }

    return prisma.strategyPerformance.findMany({
      where,
      orderBy: { periodDate: "desc" },
      take:    limit,
    });
  }

  /**
   * Top N strategies by win rate within a given regime.
   *
   * @param {string} regime  — "trending_up"|"trending_down"|"ranging"|"volatile"
   * @param {number} limit   — default 10
   * @returns {object[]} sorted descending by winRate
   */
  static async getTopPerformer(regime, limit = 10) {
    const where = {};
    if (regime) where.regime = regime;

    // Aggregate across all dates: group by (strategyKey, symbol), compute averages
    const rows = await prisma.strategyPerformance.groupBy({
      by:      ["strategyKey", "symbol"],
      where,
      _avg:    { winRate: true, avgPnlPct: true, profitFactor: true },
      _sum:    { tradeCount: true },
      orderBy: { _avg: { winRate: "desc" } },
      take:    limit,
    });

    return rows.map(r => ({
      strategyKey:  r.strategyKey,
      symbol:       r.symbol,
      avgWinRate:   r._avg.winRate   ?? 0,
      avgPnlPct:    r._avg.avgPnlPct ?? 0,
      profitFactor: r._avg.profitFactor ?? 0,
      totalTrades:  r._sum.tradeCount ?? 0,
    }));
  }

  /**
   * Performance breakdown by regime for a given strategyKey.
   *
   * @param {string} strategyKey
   * @returns {object} { trending_up: {...}, trending_down: {...}, ranging: {...}, volatile: {...} }
   */
  static async getRegimeFit(strategyKey) {
    const rows = await prisma.strategyPerformance.groupBy({
      by:   ["regime"],
      where: { strategyKey },
      _avg: { winRate: true, avgPnlPct: true, profitFactor: true, sharpeRatio: true },
      _sum: { tradeCount: true, winCount: true, lossCount: true },
    });

    const breakdown = {};
    for (const row of rows) {
      breakdown[row.regime] = {
        regime:       row.regime,
        avgWinRate:   +(row._avg.winRate      ?? 0).toFixed(4),
        avgPnlPct:    +(row._avg.avgPnlPct    ?? 0).toFixed(4),
        profitFactor: +(row._avg.profitFactor ?? 0).toFixed(4),
        sharpeRatio:  row._avg.sharpeRatio != null
          ? +(row._avg.sharpeRatio).toFixed(4)
          : null,
        totalTrades:  row._sum.tradeCount ?? 0,
        totalWins:    row._sum.winCount   ?? 0,
        totalLosses:  row._sum.lossCount  ?? 0,
      };
    }
    return breakdown;
  }
}

module.exports = StrategyPerformanceService;
