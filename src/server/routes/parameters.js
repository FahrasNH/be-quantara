/**
 * parameters.js — Sprint 4 / WT-2
 *
 * REST API for walk-forward parameter suggestions, history, and deployment.
 * Register in app.js as:
 *   app.use('/api/v1/internal/parameters', authMiddleware, createParametersRouter())
 *
 * Endpoints:
 *   GET  /suggestions                           — list pending/filtered suggestions
 *   GET  /suggestions/:id                       — full suggestion detail
 *   POST /suggestions/:id/apply                 — apply (adminGuard)
 *   POST /suggestions/:id/reject                — reject (adminGuard)
 *   GET  /history/:strategyKey/:symbol          — ParameterVersion history
 *   POST /rollback                              — rollback (superAdminGuard)
 *   GET  /job/status                            — WalkForwardJob last-run info
 *   POST /job/run                               — trigger job manually (superAdminGuard)
 */

"use strict";

const express = require("express");
const prisma  = require("../../infrastructure/db/prismaClient");
const deployService = require("../services/ParameterDeployService");
const walkForwardJob = require("../../infrastructure/jobs/WalkForwardJob");
const { adminGuard, superAdminGuard } = require("../../middleware/adminGuard");

// ── Helpers ───────────────────────────────────────────────────────────────────

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Compute a confidence score (0–1) from validMetrics compared to minimum thresholds.
 * Higher WR + PF + Sharpe → higher confidence.
 */
function computeConfidence(validMetrics) {
  if (!validMetrics) return 0;
  const { winRate = 0, profitFactor = 0, sharpe = 0 } = validMetrics;
  const wrScore  = Math.min(1, Math.max(0, (winRate     - 0.35) / 0.30));
  const pfScore  = Math.min(1, Math.max(0, (profitFactor - 1.2)  / 1.8));
  const shScore  = Math.min(1, Math.max(0, (sharpe       - 0.05) / 1.45));
  return Math.round(((wrScore + pfScore + shScore) / 3) * 100) / 100;
}

// ── Router factory ────────────────────────────────────────────────────────────

let _jobLastRun  = null;
let _jobNextRun  = null;
let _jobStats    = null;
let _jobRunning  = false;

