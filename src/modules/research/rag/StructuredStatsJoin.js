"use strict";

/**
 * StructuredStatsJoin — Sprint 21 / Task 3 (SQL stat blocks for grounding)
 */

class StructuredStatsJoin {
  constructor(prisma, vectorStore) {
    this.prisma = prisma;
    this.vectorStore = vectorStore;
  }

  async aggregateByBucket({ strategyKey, regime, symbol } = {}) {
    if (!this.prisma) return null;
    const where = {};
    if (strategyKey) where.strategyKey = strategyKey;
    if (regime) where.dailyRegime = regime;
    if (symbol) where.symbol = symbol;

    const rows = await this.prisma.tradeResearchDataset.findMany({
      where,
      select: { result: true, pnlNet: true, pnlGross: true, tradeId: true },
    });

    if (rows.length === 0) return null;

    const wins = rows.filter((r) => r.result === "win" || (r.pnlNet ?? r.pnlGross ?? 0) > 0).length;
    const losses = rows.filter((r) => r.result === "loss" || (r.pnlNet ?? r.pnlGross ?? 0) < 0).length;
    const withOutcome = wins + losses;
    const winRate = withOutcome > 0 ? wins / withOutcome : 0;

    const pnls = rows
      .map((r) => r.pnlNet ?? r.pnlGross)
      .filter(Number.isFinite);
    const grossWins = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
    const grossLosses = Math.abs(pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 99 : 0;
    const expectancy = pnls.length > 0 ? pnls.reduce((s, p) => s + p, 0) / pnls.length : 0;

    return {
      type: "stat_block",
      strategyKey: strategyKey || "all",
      regime: regime || "all",
      symbol: symbol || "all",
      totalTrades: rows.length,
      wins,
      losses,
      winRate,
      profitFactor,
      expectancy,
      citationId: `stat:${strategyKey || "all"}:${regime || "all"}`,
      text:
        `Stats (${strategyKey || "all"}, regime=${regime || "all"}): ` +
        `n=${rows.length}, WR=${(winRate * 100).toFixed(1)}%, ` +
        `PF=${profitFactor.toFixed(2)}, expectancy=${expectancy.toFixed(4)}`,
    };
  }

  async findSimilarTrades(queryVector, filters = {}, k = 10) {
    if (!this.vectorStore) return [];
    try {
      const similar = await this.vectorStore.findSimilar(queryVector, k, filters);
      return similar.map((t) => ({
        type: "similar_trade",
        tradeId: t.tradeId,
        citationId: `[${t.tradeId}]`,
        score: t.similarity,
        metadata: t.metadata,
        text: `Similar trade ${t.tradeId}: outcome=${t.metadata?.outcome || "N/A"}, ` +
          `regime=${t.metadata?.regime || "N/A"}, pnl=${t.metadata?.pnlPct ?? t.metadata?.pnl ?? "N/A"}`,
      }));
    } catch {
      return [];
    }
  }
}

module.exports = StructuredStatsJoin;
