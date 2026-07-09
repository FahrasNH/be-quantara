/**
 * MetaSelectorEngine.js — Sprint 3 / MS-1
 *
 * Rule-based engine that recommends the best strategy based on current market
 * regime + historical performance data. Runs in shadow mode by default — it
 * logs and saves recommendations without touching bot execution logic.
 *
 * Modes:
 *  shadow   — logs + saves to DB, no bot execution change (default)
 *  advisory — logs + saves + emits WS event + Telegram alert (MS-3)
 *
 * Algorithm:
 *  1. Classify regime via RegimeClassifierEngine
 *  2. Query StrategyPerformance for each candidate strategy (30d window)
 *  3. Filter: winRate >= 0.35 && profitFactor >= 1.2 && sampleSizeValid
 *  4. Rank by Sharpe → PF → WR; normalise scores to 0–100
 *  5. Return top 3
 *  Latency target: < 100ms (all DB calls parallel)
 */

"use strict";

const regimeEngine         = require("./RegimeClassifierEngine");
const StrategyPerformanceService = require("../server/services/StrategyPerformanceService");
const prisma               = require("../infrastructure/db/prismaClient");

// ── Constants ─────────────────────────────────────────────────────────────────

const MIN_WIN_RATE      = 0.35;
const MIN_PROFIT_FACTOR = 1.2;
const TOP_N             = 3;

// ── MetaSelectorEngine ────────────────────────────────────────────────────────

