"use strict";

/**
 * ResearchDatasetValidator — predictive validation (monotonicity + IC) for SSOT.
 */

const prisma = require("../../../infrastructure/db/prismaClient");
const { scoreTierFor, SCORE_TIER_BOUNDS } = require("../../../models/researchDatasetSchema");

function pearsonIC(scores, outcomes) {
  const n = scores.length;
  if (n < 3) return null;
  const meanS = scores.reduce((a, b) => a + b, 0) / n;
  const meanO = outcomes.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let denS = 0;
  let denO = 0;
  for (let i = 0; i < n; i++) {
    const ds = scores[i] - meanS;
    const do_ = outcomes[i] - meanO;
    num += ds * do_;
    denS += ds * ds;
    denO += do_ * do_;
  }
  const den = Math.sqrt(denS * denO);
  return den > 0 ? num / den : null;
}

function tierStats(trades) {
  const tiers = {};
  for (const b of SCORE_TIER_BOUNDS) tiers[b.tier] = { trades: [], wins: 0, losses: 0 };

  for (const t of trades) {
    const tier = scoreTierFor(t.gradedScore);
    if (!tier || !tiers[tier]) continue;
    tiers[tier].trades.push(t);
    if (t.result === "win") tiers[tier].wins += 1;
    if (t.result === "loss") tiers[tier].losses += 1;
  }

  const out = {};
  for (const [tier, data] of Object.entries(tiers)) {
    const closed = data.wins + data.losses;
    const winRate = closed ? data.wins / closed : 0;
    const expectancy = closed
      ? data.trades.reduce((s, t) => s + (Number(t.pnlNet) || 0), 0) / closed
      : 0;
    const avgMfe = data.trades.length
      ? data.trades.reduce((s, t) => s + (Number(t.mfePercent) || 0), 0) / data.trades.length
      : 0;
    const avgMae = data.trades.length
      ? data.trades.reduce((s, t) => s + (Number(t.maePercent) || 0), 0) / data.trades.length
      : 0;
    out[tier] = {
      count: data.trades.length,
      winRate: Math.round(winRate * 1000) / 10,
      expectancy: Math.round(expectancy * 10000) / 10000,
      avgMfePercent: Math.round(avgMfe * 100) / 100,
      avgMaePercent: Math.round(avgMae * 100) / 100,
    };
  }
  return out;
}

function checkMonotonicity(tierReport) {
  const order = ["low", "mid", "high"];
  const wr = order.map((t) => tierReport[t]?.winRate ?? 0);
  const exp = order.map((t) => tierReport[t]?.expectancy ?? 0);
  const wrMono = wr[0] <= wr[1] && wr[1] <= wr[2];
  const expMono = exp[0] <= exp[1] && exp[1] <= exp[2];
  return {
    winRateMonotonic: wrMono,
    expectancyMonotonic: expMono,
    monotonic: wrMono || expMono,
    winRates: Object.fromEntries(order.map((t, i) => [t, wr[i]])),
    expectancies: Object.fromEntries(order.map((t, i) => [t, exp[i]])),
  };
}

class ResearchDatasetValidator {
  async runPredictiveValidation({ strategyKey = "SMART_MONEY_CONCEPTS" } = {}) {
    const trades = await prisma.tradeResearchDataset.findMany({
      where: {
        strategyKey,
        gradedScore: { not: null },
        result: { in: ["win", "loss"] },
      },
    });

    const scores = trades.map((t) => Number(t.gradedScore));
    const outcomes = trades.map((t) => (t.result === "win" ? 1 : 0));
    const tierReport = tierStats(trades);
    const monotonicity = checkMonotonicity(tierReport);
    const ic = pearsonIC(scores, outcomes);

    // Per SMC sub-score correlation when available
    const subScoreIC = {};
    const subKeys = ["sweepScore", "chochScore", "fvgScore", "htfAlignScore", "totalSmcScore"];
    for (const key of subKeys) {
      const pairs = trades
        .map((t) => {
          const fs = t.featureScores && typeof t.featureScores === "object" ? t.featureScores : {};
          const v = fs[key];
          return v != null ? [Number(v), t.result === "win" ? 1 : 0] : null;
        })
        .filter(Boolean);
      if (pairs.length >= 10) {
        subScoreIC[key] = pearsonIC(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
      }
    }

    return {
      strategyKey,
      sampleSize: trades.length,
      informationCoefficient: ic != null ? Math.round(ic * 1000) / 1000 : null,
      tierReport,
      monotonicity,
      subScoreIC,
      generatedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  ResearchDatasetValidator,
  pearsonIC,
  tierStats,
  checkMonotonicity,
};
