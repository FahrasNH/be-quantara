/**
 * analytics.js — Sprint 2 / PA-3
 *
 * Internal analytics API endpoints for the Strategy Fit Matrix dashboard.
 * Register in app.js as:
 *   app.use('/api/v1/internal/analytics', authMiddleware, createAnalyticsRouter())
 *
 * Auth: x-internal-token header matched against env INTERNAL_API_TOKEN,
 *       or fall-through to admin JWT (via authMiddleware + adminGuard).
 *
 * Cache: in-memory 5-min TTL per query key.
 */

"use strict";

const express = require("express");
const prisma  = require("../../infrastructure/db/prismaClient");

// Sprint 5 / RL-5 — lazy-loaded to avoid startup failures if pgvector is unavailable
let _similarTradeAdvisor = null;
function getSimilarTradeAdvisor() {
  if (_similarTradeAdvisor) return _similarTradeAdvisor;
  try {
    const FeatureEngineer    = require("../../domain/FeatureEngineer");
    const SimilarTradeAdvisor = require("../../domain/SimilarTradeAdvisor");
    const VectorStore        = require("../../infrastructure/db/VectorStore");
    const { _pool }          = require("../../infrastructure/db/database");
    const vs = new VectorStore(_pool);
    _similarTradeAdvisor = new SimilarTradeAdvisor(vs, new FeatureEngineer());
  } catch (err) {
    console.warn("[Analytics] SimilarTradeAdvisor unavailable:", err.message);
  }
  return _similarTradeAdvisor;
}

// Sprint 6 / RAG-BT-5 — lazy-loaded backtest engines for RAG analytics
let _ragBacktestEngines = null;
function getRAGBacktestEngines() {
  if (_ragBacktestEngines) return _ragBacktestEngines;
  try {
    const FeatureEngineer             = require("../../domain/FeatureEngineer");
    const VectorStore                 = require("../../infrastructure/db/VectorStore");
    const { _pool }                   = require("../../infrastructure/db/database");
    const ConservativeBacktestEngine  = require("../../domain/ConservativeBacktestEngine");
    const WalkForwardBacktest         = require("../../domain/WalkForwardBacktest");
    const BiasQuantificationReport    = require("../../domain/BiasQuantificationReport");
    const AblationTest                = require("../../domain/AblationTest");
    const SimilarTradeAdvisor         = require("../../domain/SimilarTradeAdvisor");

    const vs = new VectorStore(_pool);
    const fe = new FeatureEngineer();
    const sta = new SimilarTradeAdvisor(vs, fe);
    const cbe = new ConservativeBacktestEngine(vs, fe, null);
    const wfb = new WalkForwardBacktest(cbe);
    const bqr = new BiasQuantificationReport();
    const abl = new AblationTest(null, sta, fe);

    _ragBacktestEngines = { cbe, wfb, bqr, abl, vs, fe };
  } catch (err) {
    console.warn("[Analytics] RAG backtest engines unavailable:", err.message);
  }
  return _ragBacktestEngines;
}

// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal token middleware
// ─────────────────────────────────────────────────────────────────────────────