class MetaSelectorEngine {
  constructor() {
    /** @type {'shadow'|'advisory'} */
    this._mode = process.env.META_SELECTOR_MODE === "advisory" ? "advisory" : "shadow";
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Recommend strategies for a given symbol + indicator snapshot.
   *
   * @param {string}   symbol
   * @param {object}   indicators  — same shape as RegimeClassifierEngine.classify()
   * @param {string[]} availableStrategies — strategy keys the bot can use
   * @param {object}   [options]
   * @param {string}   [options.timeframe='1h']
   * @returns {Promise<{
   *   recommendations: Array<{strategyKey,score,winRate,profitFactor,sharpe,rank}>,
   *   regime: string,
   *   confidence: number,
   *   mode: string,
   *   insufficientData: boolean,
   *   timestamp: string,
   * }>}
   */
  async recommend(symbol, indicators, availableStrategies = [], options = {}) {
    const tf = options.timeframe || "1h";

    // 1. Classify regime (sync, cached)
    const regimeResult = regimeEngine.classify(indicators || {}, symbol, tf);
    const regime       = regimeResult?.composite || "ranging";
    const confidence   = regimeResult?.confidence || 0;

    // 2. Fetch performance for all strategies in parallel
    const perfResults = await Promise.all(
      availableStrategies.map(sk =>
        StrategyPerformanceService.getPerformance(sk, symbol, {
          regime,
          period:    "30d",
          limit:     1,
          startDate: _thirtyDaysAgo(),
        }).then(rows => ({ strategyKey: sk, rows }))
        .catch(() => ({ strategyKey: sk, rows: [] }))
      )
    );

    // 3. Aggregate and filter
    const candidates = [];
    for (const { strategyKey, rows } of perfResults) {
      if (!rows || rows.length === 0) continue;
      const best = _aggregateRows(rows);
      if (
        best.winRate >= MIN_WIN_RATE &&
        best.profitFactor >= MIN_PROFIT_FACTOR &&
        best.sampleSizeValid === true
      ) {
        candidates.push({ strategyKey, ...best });
      }
    }

    // 4. Handle insufficient data case
    let insufficientData = false;
    let pool = candidates;
    if (candidates.length === 0) {
      insufficientData = true;
      // Return all available strategies with zeroed metrics
      pool = availableStrategies.map(sk => ({
        strategyKey: sk,
        winRate: 0,
        profitFactor: 0,
        sharpe: null,
        sampleSizeValid: false,
      }));
    }

    // 5. Rank: Sharpe (primary) → PF (tiebreaker) → WR
    pool.sort((a, b) => {
      const sa = a.sharpe ?? -Infinity;
      const sb = b.sharpe ?? -Infinity;
      if (sa !== sb) return sb - sa;
      if (a.profitFactor !== b.profitFactor) return b.profitFactor - a.profitFactor;
      return b.winRate - a.winRate;
    });

    // 6. Top N with normalised scores
    const topPool = pool.slice(0, TOP_N);
    const recommendations = _normaliseScores(topPool);

    const result = {
      recommendations,
      regime,
      confidence,
      mode:            this._mode,
      insufficientData,
      timestamp:       new Date().toISOString(),
    };

    // 7. Persist to DB (fire-and-forget — never blocks recommendation return)
    _saveRecommendation(symbol, regime, confidence, this._mode, recommendations)
      .catch(err => console.warn("[MetaSelector] Save failed:", err.message));

    return result;
  }

  /**
   * Retrieve audit log of past recommendations for a symbol.
   *
   * @param {string} symbol
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async getRecommendationHistory(symbol, limit = 50) {
    return prisma.metaSelectorRecommendation.findMany({
      where:   { symbol },
      orderBy: { createdAt: "desc" },
      take:    limit,
    });
  }

  // ── Mode management ─────────────────────────────────────────────────────────

  setMode(mode) {
    if (!["shadow", "advisory"].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Must be 'shadow' or 'advisory'`);
    }
    this._mode = mode;
  }

  getMode() {
    return this._mode;
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _thirtyDaysAgo() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString();
}

/**
 * Aggregate multiple StrategyPerformance rows into a single summary.
 * Uses weighted average by tradeCount.
 */
function _aggregateRows(rows) {
  if (!rows || rows.length === 0) {
    return { winRate: 0, profitFactor: 0, sharpe: null, sampleSizeValid: false };
  }
  if (rows.length === 1) {
    const r = rows[0];
    return {
      winRate:         r.winRate         ?? 0,
      profitFactor:    r.profitFactor    ?? 0,
      sharpe:          r.sharpeRatio     ?? null,
      sampleSizeValid: r.sampleSizeValid ?? false,
    };
  }

  const total     = rows.reduce((s, r) => s + (r.tradeCount || 0), 0);
  const wWinRate  = rows.reduce((s, r) => s + (r.winRate      || 0) * (r.tradeCount || 0), 0);
  const wPf       = rows.reduce((s, r) => s + (r.profitFactor || 0) * (r.tradeCount || 0), 0);
  const sharpeArr = rows.filter(r => r.sharpeRatio != null).map(r => r.sharpeRatio);
  const sharpe    = sharpeArr.length > 0
    ? sharpeArr.reduce((s, v) => s + v, 0) / sharpeArr.length
    : null;
  const anyValid  = rows.some(r => r.sampleSizeValid === true);

  return {
    winRate:         total > 0 ? +(wWinRate / total).toFixed(4) : 0,
    profitFactor:    total > 0 ? +(wPf / total).toFixed(4)      : 0,
    sharpe:          sharpe != null ? +sharpe.toFixed(4) : null,
    sampleSizeValid: anyValid,
  };
}

/**
 * Normalise sharpe scores to 0–100 range and assign rank.
 * Falls back to profitFactor if all sharpes are null.
 */
function _normaliseScores(pool) {
  if (pool.length === 0) return [];

  const sharpes = pool.map(p => p.sharpe ?? p.profitFactor ?? 0);
  const maxS    = Math.max(...sharpes);
  const minS    = Math.min(...sharpes);
  const range   = maxS - minS || 1;

  return pool.map((p, i) => {
    const raw   = p.sharpe ?? p.profitFactor ?? 0;
    const score = Math.round(((raw - minS) / range) * 80 + 20); // 20–100 band
    return {
      strategyKey:  p.strategyKey,
      score:        Math.min(100, Math.max(0, score)),
      winRate:      p.winRate      || 0,
      profitFactor: p.profitFactor || 0,
      sharpe:       p.sharpe       ?? null,
      rank:         i + 1,
    };
  });
}

/**
 * Persist recommendation record to DB.
 */
async function _saveRecommendation(symbol, regime, regimeConfidence, mode, recommendations) {
  await prisma.metaSelectorRecommendation.create({
    data: {
      symbol,
      regime,
      regimeConfidence,
      mode,
      recommendations,
    },
  });
}

// ── Singleton export ──────────────────────────────────────────────────────────

const _singleton = new MetaSelectorEngine();

module.exports = _singleton;
module.exports.MetaSelectorEngine = MetaSelectorEngine;
