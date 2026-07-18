"use strict";

/**
 * researchDataset.js — Sprint 16 Research Dataset SSOT API.
 *
 * Mount: /api/v1/internal/research-dataset (auth required)
 */

const express = require("express");
const { superAdminGuard } = require("../../../shared/middleware/adminGuard");
const { ResearchDatasetService } = require("../services/ResearchDatasetService");
const { ResearchDatasetValidator } = require("../services/ResearchDatasetValidator");

const service = new ResearchDatasetService();
const validator = new ResearchDatasetValidator();

function createResearchDatasetRouter() {
  const router = express.Router();

  /** GET /summary — dataset counts + avg score */
  router.get("/summary", async (req, res, next) => {
    try {
      const { strategyKey } = req.query;
      res.json(await service.getSummary({ strategyKey }));
    } catch (err) { next(err); }
  });

  /** GET /quality — data completeness report */
  router.get("/quality", async (req, res, next) => {
    try {
      res.json(await service.getDataQualityReport());
    } catch (err) { next(err); }
  });

  /** GET /validation — predictive monotonicity + IC report */
  router.get("/validation", async (req, res, next) => {
    try {
      const strategyKey = req.query.strategyKey || "SMART_MONEY_CONCEPTS";
      res.json(await validator.runPredictiveValidation({ strategyKey }));
    } catch (err) { next(err); }
  });

  /** GET /trades — filtered query */
  router.get("/trades", async (req, res, next) => {
    try {
      const {
        strategyKey, symbol, result, minScore, maxScore, migrationBatch, limit, offset,
      } = req.query;
      res.json(await service.queryTrades({
        strategyKey,
        symbol,
        result,
        minScore: minScore != null ? Number(minScore) : undefined,
        maxScore: maxScore != null ? Number(maxScore) : undefined,
        migrationBatch,
        limit: limit != null ? Number(limit) : 100,
        offset: offset != null ? Number(offset) : 0,
      }));
    } catch (err) { next(err); }
  });

  /** GET /trades/by-tier/:tier — EPIC Graded Scoring helper (low|mid|high) */
  router.get("/trades/by-tier/:tier", async (req, res, next) => {
    try {
      const { tier } = req.params;
      const { strategyKey, limit, offset } = req.query;
      res.json(await service.getTradesByScoreTier({
        tier,
        strategyKey,
        limit: limit != null ? Number(limit) : 100,
        offset: offset != null ? Number(offset) : 0,
      }));
    } catch (err) { next(err); }
  });

  /** POST /migrate — SUPER_ADMIN: seed from XLSX/CSV paths */
  router.post("/migrate", superAdminGuard, async (req, res, next) => {
    try {
      const { files, dryRun } = req.body || {};
      const result = await service.migrateFromFiles(
        Array.isArray(files) && files.length ? files : undefined,
        { dryRun: Boolean(dryRun) },
      );
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = createResearchDatasetRouter;