function internalTokenGate(req, res, next) {
  const token = req.headers["x-internal-token"];
  if (token && process.env.INTERNAL_API_TOKEN && token === process.env.INTERNAL_API_TOKEN) {
    return next(); // valid internal token
  }
  // Fall back: require authenticated admin session (authMiddleware already ran)
  if (req.user || req.adminUser) {
    const role = (req.user || req.adminUser)?.role ?? "";
    if (role === "ADMIN" || role === "SUPER_ADMIN") return next();
  }
  return res.status(401).json({ ok: false, message: "Unauthorized: internal token or admin JWT required" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Router factory
// ─────────────────────────────────────────────────────────────────────────────

module.exports = function createAnalyticsRouter() {
  const router = express.Router();

  // Apply internal token gate to all routes in this router
  router.use(internalTokenGate);

  // ── GET /fit-matrix ─────────────────────────────────────────────────────────
  /**
   * Returns strategy × regime performance matrix.
   * Query: strategy?, symbol?, regime?, period=30d
   */
  router.get("/fit-matrix", async (req, res) => {
    const t0 = Date.now();
    try {
      const { strategy, symbol, regime, period = "30d" } = req.query;
      const cacheKey = `fit-matrix:${strategy ?? ""}:${symbol ?? ""}:${regime ?? ""}:${period}`;

      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ok: true, fromCache: true, ...cached });

      // Build date filter from period
      const dateFilter = buildDateFilter(period);

      const where = { ...dateFilter };
      if (strategy) where.strategyKey = strategy;
      if (symbol)   where.symbol      = symbol;
      if (regime)   where.regime      = regime;

      const rows = await prisma.strategyPerformance.findMany({
        where,
        orderBy: [{ strategyKey: "asc" }, { regime: "asc" }],
      });

      // Aggregate: if multiple period rows per (strategy, regime), average them
      const buckets = new Map();
      for (const row of rows) {
        const k = `${row.strategyKey}||${row.symbol ?? ""}||${row.regime}`;
        if (!buckets.has(k)) buckets.set(k, { ...row, _count: 1 });
        else {
          const b = buckets.get(k);
          b.winRate       = (b.winRate       + row.winRate)       / 2;
          b.profitFactor  = (b.profitFactor  + row.profitFactor)  / 2;
          b.sharpeRatio   = avg2(b.sharpeRatio, row.sharpeRatio);
          b.tradeCount   += row.tradeCount;
          b.sampleSizeValid = b.tradeCount >= 20;
          b._count++;
        }
      }

      const matrix = [...buckets.values()].map(r => ({
        strategy:       r.strategyKey,
        symbol:         r.symbol,
        regime:         r.regime,
        winRate:        +r.winRate.toFixed(4),
        profitFactor:   +r.profitFactor.toFixed(4),
        sharpe:         r.sharpeRatio != null ? +r.sharpeRatio.toFixed(4) : null,
        expectancy:     r.expectancy  != null ? +r.expectancy.toFixed(4)  : null,
        sampleSize:     r.tradeCount,
        sampleSizeValid: r.sampleSizeValid,
        ...(r.sampleSizeValid === false ? { insufficientData: true } : {}),
      }));

      const payload = { matrix };
      cacheSet(cacheKey, payload);

      const elapsed = Date.now() - t0;
      return res.json({ ok: true, fromCache: false, elapsed, ...payload });

    } catch (err) {
      console.error("[analytics /fit-matrix] Error:", err.message);
      return res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── GET /strategy/:key/performance ──────────────────────────────────────────
  /**
   * Returns performance breakdown for a single strategy across multiple periods.
   * Query: symbol?, period=30d
   */
  router.get("/strategy/:key/performance", async (req, res) => {
    const t0 = Date.now();
    try {
      const strategyKey = req.params.key;
      const { symbol, period = "30d" } = req.query;
      const cacheKey = `strategy-perf:${strategyKey}:${symbol ?? ""}:${period}`;

      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ok: true, fromCache: true, ...cached });

      // Fetch rows for 7d, 30d, all-time rolling periods
      const periodsToFetch = ["7d", "30d", "all-time"];
      const periodsData    = {};

      for (const p of periodsToFetch) {
        const where = { strategyKey, period: p };
        if (symbol) where.symbol = symbol;

        const rows = await prisma.strategyPerformance.findMany({
          where,
          orderBy: { periodDate: "desc" },
          take: 50,
        });

        if (rows.length === 0) {
          periodsData[p] = null;
          continue;
        }

        // Aggregate across all rows for this period
        periodsData[p] = aggregatePeriodRows(rows);
      }

      // Also fetch regime breakdown (latest daily data)
      const regimeRows = await prisma.strategyPerformance.findMany({
        where: {
          strategyKey,
          ...(symbol ? { symbol } : {}),
          period: "daily",
          ...buildDateFilter("30d"),
        },
        orderBy: [{ regime: "asc" }, { periodDate: "desc" }],
      });

      const byRegimeMap = new Map();
      for (const row of regimeRows) {
        if (!byRegimeMap.has(row.regime)) byRegimeMap.set(row.regime, []);
        byRegimeMap.get(row.regime).push(row);
      }

      const byRegime = [...byRegimeMap.entries()].map(([regime, rows]) => ({
        regime,
        ...aggregatePeriodRows(rows),
      }));

      const payload = {
        strategyKey,
        periods: periodsData,
        byRegime,
      };

      cacheSet(cacheKey, payload);
      const elapsed = Date.now() - t0;
      return res.json({ ok: true, fromCache: false, elapsed, ...payload });

    } catch (err) {
      console.error("[analytics /strategy/:key/performance] Error:", err.message);
      return res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── GET /regime-distribution ─────────────────────────────────────────────────
  /**
   * Returns % time in each regime for a symbol.
   * Query: symbol (required), period=30d
   */
  router.get("/regime-distribution", async (req, res) => {
    const t0 = Date.now();
    try {
      const { symbol, period = "30d" } = req.query;

      if (!symbol) {
        return res.status(400).json({ ok: false, message: "symbol is required" });
      }

      const cacheKey = `regime-dist:${symbol}:${period}`;
      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ok: true, fromCache: true, ...cached });

      const dateFilter = buildDateFilter(period);

      // Use StrategyPerformance rows to derive distribution
      const rows = await prisma.strategyPerformance.findMany({
        where: { symbol, period: "daily", ...dateFilter },
        select: { regime: true, tradeCount: true },
      });

      if (rows.length === 0) {
        const payload = { symbol, period, distribution: [] };
        cacheSet(cacheKey, payload);
        return res.json({ ok: true, fromCache: false, elapsed: Date.now() - t0, ...payload });
      }

      // Aggregate trade counts per regime
      const regimeCounts = new Map();
      let total = 0;
      for (const row of rows) {
        regimeCounts.set(row.regime, (regimeCounts.get(row.regime) ?? 0) + row.tradeCount);
        total += row.tradeCount;
      }

      const distribution = [...regimeCounts.entries()]
        .map(([regime, count]) => ({
          regime,
          pct:        total > 0 ? +((count / total) * 100).toFixed(2) : 0,
          tradeCount: count,
        }))
        .sort((a, b) => b.pct - a.pct);

      const payload = { symbol, period, distribution };
      cacheSet(cacheKey, payload);
      const elapsed = Date.now() - t0;
      return res.json({ ok: true, fromCache: false, elapsed, ...payload });

    } catch (err) {
      console.error("[analytics /regime-distribution] Error:", err.message);
      return res.status(500).json({ ok: false, message: err.message });
    }
  });

  // ── POST /similar-trades (RL-5) ──────────────────────────────────────────────
  /**
   * Find similar historical trades and return aggregated stats.
   * Body: { symbol, strategyKey, entryContext, regime? }
   */
  router.post("/similar-trades", async (req, res) => {
    try {
      const { symbol, strategyKey, entryContext, regime } = req.body || {};
      if (!entryContext) {
        return res.status(400).json({ ok: false, error: "entryContext is required" });
      }

      const advisor = getSimilarTradeAdvisor();
      if (!advisor) {
        return res.status(503).json({ ok: false, error: "SimilarTradeAdvisor not available (pgvector may be disabled)" });
      }

      const tradeMetadata = { strategyKey, symbol, regime };
      const analysis = await advisor.findSimilarAndAnalyze(entryContext, tradeMetadata, { k: 20 });
      const card     = advisor.formatCard(analysis);

      return res.json({ ok: true, ...card });
    } catch (err) {
      console.error("[Analytics] similar-trades error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /rag-backtest/status (Sprint 6 / RAG-BT-5) ───────────────────────
  /**
   * Returns component health status for the RAG backtest dashboard.
   * Checks: pgvector, WinPredictor model, MLShadow active, SimilarTrades count.
   */
  router.get("/rag-backtest/status", async (req, res) => {
    const t0 = Date.now();
    try {
      const engines = getRAGBacktestEngines();

      let pgvectorOk       = false;
      let similarTradeCount = 0;
      let shadowLogCount    = 0;
      let winPredictorLoaded = false;

      // pgvector health check
      try {
        if (engines?.vs) {
          await engines.vs.findSimilar(new Array(60).fill(0), 1, {});
          pgvectorOk = true;
        }
      } catch {
        pgvectorOk = false;
      }

      // Similar trade count
      try {
        similarTradeCount = await prisma.tradeEmbedding.count().catch(() => 0);
      } catch { /* ignore */ }

      // Shadow log count
      try {
        shadowLogCount = await prisma.mLShadowLog.count().catch(() => 0);
      } catch { /* ignore */ }

      // WinPredictor status
      winPredictorLoaded = !!(engines?.cbe?.winPredictor?.model);

      const ragMode = process.env.RAG_MODE || "shadow";

      return res.json({
        ok: true,
        elapsed: Date.now() - t0,
        components: {
          pgvector:           { ok: pgvectorOk,        label: pgvectorOk ? "Connected" : "Unavailable" },
          winPredictor:       { ok: winPredictorLoaded, label: winPredictorLoaded ? "Model loaded" : "Not loaded" },
          mlShadow:           { ok: shadowLogCount > 0, count: shadowLogCount, label: `${shadowLogCount} logs` },
          similarTrades:      { ok: similarTradeCount > 0, count: similarTradeCount, label: `${similarTradeCount} embeddings` },
        },
        ragMode,
        enginesAvailable: !!engines,
      });
    } catch (err) {
      console.error("[Analytics] rag-backtest/status error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /rag-backtest/results (Sprint 6 / RAG-BT-5) ─────────────────────
  /**
   * Returns backtest + walk-forward + ablation + bias report results.
   * Runs on staging trade data from Prisma (Trade model).
   * Query: ?symbol=&period=30d&limit=500
   */
  router.get("/rag-backtest/results", async (req, res) => {
    const t0 = Date.now();
    try {
      const { symbol, period = "30d", limit = "500" } = req.query;
      const cacheKey = `rag-backtest-results:${symbol ?? ""}:${period}:${limit}`;

      const cached = cacheGet(cacheKey);
      if (cached) return res.json({ ok: true, fromCache: true, elapsed: 0, ...cached });

      if (process.env.NODE_ENV === "production") {
        return res.status(403).json({
          ok: false,
          error: "[STAGING_ONLY] RAG backtest results are only available in staging/test environments",
        });
      }

      const engines = getRAGBacktestEngines();
      if (!engines) {
        return res.status(503).json({ ok: false, error: "RAG backtest engines not available" });
      }

      // Fetch historical trades
      const dateFilter = buildDateFilter(period);
      const where = { ...dateFilter };
      if (symbol) where.symbol = symbol;

      const rawTrades = await prisma.trade.findMany({
        where,
        orderBy: { createdAt: "asc" },
        take:    parseInt(limit, 10) || 500,
        select: {
          id: true, symbol: true, strategyKey: true, regime: true,
          createdAt: true, outcome: true, pnlPct: true, entryContext: true,
        },
      }).catch(() => []);

      // Normalize trades
      const trades = rawTrades.map((t) => ({
        ...t,
        entryAt:      t.createdAt,
        result:       t.outcome,
        pnl:          t.pnlPct,
        entryContext: t.entryContext || {},
      }));

      // Run conservative backtest
      let backtestResult = null;
      try {
        backtestResult = await engines.cbe.runBacktest(trades, {});
      } catch (err) {
        console.warn("[Analytics] Conservative backtest failed:", err.message);
        backtestResult = { results: [], metrics: null, ragUsed: false };
      }

      // Run walk-forward backtest
      let walkForwardResult = null;
      try {
        walkForwardResult = await engines.wfb.run(trades, {});
      } catch (err) {
        console.warn("[Analytics] Walk-forward backtest failed:", err.message);
        walkForwardResult = { windows: [], aggregate: null, consistencyScore: 0 };
      }

      // Run ablation test
      let ablationResult = null;
      try {
        ablationResult = await engines.abl.run(trades);
      } catch (err) {
        console.warn("[Analytics] Ablation test failed:", err.message);
        ablationResult = null;
      }

      // Live metrics from shadow log
      let liveMetrics = null;
      try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const shadowLogs = await prisma.mLShadowLog.findMany({
          where:   { createdAt: { gte: thirtyDaysAgo }, actualOutcome: { not: null } },
          orderBy: { createdAt: "asc" },
          take:    1000,
        });
        if (shadowLogs.length > 0) {
          const wins = shadowLogs.filter((l) => l.actualOutcome === "win").length;
          const losses = shadowLogs.length - wins;
          const wr = wins / shadowLogs.length;
          liveMetrics = {
            tradeCount:   shadowLogs.length,
            winRate:      +wr.toFixed(4),
            profitFactor: null, // requires PnL data
            sharpe:       null,
            avgPnl:       null,
          };
        }
      } catch { /* ignore */ }

      // Bias report
      let biasReport = null;
      if (backtestResult?.metrics && liveMetrics) {
        try {
          biasReport = engines.bqr.generate(backtestResult.metrics, liveMetrics);
        } catch (err) {
          console.warn("[Analytics] Bias report failed:", err.message);
        }
      }

      const payload = {
        tradeCount:    trades.length,
        period,
        symbol:        symbol ?? null,
        backtest:      backtestResult,
        walkForward:   walkForwardResult,
        ablation:      ablationResult,
        liveMetrics,
        biasReport,
        generatedAt:   new Date().toISOString(),
      };

      cacheSet(cacheKey, payload);
      return res.json({ ok: true, fromCache: false, elapsed: Date.now() - t0, ...payload });
    } catch (err) {
      console.error("[Analytics] rag-backtest/results error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDateFilter(period) {
  if (!period || period === "all-time") return {};
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  return { periodDate: { gte: since } };
}

function avg2(a, b) {
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return (a + b) / 2;
}

function aggregatePeriodRows(rows) {
  if (!rows || rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + r.tradeCount, 0);
  const wins  = rows.reduce((s, r) => s + r.winCount,   0);

  const avgOf = field => {
    const vals = rows.map(r => r[field]).filter(v => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };

  const valid = total >= 20;
  return {
    tradeCount:      total,
    winCount:        wins,
    winRate:         total > 0 ? +(wins / total).toFixed(4) : 0,
    profitFactor:    +avgOf("profitFactor").toFixed(4),
    sharpe:          avgOf("sharpeRatio") != null ? +avgOf("sharpeRatio").toFixed(4) : null,
    sortino:         avgOf("sortino")     != null ? +avgOf("sortino").toFixed(4)     : null,
    expectancy:      avgOf("expectancy")  != null ? +avgOf("expectancy").toFixed(4)  : null,
    avgRr:           avgOf("avgRr")       != null ? +avgOf("avgRr").toFixed(4)       : null,
    avgHoldingHours: avgOf("avgHoldingHours") != null ? +avgOf("avgHoldingHours").toFixed(2) : null,
    maxDrawdownPct:  avgOf("maxDrawdownPct")  != null ? +avgOf("maxDrawdownPct").toFixed(4)  : null,
    sampleSizeValid: valid,
    ...(valid ? {} : { insufficientData: true }),
  };
}
