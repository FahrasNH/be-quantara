/**
 * AI Routes — xAI Grok integration (console.x.ai)
 *
 * POST /analyze       — AI-powered backtest optimization
 * GET  /status        — integration health
 * POST /sync-knowledge — upload docs to Collections (admin)
 * POST /export-training — export ML dataset
 * POST /upload-training — export + upload to Collection
 */

const express = require("express");
const { asyncHandler } = require("../../../shared/middleware/errorHandler");
const { requireFeature } = require("../../../shared/middleware/subscriptionGuard");
const XaiTrainingService = require("../services/XaiTrainingService");
const OptimizationAnalysisService = require("../../analytics/services/OptimizationAnalysisService");
const GrokConfirmService = require("../services/GrokConfirmService");
const RagExplainService = require("../rag/RagExplainService");
const cfg = require("../../../config/env");

module.exports = function createAiRouter() {
  const router = express.Router();

  // Defense-in-depth: route-layer tier gate (service layer still checks canUseAiOptimizer).
  const requireAiOptimizer = requireFeature("aiOptimizer");

  router.get("/status", asyncHandler(async (_req, res) => {
    const base = XaiTrainingService.getStatus();
    res.json({
      ok: true,
      data: {
        ...base,
        grokConfirm: {
          liveEnabled: GrokConfirmService.isEnabled(),
          backtestAvailable: GrokConfirmService.isApiReady(),
          requiresLiveFlag: cfg.GROK_CONFIRM_ENABLED !== true,
        },
      },
    });
  }));

  router.post("/analyze", requireAiOptimizer, asyncHandler(async (req, res) => {
    const access = await XaiTrainingService.canUseAiOptimizer(req.userId);
    if (!access.allowed) {
      return res.status(403).json({
        ok: false,
        error: access.reason,
        tier: access.tier ?? null,
      });
    }

    const { symbol, backtest_id, metrics, strategyKey, useRulesFallback = true } = req.body || {};

    if (!metrics && !symbol && !backtest_id) {
      return res.status(400).json({
        ok: false,
        error: "metrics, symbol, or backtest_id is required",
      });
    }

    let normalizedMetrics = metrics
      ? OptimizationAnalysisService.mapSessionStats(metrics)
      : null;

    if (!normalizedMetrics) {
      const backtest = await OptimizationAnalysisService._getBacktestDataForAi(
        symbol,
        backtest_id ? parseInt(backtest_id, 10) : null
      );
      normalizedMetrics = OptimizationAnalysisService._normalizeMetrics(backtest.metrics);
    }

    let ruleBased = null;
    if (useRulesFallback) {
      ruleBased = await OptimizationAnalysisService.analyzeBacktest(
        symbol,
        backtest_id ? parseInt(backtest_id, 10) : null,
        { metricsOverride: metrics ? OptimizationAnalysisService.mapSessionStats(metrics) : null }
      );
    }

    const ragQuery = `optimasi strategi ${strategyKey ?? ""} ${symbol ?? ""} win rate profit factor drawdown`.trim();

    const aiResult = await XaiTrainingService.analyzeBacktest(normalizedMetrics, {
      symbol,
      strategyKey,
      ragQuery,
    });

    const merged = OptimizationAnalysisService.mergeAiWithRules(ruleBased, aiResult);

    res.json({
      ok: true,
      data: {
        ...merged,
        source: "xai",
        xai_model: cfg.XAI_MODEL,
      },
    });
  }));

  router.post("/export-training", requireAiOptimizer, asyncHandler(async (req, res) => {
    const access = await XaiTrainingService.canUseAiOptimizer(req.userId);
    if (!access.allowed) {
      return res.status(403).json({ ok: false, error: access.reason });
    }

    const { symbol, limit = 500, dryRun, format = "json" } = req.body || {};
    const dataset = await XaiTrainingService.exportTrainingDataset(req.userId, {
      symbol,
      limit,
      dryRun: dryRun ?? null,
    });

    if (format === "jsonl") {
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Content-Disposition", `attachment; filename="quantara-training-${Date.now()}.jsonl"`);
      return res.send(dataset.jsonl);
    }

    res.json({ ok: true, data: dataset });
  }));

  router.post("/upload-training", requireAiOptimizer, asyncHandler(async (req, res) => {
    const access = await XaiTrainingService.canUseAiOptimizer(req.userId);
    if (!access.allowed) {
      return res.status(403).json({ ok: false, error: access.reason });
    }

    if (!cfg.XAI_COLLECTION_ID) {
      return res.status(400).json({
        ok: false,
        error: "XAI_COLLECTION_ID belum dikonfigurasi di server",
      });
    }

    const { symbol, limit = 500, dryRun } = req.body || {};
    const result = await XaiTrainingService.uploadTrainingSnapshot(req.userId, {
      symbol,
      limit,
      dryRun: dryRun ?? null,
    });

    res.json({ ok: true, data: result });
  }));

  router.post("/sync-knowledge", asyncHandler(async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const headerSecret = req.headers["x-admin-secret"];
    if (!adminSecret || headerSecret !== adminSecret) {
      return res.status(403).json({ ok: false, error: "Admin secret required" });
    }

    const { includeStrategyDefaults = true } = req.body || {};
    const result = await XaiTrainingService.syncKnowledgeBase({ includeStrategyDefaults });

    res.json({ ok: true, data: result });
  }));

  /**
   * POST /explain — True-RAG evidence-grounded research Q&A (offline-first).
   * Input: { question, strategyKey?, regime?, symbol?, backtest_id? }
   */
  router.post("/explain", requireAiOptimizer, asyncHandler(async (req, res) => {
    const access = await XaiTrainingService.canUseAiOptimizer(req.userId);
    if (!access.allowed) {
      return res.status(403).json({ ok: false, error: access.reason, tier: access.tier ?? null });
    }

    const { question, strategyKey, regime, symbol, timeframe, skipLlm } = req.body || {};
    if (!question || String(question).trim().length < 5) {
      return res.status(400).json({ ok: false, error: "question is required (min 5 chars)" });
    }

    const result = await RagExplainService.explain({
      question: String(question).trim(),
      strategyKey,
      regime,
      symbol,
      timeframe,
      skipLlm: skipLlm === true,
    });

    res.json({ ok: true, data: result });
  }));

  router.post("/rag/ingest", asyncHandler(async (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    const headerSecret = req.headers["x-admin-secret"];
    if (!adminSecret || headerSecret !== adminSecret) {
      return res.status(403).json({ ok: false, error: "Admin secret required" });
    }

    const result = await RagExplainService.ingest(req.body || {});
    res.json({ ok: true, data: result });
  }));

  return router;
};
