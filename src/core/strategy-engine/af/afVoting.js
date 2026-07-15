/**
 * AF 3-component voting (SMC + Wyckoff + VSA) — AF-SUB-03.
 *
 * Default: 2/3 majority. Altcoin (VOLATILE / SEMI_VOLATILE tier): 3/3 unanimity.
 */

"use strict";

const ALTCOIN_TIERS = new Set(["VOLATILE", "SEMI_VOLATILE"]);

/**
 * Resolve required vote count.
 * @param {object} opts
 * @param {string} [opts.pairTier]
 * @param {string} [opts.symbol]
 * @param {number} [opts.afMinVotes] - explicit override
 * @param {boolean} [opts.isAltcoin]
 */
function resolveVoteThreshold(opts = {}) {
  if (opts.afMinVotes != null && Number.isFinite(opts.afMinVotes)) {
    return Math.max(1, Math.min(3, Math.floor(opts.afMinVotes)));
  }
  const tier = String(opts.pairTier || "").toUpperCase();
  const alt =
    opts.isAltcoin === true ||
    ALTCOIN_TIERS.has(tier) ||
    (opts.symbol && /BGB|TRX|DOGE|SHIB|PEPE/i.test(String(opts.symbol)));
  return alt ? 3 : 2;
}

/**
 * Aggregate component votes into a final signal.
 *
 * @param {Array<{ key: string, vote: string, confidence?: number, reason?: string }>} componentVotes
 * @param {object} opts
 * @returns {{
 *   signal: 'LONG'|'SHORT'|null,
 *   longVotes: number,
 *   shortVotes: number,
 *   threshold: number,
 *   confidence: number,
 *   breakdown: object,
 *   reason: string
 * }}
 */
function aggregateAfVotes(componentVotes = [], opts = {}) {
  const threshold = resolveVoteThreshold(opts);
  const breakdown = {};
  let longVotes = 0;
  let shortVotes = 0;
  const longConfs = [];
  const shortConfs = [];

  for (const c of componentVotes) {
    const key = c.key || c.name || "unknown";
    const vote = String(c.vote || "NEUTRAL").toUpperCase();
    const confidence = Number.isFinite(c.confidence) ? c.confidence : 0;
    breakdown[key] = {
      vote,
      confidence,
      reason: c.reason || null,
    };
    if (vote === "LONG") {
      longVotes++;
      longConfs.push(confidence);
    } else if (vote === "SHORT") {
      shortVotes++;
      shortConfs.push(confidence);
    }
  }

  let signal = null;
  let confidence = 0;
  let reason = "no_majority";

  if (longVotes >= threshold && longVotes > shortVotes) {
    signal = "LONG";
    confidence = longConfs.length
      ? longConfs.reduce((a, b) => a + b, 0) / longConfs.length
      : 0;
    reason = `majority_long_${longVotes}_of_${componentVotes.length}`;
  } else if (shortVotes >= threshold && shortVotes > longVotes) {
    signal = "SHORT";
    confidence = shortConfs.length
      ? shortConfs.reduce((a, b) => a + b, 0) / shortConfs.length
      : 0;
    reason = `majority_short_${shortVotes}_of_${componentVotes.length}`;
  } else if (longVotes > 0 && shortVotes > 0 && longVotes === shortVotes) {
    reason = "conflict";
  } else if (longVotes + shortVotes < threshold) {
    reason = "insufficient_votes";
  }

  return {
    signal,
    longVotes,
    shortVotes,
    threshold,
    confidence,
    breakdown,
    reason,
  };
}

/**
 * Pearson correlation of two numeric series (same length).
 * Returns null if insufficient variance / length.
 */
function pearsonCorrelation(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 3) return null;
  const n = a.length;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA <= 0 || denB <= 0) return null;
  return num / Math.sqrt(denA * denB);
}

/**
 * Map vote string to numeric for correlation: LONG=1, SHORT=-1, NEUTRAL=0.
 */
function voteToNumber(vote) {
  const v = String(vote || "NEUTRAL").toUpperCase();
  if (v === "LONG") return 1;
  if (v === "SHORT") return -1;
  return 0;
}

/**
 * Pairwise correlation check across historical component vote series.
 *
 * @param {object} seriesMap - { SMC: ['LONG',...], WYCKOFF: [...], VSA: [...] }
 * @param {number} [maxCorr=0.5]
 * @returns {{ ok: boolean, pairs: object, maxCorr: number }}
 */
function checkVoteCorrelation(seriesMap = {}, maxCorr = 0.5) {
  const keys = Object.keys(seriesMap);
  const pairs = {};
  let ok = true;
  let worst = 0;

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const ka = keys[i];
      const kb = keys[j];
      const na = (seriesMap[ka] || []).map(voteToNumber);
      const nb = (seriesMap[kb] || []).map(voteToNumber);
      const corr = pearsonCorrelation(na, nb);
      const pairKey = `${ka}_vs_${kb}`;
      pairs[pairKey] = corr;
      if (corr != null && Math.abs(corr) > maxCorr) ok = false;
      if (corr != null && Math.abs(corr) > worst) worst = Math.abs(corr);
    }
  }

  return { ok, pairs, maxObservedAbsCorr: worst, threshold: maxCorr };
}

module.exports = {
  ALTCOIN_TIERS,
  resolveVoteThreshold,
  aggregateAfVotes,
  pearsonCorrelation,
  voteToNumber,
  checkVoteCorrelation,
};
