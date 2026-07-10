/**
 * tierRecalibration.js  (src/infrastructure/classification/tierRecalibration.js)
 *
 * Quarterly recalibration report for the pair-tier thresholds
 * (TIER_THRESHOLDS = 0.48 / 0.65 / 0.78 — calibrated on the 2023–2024 top-250
 * score distribution, see ATR_AND_PAIR_TIER_GUIDE.md §2.3).
 *
 * What it does: recompute the hybrid-score distribution over today's CoinGecko
 * universe and report where the SAME calibration anchors land now:
 *   - Anchor 1 (LIQUID boundary): the max score among top-10-by-rank coins —
 *     blue-chips must stay below the STABLE threshold.
 *   - Anchor 2/3: score percentiles matching the share of the universe the
 *     original thresholds cut (computed from the current distribution).
 * It then compares suggested vs current thresholds and flags drift > 0.05.
 *
 * What it does NOT do: mutate anything. Threshold changes are a human decision
 * — run the report, review, backtest with the proposed values, then edit
 * TIER_THRESHOLDS in PairClassifier.js in a reviewed commit. An automated
 * threshold writer would silently re-tier the whole universe under live bots.
 *
 * Usage: node scripts/recalibrate-pair-tiers.js   (quarterly, or after a
 * regime flip / when the drift monitor fires)
 */

'use strict';

const { pairClassifier, TIER_THRESHOLDS, tierFromHybridScore } = require('./PairClassifier');

/** p-th percentile (0–100) of a sorted numeric array, linear interpolation. */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Build the recalibration report from the classifier's current CoinGecko cache.
 * Caller is responsible for having run pairClassifier.refreshDynamic() first.
 * @param {Object} [opts]
 * @param {number} [opts.driftFlag=0.05] - |suggested − current| that flags a threshold for review
 * @returns {Object} report
 */
function computeRecalibrationReport(opts = {}) {
  const driftFlag = opts.driftFlag ?? 0.05;

  const entries = []; // { base, rank, score, tier }
  for (const [base, data] of pairClassifier._dynamicCoinData.entries()) {
    const r = pairClassifier.classify(`${base}USDT`);
    if (typeof r?.hybridScore === 'number') {
      entries.push({ base, rank: data.rank ?? 9999, score: r.hybridScore, tier: r.tier });
    }
  }
  if (entries.length < 50) {
    return { ok: false, reason: `only ${entries.length} scored coins in cache (need ≥50) — run refreshDynamic() first`, universe: entries.length };
  }

  const scores = entries.map((e) => e.score).sort((a, b) => a - b);

  // Tier population under CURRENT thresholds.
  const tierCounts = { LIQUID: 0, STABLE: 0, SEMI_VOLATILE: 0, VOLATILE: 0 };
  for (const e of entries) tierCounts[tierFromHybridScore(e.score)]++;

  // Anchor 1: blue-chip separation — top-10 by rank must sit below STABLE.
  const top10 = entries.filter((e) => e.rank <= 10);
  const top10Max = top10.length ? Math.max(...top10.map((e) => e.score)) : null;
  // Small headroom above the worst blue-chip so normal wobble doesn't eject it.
  const suggestedStable = top10Max != null ? Math.min(0.60, top10Max + 0.03) : null;

  // Anchors 2/3: preserve the SHARE of the universe each boundary currently
  // cuts. If the distribution drifted right, the same percentile lands on a
  // higher score → suggested threshold moves with it.
  const pctBelow = (t) => (scores.filter((s) => s <= t).length / scores.length) * 100;
  const semiShare = pctBelow(TIER_THRESHOLDS.SEMI_VOLATILE);
  const volShare  = pctBelow(TIER_THRESHOLDS.VOLATILE);
  const suggestedSemi = percentile(scores, semiShare);
  const suggestedVol  = percentile(scores, volShare);

  const suggestions = {
    STABLE:        suggestedStable,
    SEMI_VOLATILE: suggestedSemi,
    VOLATILE:      suggestedVol,
  };
  const drift = {};
  const flagged = [];
  for (const key of Object.keys(TIER_THRESHOLDS)) {
    const cur = TIER_THRESHOLDS[key];
    const sug = suggestions[key];
    drift[key] = sug != null ? +(sug - cur).toFixed(4) : null;
    if (sug != null && Math.abs(sug - cur) > driftFlag) flagged.push(key);
  }

  return {
    ok: true,
    at: new Date().toISOString(),
    universe: entries.length,
    scoreDistribution: {
      p10: percentile(scores, 10), p25: percentile(scores, 25),
      p50: percentile(scores, 50), p75: percentile(scores, 75),
      p90: percentile(scores, 90),
    },
    tierCounts,
    anchors: { top10MaxScore: top10Max, top10Count: top10.length },
    currentThresholds: { ...TIER_THRESHOLDS },
    suggestedThresholds: suggestions,
    drift,
    flagged,
    recommendation: flagged.length
      ? `Thresholds ${flagged.join(', ')} drifted > ${driftFlag}. Backtest with the suggested values before editing TIER_THRESHOLDS in PairClassifier.js — do NOT hot-swap under live bots.`
      : 'All thresholds within tolerance — no recalibration needed this quarter.',
  };
}

module.exports = { computeRecalibrationReport, percentile };
