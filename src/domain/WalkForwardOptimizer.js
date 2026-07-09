/**
 * WalkForwardOptimizer.js — Sprint 4 / WT-1
 *
 * Walk-forward parameter optimization framework.
 * Uses stored Trade records (entryContext) to backtest parameter combinations.
 * No live market data fetched — pure historical simulation.
 *
 * Interface:
 *   optimize(strategyKey, symbol, options)   → best params + validation metrics
 *   runGridSearch(strategyKey, symbol, trades, searchSpace) → sorted combo list
 *   simulateTrades(trades, strategyKey, params) → { winRate, profitFactor, sharpe, ... }
 *   passesConstraints(metrics)              → boolean
 *   getParameterHistory(strategyKey, symbol, limit)
 */

"use strict";

const prisma = require("../infrastructure/db/prismaClient");

// ── Default search spaces per strategy ───────────────────────────────────────

const SEARCH_SPACE = {
  AF_SMC: {
    confidenceFloor:    { min: 60,   max: 85,   step: 5    },
    slMultiplierScalp:  { min: 0.8,  max: 1.5,  step: 0.1  },
    tpMultiplierScalp:  { min: 3.0,  max: 6.0,  step: 0.5  },
  },
  TS_TF: {
    adxMinStrength: { min: 20,  max: 40,  step: 5    },
    slMultiplier:   { min: 1.0, max: 2.5, step: 0.25 },
    tpMultiplier:   { min: 1.5, max: 3.0, step: 0.25 },
  },
  MD_MR: {
    rsiOversold:   { min: 20,  max: 35,  step: 5    },
    rsiOverbought: { min: 65,  max: 80,  step: 5    },
    bbMultiplier:  { min: 1.5, max: 2.5, step: 0.25 },
  },
  BS_BR: {
    breakoutLookback:         { min: 15,  max: 30,  step: 5    },
    volumeMultiplier:         { min: 1.1, max: 1.8, step: 0.1  },
    consolidationThreshold:   { min: 0.6, max: 0.95, step: 0.05 },
  },
};

// ── Numeric helpers ───────────────────────────────────────────────────────────

/** Generate all values for a single parameter range. */
function rangeValues({ min, max, step }) {
  const values = [];
  if (step <= 0) throw new Error(`rangeValues: step must be > 0, got ${step}`);

  if (step >= 1) {
    // Integer-friendly range — no floating-point needed
    for (let v = min; v <= max + 1e-9; v += step) {
      values.push(Math.round(v));
    }
    return values;
  }

  // Use integer arithmetic: scale = 1/step (rounds to nearest int)
  // Works for step values like 0.05, 0.1, 0.25, 0.5 which all produce integer scale factors.
  const scale = Math.round(1 / step);
  const iMin  = Math.round(min  * scale);
  const iMax  = Math.round(max  * scale);
  const iStep = Math.max(1, Math.round(step * scale));
  for (let i = iMin; i <= iMax; i += iStep) {
    values.push(Math.round(i / scale * 1e9) / 1e9);
  }
  return values;
}

/** Cartesian product of parameter value arrays, yielding combo objects. */
function* cartesian(keys, valueArrays, idx = 0, current = {}) {
  if (idx === keys.length) {
    yield { ...current };
    return;
  }
  for (const v of valueArrays[idx]) {
    current[keys[idx]] = v;
    yield* cartesian(keys, valueArrays, idx + 1, current);
  }
}

/** Round value to 6 decimal places to avoid FP noise. */
function r6(n) { return Math.round(n * 1e6) / 1e6; }

// ── Metric computation ────────────────────────────────────────────────────────

/**
 * Compute performance metrics from an array of PnL values.
 * @param {number[]} pnlList  — list of trade PnL values (absolute or %)
 * @returns {{ winRate, profitFactor, sharpe, sortino, tradeCount, maxDrawdown }}
 */
function computeMetrics(pnlList) {
  const n = pnlList.length;
  if (n === 0) {
    return { winRate: 0, profitFactor: 0, sharpe: 0, sortino: 0, tradeCount: 0, maxDrawdown: 0 };
  }

  let wins = 0, grossWin = 0, grossLoss = 0;
  for (const p of pnlList) {
    if (p > 0) { wins++; grossWin += p; }
    else        { grossLoss += Math.abs(p); }
  }

  const winRate     = wins / n;
  const profitFactor = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss;

  // Sharpe & Sortino (daily returns — approximate each trade as one period)
  const mean = pnlList.reduce((a, b) => a + b, 0) / n;
  const variance = pnlList.reduce((s, p) => s + (p - mean) ** 2, 0) / n;
  const stdDev   = Math.sqrt(variance);
  const sharpe   = stdDev === 0 ? 0 : r6(mean / stdDev);

  const downsideVariance = pnlList
    .filter(p => p < 0)
    .reduce((s, p) => s + p ** 2, 0) / n;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino  = downsideDev === 0 ? (mean > 0 ? 99 : 0) : r6(mean / downsideDev);

  // Max drawdown (cumulative PnL curve)
  let peak = 0, cum = 0, maxDD = 0;
  for (const p of pnlList) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    winRate:      r6(winRate),
    profitFactor: r6(profitFactor),
    sharpe:       r6(sharpe),
    sortino:      r6(sortino),
    tradeCount:   n,
    maxDrawdown:  r6(maxDD),
  };
}

