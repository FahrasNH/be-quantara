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
const prisma  = require("../../../infrastructure/db/prismaClient");
const db      = require("../../../infrastructure/db/database");
const { isRagBacktestAllowed } = require("../../../config/ragBacktestEnv");
const { adminGuard } = require("../../../shared/middleware/adminGuard");
const { normalizeStrategyKey: normalizeStrategyKeyCanonical } = require("../../../config/strategies");

// Sprint 5 / RL-5 — lazy-loaded to avoid startup failures if pgvector is unavailable
let _similarTradeAdvisor = null;
function getSimilarTradeAdvisor() {
  if (_similarTradeAdvisor) return _similarTradeAdvisor;
  try {
    const FeatureEngineer    = require("../../ml/domain/FeatureEngineer");
    const SimilarTradeAdvisor = require("../../ml/domain/SimilarTradeAdvisor");
    const VectorStore        = require("../../../infrastructure/db/VectorStore");
    const { _pool }          = require("../../../infrastructure/db/database");
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
    const FeatureEngineer             = require("../../ml/domain/FeatureEngineer");
    const VectorStore                 = require("../../../infrastructure/db/VectorStore");
    const { _pool }                   = require("../../../infrastructure/db/database");
    const ConservativeBacktestEngine  = require("#core/research-engine/ConservativeBacktestEngine.js");
    const WalkForwardBacktest         = require("../../../core/research-engine/WalkForwardBacktest");
    const BiasQuantificationReport    = require("../../../core/research-engine/BiasQuantificationReport");
    const AblationTest                = require("../../../core/research-engine/AblationTest");
    const SimilarTradeAdvisor         = require("../../ml/domain/SimilarTradeAdvisor");

    const vs = new VectorStore(_pool);
    const fe = new FeatureEngineer();
    const sta = new SimilarTradeAdvisor(vs, fe);
    const cbe = new ConservativeBacktestEngine(vs, fe, null);
    const abl = new AblationTest(null, sta, fe);
    const wfb = new WalkForwardBacktest(cbe, abl);
    const bqr = new BiasQuantificationReport();

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
  // Fall back: admin JWT — authMiddleware sets req.userId; adminGuard loads role from DB
  return adminGuard(req, res, next);
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

      let pgvectorOk        = false;
      let pgvectorLatency   = null;
      let featureExtractionLatency = null;
      let lgbInferenceLatency      = null;
      let similarTradeCount = 0;
      let shadowLogCount    = 0;
      let winPredictorLoaded = false;
      let modelAuc          = null;

      // pgvector health + latency
      try {
        if (engines?.vs) {
          const tPg = Date.now();
          await engines.vs.findSimilar(new Array(60).fill(0), 1, {});
          pgvectorLatency = Date.now() - tPg;
          pgvectorOk = true;
        }
      } catch {
        pgvectorOk = false;
      }

      // Feature extraction latency
      try {
        if (engines?.fe) {
          const tFe = Date.now();
          engines.fe.buildFeatureVector({ regime: "ranging" }, { strategyKey: "SMART_MONEY_CONCEPTS", symbol: "BTCUSDT" });
          featureExtractionLatency = Date.now() - tFe;
        }
      } catch { /* ignore */ }

      // LGB inference latency (WinPredictor if loaded)
      try {
        if (engines?.cbe?.winPredictor?.model && engines?.fe) {
          const tLgb = Date.now();
          const features = engines.fe.buildFeatureVector({ regime: "ranging" }, { strategyKey: "SMART_MONEY_CONCEPTS", symbol: "BTCUSDT" });
          engines.cbe.winPredictor.predict(features);
          lgbInferenceLatency = Date.now() - tLgb;
        }
      } catch { /* ignore */ }

      // Similar trade count
      try {
        similarTradeCount = await prisma.tradeEmbedding.count().catch(() => 0);
      } catch { /* ignore */ }

      // Shadow log count + AUC
      try {
        shadowLogCount = await prisma.mLShadowLog.count().catch(() => 0);
        if (shadowLogCount > 0) {
          const MLShadowService = require("../../ml/services/MLShadowService");
          const svc = new MLShadowService();
          const aucResult = await svc.computeAUC().catch(() => null);
          if (aucResult?.auc != null) modelAuc = aucResult.auc;
        }
      } catch { /* ignore */ }

      // WinPredictor status
      winPredictorLoaded = !!(engines?.cbe?.winPredictor?.model);

      const ragMode = process.env.RAG_MODE || "shadow";

      return res.json({
        ok: true,
        elapsed: Date.now() - t0,
        pgvectorLatency,
        lgbInferenceLatency,
        featureExtractionLatency,
        modelAuc,
        components: {
          pgvector:      { ok: pgvectorOk,        label: pgvectorOk ? "Connected" : "Unavailable" },
          winPredictor:  { ok: winPredictorLoaded, label: winPredictorLoaded ? "Model loaded" : "Not loaded" },
          mlShadow:      { ok: shadowLogCount > 0, count: shadowLogCount, label: `${shadowLogCount} logs` },
          similarTrades: { ok: similarTradeCount > 0, count: similarTradeCount, label: `${similarTradeCount} embeddings` },
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
      const { symbol, strategyKey, period = "90d", limit = "500", view, _t } = req.query;
      const cacheKey = `rag-backtest-results:${symbol ?? ""}:${strategyKey ?? ""}:${period}:${limit}:${view ?? ""}`;

      if (!_t) {
        const cached = cacheGet(cacheKey);
        if (cached) return res.json({ ok: true, fromCache: true, elapsed: 0, ...cached });
      }

      if (!isRagBacktestAllowed()) {
        return res.status(403).json({
          ok: false,
          error: "[STAGING_ONLY] RAG backtest results are only available in staging/test environments",
        });
      }

      const engines = getRAGBacktestEngines();
      if (!engines) {
        return res.status(503).json({ ok: false, error: "RAG backtest engines not available" });
      }

      const trades = await fetchBacktestTrades({ symbol, strategyKey, period, limit: parseInt(limit, 10) || 500 });

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
          const wr = wins / shadowLogs.length;
          liveMetrics = {
            tradeCount:   shadowLogs.length,
            winRate:      +wr.toFixed(4),
            profitFactor: null,
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

      const btMetrics = backtestResult?.metrics;
      const timeAware = {
        baselineWr:             ablationResult?.baseline?.wr ?? null,
        baselinePf:             ablationResult?.baseline?.pf ?? null,
        backTestWr:             btMetrics?.winRate ?? null,
        backTestPf:             btMetrics?.profitFactor ?? null,
        conservativeWrEstimate: btMetrics?.conservative?.winRate ?? null,
        conservativePfEstimate: btMetrics?.conservative?.profitFactor ?? null,
        conservativeDiscount:   btMetrics?.discountFactor != null
          ? +(1 - btMetrics.discountFactor).toFixed(2)
          : 0.1,
      };

      const walkForwardChart = (walkForwardResult?.windows || []).map((w) => ({
        window: w.windowIndex,
        lgbWr:  w.lgbWr ?? w.wr,
        ragWr:  w.ragWr ?? w.wr,
        lgbPf:  w.lgbPf ?? w.pf,
        ragPf:  w.ragPf ?? w.pf,
      }));

      const payload = {
        tradeCount:    trades.length,
        period,
        symbol:        symbol ?? null,
        strategyKey:   strategyKey ?? null,
        backtest:      backtestResult,
        walkForward:   walkForwardResult,
        walkForwardChart,
        ablation:      ablationResult,
        timeAware,
        liveMetrics,
        biasReport,
        generatedAt:   new Date().toISOString(),
      };

      // Optional view filter for lighter API responses
      if (view === "walk-forward") {
        const slim = { ok: true, walkForward: walkForwardResult, walkForwardChart, tradeCount: trades.length };
        return res.json({ ...slim, elapsed: Date.now() - t0 });
      }
      if (view === "ablation") {
        const slim = { ok: true, ablation: ablationResult, timeAware, tradeCount: trades.length };
        return res.json({ ...slim, elapsed: Date.now() - t0 });
      }

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
  return { enteredAt: { gte: since } };
}

/** Normalize strategy keys for analytics filters (SSOT: config/strategies.js). */
function normalizeStrategyKey(raw) {
  if (!raw) return null;
  return normalizeStrategyKeyCanonical(String(raw).toUpperCase());
}

/**
 * Load closed trades from the real engine store (`trades` table via database.js),
 * with optional Prisma Trade fallback for feature-store rows.
 */
async function fetchBacktestTrades({ symbol, strategyKey, period, limit = 500 } = {}) {
  const maxRows = Math.min(limit || 500, 5000);
  let rows = [];

  try {
    rows = await db.getTradesExport({ symbol: symbol || null, limit: maxRows });
  } catch (err) {
    console.warn("[Analytics] getTradesExport failed:", err.message);
  }

  let trades = rows
    .filter((r) => r.status === "Closed" && r.result !== "cancelled" && r.result !== "N/A")
    .map((r) => ({
      id:           String(r.id),
      symbol:       r.symbol,
      strategyKey:  normalizeStrategyKey(r.strategy),
      entryAt:      r.openTime,
      createdAt:    r.openTime,
      outcome:      r.result,
      result:       r.result,
      pnlPct:       typeof r.pnlPct === "number" ? r.pnlPct : parseFloat(r.pnlPct) || 0,
      pnl:          typeof r.pnl === "number" ? r.pnl : parseFloat(r.pnl) || 0,
      entryContext: {},
      regime:       null,
    }));

  // Period filter
  if (period && period !== "all-time") {
    const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
    const sinceMs = Date.now() - days * 86400000;
    trades = trades.filter((t) => new Date(t.entryAt).getTime() >= sinceMs);
  }

  // Symbol filter (defense in depth — getTradesExport filters but Prisma fallback may not)
  if (symbol) {
    trades = trades.filter((t) => String(t.symbol || "").toUpperCase() === String(symbol).toUpperCase());
  }

  // Strategy filter
  if (strategyKey) {
    const want = normalizeStrategyKey(strategyKey);
    trades = trades.filter((t) => normalizeStrategyKey(t.strategyKey) === want);
  }

  // Prisma fallback if engine store is empty
  if (trades.length === 0) {
    try {
      const dateFilter = buildDateFilter(period);
      const where = { status: "CLOSED", ...dateFilter };
      if (symbol) where.symbol = symbol;
      if (strategyKey) {
        const want = normalizeStrategyKey(strategyKey);
        where.firedByStrategy = { in: [strategyKey, want].filter(Boolean) };
      }

      const prismaRows = await prisma.trade.findMany({
        where,
        orderBy: { enteredAt: "asc" },
        take: maxRows,
        select: {
          id: true, symbol: true, firedByStrategy: true,
          enteredAt: true, pnl: true, pnlPercent: true, entryContext: true,
        },
      });

      trades = prismaRows.map((t) => {
        const pnl = t.pnl ?? 0;
        const outcome = pnl > 0 ? "win" : "loss";
        return {
          id:           t.id,
          symbol:       t.symbol,
          strategyKey:  normalizeStrategyKey(t.firedByStrategy),
          entryAt:      t.enteredAt,
          createdAt:    t.enteredAt,
          outcome,
          result:       outcome,
          pnlPct:       t.pnlPercent ?? 0,
          pnl:          pnl,
          entryContext: t.entryContext || {},
          regime:       t.entryContext?.regime ?? null,
        };
      });
    } catch (err) {
      console.warn("[Analytics] Prisma trade fallback failed:", err.message);
    }
  }

  return trades.sort(
    (a, b) => new Date(a.entryAt || 0) - new Date(b.entryAt || 0)
  );
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
