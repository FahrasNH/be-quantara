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