// ── Parameter application logic ───────────────────────────────────────────────

/**
 * Simulate trade outcomes under given parameters by re-scoring each trade's
 * stored entryContext against the parameter set.
 *
 * Since we don't re-run the full market loop, we use a heuristic:
 *  - For each strategy the relevant params affect SL/TP multipliers.
 *  - Adjusted outcome = (actual_exit - entry) rescaled by tp/sl ratio.
 *  - For confidence/threshold params: filter out signals below the threshold.
 *
 * This is intentionally lightweight — the Trade records already contain real
 * PnL, and we use parameter sensitivity to adjust expected PnL ratios.
 */
function applyParamsToTrade(trade, strategyKey, params) {
  const pnl    = trade.pnlPercent ?? trade.pnl ?? 0;
  const won    = pnl > 0;
  const ctx    = trade.entryContext ?? {};

  switch (strategyKey) {
    case "AF_SMC": {
      const { confidenceFloor = 70, slMultiplierScalp = 1.0, tpMultiplierScalp = 4.0 } = params;
      const signalConf = ctx.signalConfidence ?? ctx.confidence ?? 75;
      if (signalConf < confidenceFloor) return null; // filtered out
      const scaleFactor = won
        ? (tpMultiplierScalp / 4.0)  // reference tp = 4.0
        : (slMultiplierScalp / 1.0); // reference sl = 1.0
      return won ? Math.abs(pnl) * scaleFactor : -Math.abs(pnl) * scaleFactor;
    }
    case "TS_TF": {
      const { adxMinStrength = 25, slMultiplier = 1.5, tpMultiplier = 2.0 } = params;
      const adx = ctx.adx ?? ctx.adxValue ?? 30;
      if (adx < adxMinStrength) return null;
      const sf = won ? tpMultiplier / 2.0 : slMultiplier / 1.5;
      return won ? Math.abs(pnl) * sf : -Math.abs(pnl) * sf;
    }
    case "MD_MR": {
      const { rsiOversold = 30, rsiOverbought = 70, bbMultiplier = 2.0 } = params;
      const rsi = ctx.rsi ?? 50;
      const side = trade.side ?? "long";
      if (side === "long"  && rsi > rsiOversold)   return null;
      if (side === "short" && rsi < rsiOverbought)  return null;
      const sf = won ? bbMultiplier / 2.0 : 1.0;
      return won ? Math.abs(pnl) * sf : -Math.abs(pnl);
    }
    case "BS_BR": {
      const { breakoutLookback = 20, volumeMultiplier = 1.3, consolidationThreshold = 0.75 } = params;
      const volRatio = ctx.volumeRatio ?? ctx.volume_ratio ?? 1.5;
      const consol   = ctx.consolidationScore ?? ctx.consolidation ?? 0.8;
      if (volRatio   < volumeMultiplier)        return null;
      if (consol     < consolidationThreshold)  return null;
      void breakoutLookback; // context-dependent; no direct filter available from stored context
      return won ? Math.abs(pnl) : -Math.abs(pnl);
    }
    default:
      return won ? Math.abs(pnl) : -Math.abs(pnl);
  }
}

// ── Main class ────────────────────────────────────────────────────────────────

