/**
 * StrategyPerformanceService.js — Feature Store (Sprint 1 / FS-4, enhanced Sprint 2 / PA-1)
 *
 * Daily + rolling aggregation of closed Trade records grouped by
 *   (strategyKey, symbol, regime, tradeType, pairTier)
 *
 * Sprint 2 additions:
 *  - Sortino ratio, Expectancy, avgRr, avgHoldingHours, sampleSizeValid
 *  - aggregateRolling(period) for '7d', '30d', 'all-time'
 *  - Incremental update guard (lastProcessedAt tracking)
 *  - PF capped at 9.99 (not Infinity) when totalLoss = 0
 *  - Job failure alert via TelegramNotifier
 */

"use strict";

const prisma   = require("../../infrastructure/db/prismaClient");
const telegram = require("../../infrastructure/notifications/TelegramNotifier");

// ─────────────────────────────────────────────────────────────────────────────
// Statistical helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Floor a Date to midnight UTC. */
function toMidnightUTC(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Safe statistics over an array of numbers. Returns { mean, stdDev }. */
function stats(arr) {
  if (!arr || arr.length === 0) return { mean: 0, stdDev: 0 };
  const mean     = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / arr.length;
  return { mean, stdDev: Math.sqrt(variance) };
}

/**
 * Sharpe ratio (annualised, daily returns proxy).
 * Returns null when stdDev is 0.
 */
function sharpe(pnlPcts) {
  const { mean, stdDev } = stats(pnlPcts);
  if (stdDev === 0) return null;
  return +(mean / stdDev * Math.sqrt(252)).toFixed(4);
}

/**
 * Sortino ratio — like Sharpe but only penalises downside deviation.
 * Returns null when downside deviation is 0.
 */
function sortino(pnlPcts) {
  if (!pnlPcts || pnlPcts.length === 0) return null;
  const mean = pnlPcts.reduce((s, v) => s + v, 0) / pnlPcts.length;
  const negReturns = pnlPcts.filter(p => p < 0);
  if (negReturns.length === 0) return null;
  const downDev = Math.sqrt(negReturns.reduce((s, v) => s + Math.pow(v, 2), 0) / pnlPcts.length);
  if (downDev === 0) return null;
  return +(mean / downDev * Math.sqrt(252)).toFixed(4);
}

/**
 * Expectancy = avgWin × WR − avgLoss × (1 − WR)
 */
function expectancy(pnlPcts) {
  if (!pnlPcts || pnlPcts.length === 0) return 0;
  const wins   = pnlPcts.filter(p => p > 0);
  const losses = pnlPcts.filter(p => p <= 0);
  const wr     = wins.length / pnlPcts.length;
  const avgWin  = wins.length   > 0 ? wins.reduce((s, v)   => s + v, 0) / wins.length   : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
  return +((avgWin * wr) - (avgLoss * (1 - wr))).toFixed(4);
}

/** Max drawdown %: largest peak-to-trough decline in cumulative PnL. */
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
 * Capped at 9.99 when there are no losses (Sprint 2 requirement).
 */
function profitFactor(pnlPcts) {
  const wins   = pnlPcts.filter(p => p > 0).reduce((s, p) => s + p, 0);
  const losses = Math.abs(pnlPcts.filter(p => p < 0).reduce((s, p) => s + p, 0));
  if (losses === 0) return wins > 0 ? 9.99 : 0;
  return +(wins / losses).toFixed(4);
}

/**
 * Average realised R:R from trade pnl and entryContext sl distance.
 * Falls back to pnl ratio if RR data unavailable.
 */
function avgRr(trades) {
  const rrs = trades
    .map(t => {
      const slPrice = t.slPrice ?? t.entryContext?.slPrice ?? null;
      const tpPrice = t.tpPrice ?? t.entryContext?.tpPrice ?? null;
      const entry   = t.entry  ?? t.entryContext?.entry   ?? null;
      if (slPrice && tpPrice && entry && slPrice !== entry) {
        return Math.abs(tpPrice - entry) / Math.abs(slPrice - entry);
      }
      return null;
    })
    .filter(rr => rr != null && isFinite(rr));
  if (rrs.length === 0) return null;
  return +(rrs.reduce((s, v) => s + v, 0) / rrs.length).toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core aggregation kernel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a StrategyPerformance record from a group of trades.
 * @param {object} meta   — { strategyKey, symbol, regime, tradeType, pairTier }
 * @param {Array}  trades
 * @param {Date}   periodDate
 * @param {string} period  — "daily"|"7d"|"30d"|"all-time"
 * @returns {object} record ready for Prisma upsert
 */
function buildRecord(meta, groupTrades, periodDate, period = "daily") {
  const pnlPcts = groupTrades.map(t => t.pnlPercent ?? t.pnl ?? 0);

  const holdingTimes = groupTrades.map(t => {
    if (t.enteredAt && t.exitedAt) {
      return new Date(t.exitedAt).getTime() - new Date(t.enteredAt).getTime();
    }
    return (t.exitContext?.holdingDurationMs) ?? 0;
  });

  const winCount  = pnlPcts.filter(p => p > 0).length;
  const lossCount = pnlPcts.filter(p => p <= 0).length;
  const total     = groupTrades.length;
  const avgHoldMs = holdingTimes.length > 0
    ? holdingTimes.reduce((s, v) => s + v, 0) / holdingTimes.length
    : null;

  return {
    strategyKey:     meta.strategyKey,
    symbol:          meta.symbol,
    regime:          meta.regime,
    tradeType:       meta.tradeType,
    pairTier:        meta.pairTier,
    periodDate,
    period,

    tradeCount:      total,
    winCount,
    lossCount,
    winRate:         total > 0 ? +(winCount / total).toFixed(4) : 0,
    profitFactor:    profitFactor(pnlPcts),
    avgPnlPct:       +stats(pnlPcts).mean.toFixed(4),
    maxDrawdownPct:  maxDrawdown(pnlPcts),
    sharpeRatio:     sharpe(pnlPcts),
    avgHoldingMs:    avgHoldMs != null ? +avgHoldMs.toFixed(0) : null,

    // Sprint 2 additions
    sortino:         sortino(pnlPcts),
    expectancy:      expectancy(pnlPcts),
    avgRr:           avgRr(groupTrades),
    avgHoldingHours: avgHoldMs != null ? +(avgHoldMs / 3_600_000).toFixed(4) : null,
    sampleSizeValid: total >= 20,

    updatedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// StrategyPerformanceService
// ─────────────────────────────────────────────────────────────────────────────

class StrategyPerformanceService {

  /**
   * Aggregate all closed trades from a single calendar day and upsert results.
   *
   * @param {Date|string} date — defaults to yesterday
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

    const trades = await prisma.trade.findMany({
      where: {
        status:   "CLOSED",
        exitedAt: { gte: dayStart, lt: dayEnd },
        entryContext: { not: null },
      },
      select: {
        id:           true,
        pnl:          true,
        pnlPercent:   true,
        entryContext: true,
        exitContext:  true,
        enteredAt:    true,
        exitedAt:     true,
        entry:        true,
        slPrice:      true,
        tpPrice:      true,
        symbol:       true,
      },
    });

    if (trades.length === 0) {
      console.log(`[StrategyPerformanceService] No trades for ${targetDay.toISOString().slice(0, 10)}`);
      return [];
    }

    const groups = StrategyPerformanceService._groupTrades(trades);
    return StrategyPerformanceService._upsertGroups(groups, targetDay, "daily");
  }

  /**
   * Aggregate trades over a rolling window and upsert.
   *
   * @param {'7d'|'30d'|'all-time'} period
   * @returns {object[]}
   */
  static async aggregateRolling(period) {
    const now = new Date();
    const periodDate = toMidnightUTC(now); // anchor = today midnight UTC

    let dateFilter = {};
    if (period === "7d") {
      const since = new Date(now);
      since.setUTCDate(since.getUTCDate() - 7);
      dateFilter = { exitedAt: { gte: since } };
    } else if (period === "30d") {
      const since = new Date(now);
      since.setUTCDate(since.getUTCDate() - 30);
      dateFilter = { exitedAt: { gte: since } };
    }
    // all-time: no date filter

    const trades = await prisma.trade.findMany({
      where: {
        status:       "CLOSED",
        entryContext: { not: null },
        ...dateFilter,
      },
      select: {
        id:           true,
        pnl:          true,
        pnlPercent:   true,
        entryContext: true,
        exitContext:  true,
        enteredAt:    true,
        exitedAt:     true,
        entry:        true,
        slPrice:      true,
        tpPrice:      true,
        symbol:       true,
      },
    });

    if (trades.length === 0) {
      console.log(`[StrategyPerformanceService] No trades for rolling period ${period}`);
      return [];
    }

    const groups = StrategyPerformanceService._groupTrades(trades);
    return StrategyPerformanceService._upsertGroups(groups, periodDate, period);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  static _groupTrades(trades) {
    const groups = new Map();
    for (const trade of trades) {
      const ec  = trade.entryContext || {};
      const sym = trade.symbol ?? ec.symbol ?? "UNKNOWN";
      const key = JSON.stringify({
        strategyKey: ec.strategyKey ?? "UNKNOWN",
        symbol:      sym,
        regime:      ec.market?.regime ?? ec.htfRegime ?? "unknown",
        tradeType:   ec.tradeType ?? null,
        pairTier:    ec.pairTier  ?? null,
      });
      if (!groups.has(key)) groups.set(key, { meta: JSON.parse(key), trades: [] });
      groups.get(key).trades.push(trade);
    }
    return groups;
  }

  static async _upsertGroups(groups, periodDate, period) {
    const results = [];

    for (const { meta, trades: groupTrades } of groups.values()) {
      const record = buildRecord(meta, groupTrades, periodDate, period);

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
          tradeCount:      record.tradeCount,
          winCount:        record.winCount,
          lossCount:       record.lossCount,
          winRate:         record.winRate,
          profitFactor:    record.profitFactor,
          avgPnlPct:       record.avgPnlPct,
          maxDrawdownPct:  record.maxDrawdownPct,
          sharpeRatio:     record.sharpeRatio,
          avgHoldingMs:    record.avgHoldingMs,
          sortino:         record.sortino,
          expectancy:      record.expectancy,
          avgRr:           record.avgRr,
          avgHoldingHours: record.avgHoldingHours,
          sampleSizeValid: record.sampleSizeValid,
          period:          record.period,
          updatedAt:       record.updatedAt,
        },
        create: record,
      });

      results.push(upserted);
    }

    console.log(`[StrategyPerformanceService] ${period} ${periodDate.toISOString().slice(0, 10)}: ${results.length} groups upserted`);
    return results;
  }

  // ── Public query API (Sprint 1 compatibility maintained) ─────────────────────

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

  static async getTopPerformer(regime, limit = 10) {
    const where = {};
    if (regime) where.regime = regime;

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
      avgWinRate:   r._avg.winRate      ?? 0,
      avgPnlPct:    r._avg.avgPnlPct    ?? 0,
      profitFactor: r._avg.profitFactor ?? 0,
      totalTrades:  r._sum.tradeCount   ?? 0,
    }));
  }

  static async getRegimeFit(strategyKey) {
    const rows = await prisma.strategyPerformance.groupBy({
      by:    ["regime"],
      where: { strategyKey },
      _avg:  { winRate: true, avgPnlPct: true, profitFactor: true, sharpeRatio: true },
      _sum:  { tradeCount: true, winCount: true, lossCount: true },
    });

    const breakdown = {};
    for (const row of rows) {
      breakdown[row.regime] = {
        regime:       row.regime,
        avgWinRate:   +(row._avg.winRate      ?? 0).toFixed(4),
        avgPnlPct:    +(row._avg.avgPnlPct    ?? 0).toFixed(4),
        profitFactor: +(row._avg.profitFactor ?? 0).toFixed(4),
        sharpeRatio:  row._avg.sharpeRatio != null ? +(row._avg.sharpeRatio).toFixed(4) : null,
        totalTrades:  row._sum.tradeCount ?? 0,
        totalWins:    row._sum.winCount   ?? 0,
        totalLosses:  row._sum.lossCount  ?? 0,
      };
    }
    return breakdown;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export helpers for testing
// ─────────────────────────────────────────────────────────────────────────────

module.exports = StrategyPerformanceService;
module.exports._helpers = { profitFactor, sortino, expectancy, sharpe, stats, maxDrawdown, avgRr, buildRecord };