module.exports = function createParametersRouter() {
  const router = express.Router();

  // ── GET /suggestions ───────────────────────────────────────────────────────
  router.get("/suggestions", [adminGuard], asyncHandler(async (req, res) => {
    const { strategy, symbol, status = "pending" } = req.query;

    const where = {};
    if (strategy) where.strategyKey = strategy;
    if (symbol)   where.symbol      = symbol;
    if (status !== "all") where.status = status;

    const rows = await prisma.parameterSuggestion.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take:    100,
    });

    const suggestions = rows.map(s => ({
      id:             s.id,
      strategyKey:    s.strategyKey,
      symbol:         s.symbol,
      suggestedParams: s.suggestedParams,
      currentParams:  s.currentParams,
      trainMetrics:   s.trainMetrics,
      validMetrics:   s.validMetrics,
      sampleSize:     s.sampleSize,
      sampleSizeValid: s.sampleSizeValid,
      status:         s.status,
      expiresAt:      s.expiresAt,
      createdAt:      s.createdAt,
      confidence:     computeConfidence(s.validMetrics),
    }));

    res.json({ ok: true, suggestions });
  }));

  // ── GET /suggestions/:id ───────────────────────────────────────────────────
  router.get("/suggestions/:id", [adminGuard], asyncHandler(async (req, res) => {
    const s = await prisma.parameterSuggestion.findUnique({
      where: { id: req.params.id },
    });

    if (!s) return res.status(404).json({ ok: false, error: "Suggestion not found" });

    // Include ParameterVersion history for this strategy+symbol
    const history = await prisma.parameterVersion.findMany({
      where:   { strategyKey: s.strategyKey, symbol: s.symbol },
      orderBy: { appliedAt: "desc" },
      take:    10,
    });

    res.json({
      ok: true,
      suggestion: { ...s, confidence: computeConfidence(s.validMetrics) },
      history,
    });
  }));

  // ── POST /suggestions/:id/apply ────────────────────────────────────────────
  router.post("/suggestions/:id/apply", [adminGuard], asyncHandler(async (req, res) => {
    const { confirm } = req.body ?? {};
    if (!confirm) {
      return res.status(400).json({ ok: false, error: "confirm=true required" });
    }

    const userId = req.adminUser?.id ?? "unknown";
    const result = await deployService.applyParameters(req.params.id, userId, {
      force: req.body?.force ?? false,
    });

    if (!result.success) {
      return res.status(422).json({ ok: false, error: result.error, metrics: result.metrics });
    }

    res.json({ ok: true, ...result });
  }));

  // ── POST /suggestions/:id/reject ───────────────────────────────────────────
  router.post("/suggestions/:id/reject", [adminGuard], asyncHandler(async (req, res) => {
    const s = await prisma.parameterSuggestion.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ ok: false, error: "Suggestion not found" });
    if (s.status !== "pending") {
      return res.status(422).json({ ok: false, error: `Cannot reject — status is ${s.status}` });
    }

    await prisma.parameterSuggestion.update({
      where: { id: req.params.id },
      data:  { status: "rejected", rejectedAt: new Date() },
    });

    res.json({ ok: true, id: req.params.id, reason: req.body?.reason ?? null });
  }));

  // ── GET /history/:strategyKey/:symbol ──────────────────────────────────────
  router.get("/history/:strategyKey/:symbol", [adminGuard], asyncHandler(async (req, res) => {
    const { strategyKey, symbol } = req.params;
    const limit = Math.min(parseInt(req.query.limit ?? "20", 10), 50);

    const versions = await deployService.getDeployHistory(strategyKey, symbol, limit);
    res.json({ ok: true, strategyKey, symbol, versions });
  }));

  // ── POST /rollback ─────────────────────────────────────────────────────────
  router.post("/rollback", [superAdminGuard], asyncHandler(async (req, res) => {
    const { strategyKey, symbol } = req.body ?? {};
    if (!strategyKey || !symbol) {
      return res.status(400).json({ ok: false, error: "strategyKey and symbol required" });
    }

    const userId = req.adminUser?.id ?? "unknown";
    const result = await deployService.rollback(strategyKey, symbol, userId);

    if (!result.success) {
      return res.status(422).json({ ok: false, error: result.error });
    }

    res.json({ ok: true, ...result });
  }));

  // ── GET /job/status ────────────────────────────────────────────────────────
  router.get("/job/status", [adminGuard], asyncHandler(async (req, res) => {
    // Last suggestion created = proxy for last job run
    const last = await prisma.parameterSuggestion.findFirst({
      orderBy: { createdAt: "desc" },
      select:  { createdAt: true },
    });

    res.json({
      ok: true,
      lastRun:   _jobLastRun ?? last?.createdAt ?? null,
      nextRun:   _jobNextRun,
      isRunning: _jobRunning,
      stats:     _jobStats,
    });
  }));

  // ── POST /job/run ──────────────────────────────────────────────────────────
  router.post("/job/run", [superAdminGuard], asyncHandler(async (req, res) => {
    if (_jobRunning) {
      return res.status(409).json({ ok: false, error: "Walk-forward job is already running" });
    }

    const { dryRun = false } = req.body ?? {};
    _jobRunning = true;
    _jobLastRun = new Date();

    // Fire-and-forget (responds immediately, job runs in background)
    walkForwardJob.run({ dryRun })
      .then(result => {
        _jobStats   = result;
        _jobRunning = false;
        console.log("[parameters/job/run] Walk-forward job completed:", result);
      })
      .catch(err => {
        _jobRunning = false;
        console.error("[parameters/job/run] Walk-forward job error:", err.message);
      });

    res.json({ ok: true, message: `Walk-forward job started${dryRun ? " (dry run)" : ""}` });
  }));

  return router;
};