class WalkForwardOptimizer {
  /**
   * Run walk-forward optimization for a (strategy, symbol) pair.
   *
   * @param {string} strategyKey
   * @param {string} symbol
   * @param {{ trainDays?: number, validDays?: number, searchSpace?: object }} options
   * @returns {{ strategyKey, symbol, bestParams, validationMetrics, iteration, timestamp, history }}
   */
  async optimize(strategyKey, symbol, options = {}) {
    const {
      trainDays  = 90,
      validDays  = 30,
      searchSpace: searchSpaceOverride = null,
    } = options;

    const space = searchSpaceOverride
      ? { ...(SEARCH_SPACE[strategyKey] ?? {}), ...searchSpaceOverride }
      : (SEARCH_SPACE[strategyKey] ?? {});

    if (Object.keys(space).length === 0) {
      throw new Error(`No search space defined for strategy: ${strategyKey}`);
    }

    const now     = new Date();
    const validEnd   = new Date(now);
    const validStart = new Date(now);
    validStart.setUTCDate(validStart.getUTCDate() - validDays);

    const trainEnd   = new Date(validStart);
    const trainStart = new Date(validStart);
    trainStart.setUTCDate(trainStart.getUTCDate() - trainDays);

    // Load trades for the full window (train + valid)
    const allTrades = await prisma.trade.findMany({
      where: {
        symbol,
        firedByStrategy: strategyKey,
        status:    "CLOSED",
        enteredAt: { gte: trainStart, lte: validEnd },
      },
      select: {
        id: true, pnl: true, pnlPercent: true, side: true,
        entryContext: true, enteredAt: true,
      },
      orderBy: { enteredAt: "asc" },
    });

    const trainTrades = allTrades.filter(t => t.enteredAt < validStart);
    const validTrades = allTrades.filter(t => t.enteredAt >= validStart);

    const results = await this.runGridSearch(strategyKey, symbol, trainTrades, space, validTrades);

    const best = results[0] ?? null;

    return {
      strategyKey,
      symbol,
      bestParams:        best?.params         ?? null,
      validationMetrics: best?.validMetrics   ?? null,
      trainMetrics:      best?.trainMetrics   ?? null,
      iteration: {
        trainTrades:     trainTrades.length,
        validTrades:     validTrades.length,
        trainStart:      trainStart.toISOString(),
        trainEnd:        trainEnd.toISOString(),
        validStart:      validStart.toISOString(),
        validEnd:        validEnd.toISOString(),
        combosEvaluated: results.length,
      },
      timestamp: now.toISOString(),
      history:   results.slice(0, 10), // top-10 combos for reference
    };
  }

  /**
   * Grid-search all parameter combinations, evaluate on train + validation windows.
   *
   * @param {string}   strategyKey
   * @param {string}   symbol          — unused in computation, kept for symmetry
   * @param {object[]} trainTrades
   * @param {object}   searchSpace
   * @param {object[]} [validTrades]   — optional; if omitted, validMetrics = trainMetrics
   * @returns {Array<{ params, trainMetrics, validMetrics }>} sorted by validMetrics.sharpe desc
   */
  async runGridSearch(strategyKey, _symbol, trainTrades, searchSpace, validTrades = []) {
    const keys        = Object.keys(searchSpace);
    const valueArrays = keys.map(k => rangeValues(searchSpace[k]));
    const passing     = [];

    for (const combo of cartesian(keys, valueArrays)) {
      const trainPnl = this._simulatePnlList(trainTrades, strategyKey, combo);
      const trainMetrics = computeMetrics(trainPnl);
      if (!this.passesConstraints(trainMetrics)) continue;

      const validPnl = validTrades.length > 0
        ? this._simulatePnlList(validTrades, strategyKey, combo)
        : trainPnl;
      const validMetrics = computeMetrics(validPnl);
      if (!this.passesConstraints(validMetrics)) continue;

      passing.push({ params: { ...combo }, trainMetrics, validMetrics });
    }

    passing.sort((a, b) => b.validMetrics.sharpe - a.validMetrics.sharpe);
    return passing;
  }

  /**
   * Simulate trades with given params and return aggregated metrics.
   * @returns {{ winRate, profitFactor, sharpe, sortino, tradeCount, maxDrawdown }}
   */
  simulateTrades(trades, strategyKey, params) {
    const pnlList = this._simulatePnlList(trades, strategyKey, params);
    return computeMetrics(pnlList);
  }

  /**
   * Returns true if metrics pass minimum quality constraints:
   *   WR ≥ 35%,  PF ≥ 1.2,  Sharpe ≥ 0.05
   */
  passesConstraints(metrics) {
    if (!metrics || metrics.tradeCount === 0) return false;
    return (
      metrics.winRate      >= 0.35 &&
      metrics.profitFactor >= 1.2  &&
      metrics.sharpe       >= 0.05
    );
  }

  /**
   * Retrieve stored ParameterSuggestion history for a strategy+symbol pair.
   * @returns {Promise<object[]>}
   */
  async getParameterHistory(strategyKey, symbol, limit = 10) {
    return prisma.parameterSuggestion.findMany({
      where: { strategyKey, symbol },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _simulatePnlList(trades, strategyKey, params) {
    const pnlList = [];
    for (const trade of trades) {
      const result = applyParamsToTrade(trade, strategyKey, params);
      if (result !== null) pnlList.push(result);
    }
    return pnlList;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = new WalkForwardOptimizer();
module.exports.WalkForwardOptimizer = WalkForwardOptimizer;
module.exports.SEARCH_SPACE         = SEARCH_SPACE;
module.exports._computeMetrics      = computeMetrics;  // exported for testing
module.exports._rangeValues         = rangeValues;      // exported for testing
