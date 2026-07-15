/**
 * metaSelector.js — Sprint 3 / MS-3
 *
 * REST API for MetaSelector recommendations, history, and advisory promotion.
 * Register in app.js as:
 *   app.use('/api/v1/internal/meta-selector', authMiddleware, createMetaSelectorRouter(wss))
 *
 * Feature flag: META_SELECTOR_MODE env var
 *   'shadow'   (default) — engine runs, logs, no external signals
 *   'advisory'           — engine + WS event + Telegram alert per recommendation
 *   'disabled'           — all endpoints return 503
 *
 * Endpoints:
 *   GET  /recommend/:symbol          — get recommendation for symbol
 *   GET  /history/:symbol            — get recommendation history
 *   GET  /status                     — current mode + promotion readiness
 *   POST /promote                    — promote to advisory (SUPER_ADMIN only)
 */

"use strict";

const express = require("express");

const { superAdminGuard } = require("../../../shared/middleware/adminGuard");
const { requireFeature } = require("../../../shared/middleware/subscriptionGuard");
const metaSelector           = require("../../../core/research-engine/MetaSelectorEngine");
const ShadowCollectionService = require("../services/ShadowCollectionService");
const { notifyInfo }         = require("../../../infrastructure/notifications/TelegramNotifier");
const prisma                 = require("../../../infrastructure/db/prismaClient");

// autoSelector is the tier flag for MetaSelector recommend/history (FOUNDRY lacks it).
const requireAutoSelector = requireFeature("autoSelector");

// Sprint 6 / RAG-PROD-1 — lazy-loaded MLShadowService
let _mlShadowService = null;
function getMLShadowService() {
  if (_mlShadowService) return _mlShadowService;
  try {
    const MLShadowService = require("../services/MLShadowService");
    _mlShadowService = MLShadowService.autoStart();
  } catch (err) {
    console.warn("[MetaSelector] MLShadowService unavailable:", err.message);
  }
  return _mlShadowService;
}

// Sprint 5 / RL-6 — lazy-loaded HybridAdvisor
let _hybridAdvisor = null;
function getHybridAdvisor() {
  if (_hybridAdvisor) return _hybridAdvisor;
  try {
    const HybridAdvisor   = require("../domain/HybridAdvisor");
    const WinPredictor    = require("../domain/WinPredictor");
    const FeatureEngineer = require("../domain/FeatureEngineer");
    const wp = new WinPredictor();
    wp.load().catch(() => {}); // load model if exists (async, fire-and-forget)
    _hybridAdvisor = new HybridAdvisor(metaSelector, wp, new FeatureEngineer());
  } catch (err) {
    console.warn("[MetaSelector] HybridAdvisor unavailable:", err.message);
  }
  return _hybridAdvisor;
}

// ── Feature flag ──────────────────────────────────────────────────────────────

function getMode() {
  return process.env.META_SELECTOR_MODE || "shadow";
}

function disabledGuard(req, res, next) {
  if (getMode() === "disabled") {
    return res.status(503).json({ ok: false, error: "MetaSelector is disabled" });
  }
  return next();
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * @param {object|import('ws').WebSocketServer} [wssOrRef] — WebSocket server or
 *   lazy ref object { current: WebSocketServer } for advisory events
 */
module.exports = function createMetaSelectorRouter(wssOrRef = null) {
  function getWss() {
    if (!wssOrRef) return null;
    if (wssOrRef.current !== undefined) return wssOrRef.current; // lazy ref
    return wssOrRef; // direct wss
  }
  const router = express.Router();

  router.use(disabledGuard);

  // ── GET /recommend/:symbol ────────────────────────────────────────────────

  router.get("/recommend/:symbol", requireAutoSelector, async (req, res) => {
    try {
      const symbol   = req.params.symbol.toUpperCase();
      const { strategies } = req.query;

      // Parse available strategies from query param or fallback to common list
      const availableStrategies = strategies
        ? String(strategies).split(",").map(s => s.trim()).filter(Boolean)
        : ["SMART_MONEY_CONCEPTS", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];

      // Indicators can be passed as JSON body or query params; default to empty (engine will use defaults)
      const indicators = req.body?.indicators || {};

      const result = await metaSelector.recommend(symbol, indicators, availableStrategies);

      // Advisory mode: emit WS event + Telegram
      if (getMode() === "advisory" && result.recommendations.length > 0) {
        const top = result.recommendations[0];
        _emitAdvisoryEvent(getWss(), symbol, result);
        notifyInfo(
          `[Advisory] Strategi ${top.strategyKey} direkomendasikan untuk ${symbol} (${result.regime}) — Score: ${top.score}`
        ).catch(() => {});
      }

      return res.json({
        ok: true,
        symbol,
        regime:          result.regime,
        confidence:      result.confidence,
        recommendations: result.recommendations,
        insufficientData: result.insufficientData,
        mode:            result.mode,
        timestamp:       result.timestamp,
      });
    } catch (err) {
      console.error("[MetaSelector] recommend error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /history/:symbol ──────────────────────────────────────────────────

  router.get("/history/:symbol", requireAutoSelector, async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const limit  = Math.min(parseInt(req.query.limit || "50", 10), 200);
      const recs   = await metaSelector.getRecommendationHistory(symbol, limit);
      return res.json({ ok: true, symbol, recommendations: recs });
    } catch (err) {
      console.error("[MetaSelector] history error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /status ───────────────────────────────────────────────────────────

  router.get("/status", async (req, res) => {
    try {
      const promotion = await ShadowCollectionService.checkPromotionReadiness();
      return res.json({
        ok:             true,
        mode:           getMode(),
        engineMode:     metaSelector.getMode(),
        promotionReady: promotion.ready,
        tradeCount:     promotion.tradeCount,
        sharpeDiff:     promotion.sharpeDiff,
        reason:         promotion.reason,
        confidence:     promotion.confidence,
      });
    } catch (err) {
      console.error("[MetaSelector] status error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /promote (SUPER_ADMIN only) ─────────────────────────────────────

  router.post("/promote", superAdminGuard, async (req, res) => {
    try {
      const { confirm } = req.body || {};
      if (confirm !== true) {
        return res.status(400).json({ ok: false, error: "confirm: true required in body" });
      }

      const promotion = await ShadowCollectionService.checkPromotionReadiness();
      if (!promotion.ready) {
        return res.status(409).json({
          ok:     false,
          error:  `Not ready for promotion: ${promotion.reason}`,
          promotion,
        });
      }

      // Update runtime env + engine mode
      process.env.META_SELECTOR_MODE = "advisory";
      metaSelector.setMode("advisory");

      // Persist mode to DB flag (SystemConfig table if exists, else log only)
      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "SystemConfig" (key, value, "updatedAt")
           VALUES ('META_SELECTOR_MODE', 'advisory', NOW())
           ON CONFLICT (key) DO UPDATE SET value = 'advisory', "updatedAt" = NOW()`
        );
      } catch {
        // SystemConfig table may not exist — mode is held in process.env for this process lifetime
      }

      await notifyInfo(
        `[MetaSelector] Promoted to ADVISORY mode by admin. ` +
        `Trades: ${promotion.tradeCount}, Sharpe diff: +${(promotion.sharpeDiff || 0).toFixed(3)}`
      );

      return res.json({
        ok:      true,
        message: "MetaSelector promoted to advisory mode",
        promotion,
      });
    } catch (err) {
      console.error("[MetaSelector] promote error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /hybrid-status (RL-6) ─────────────────────────────────────────────

  router.get("/hybrid-status", async (req, res) => {
    try {
      const hybrid = getHybridAdvisor();
      if (!hybrid) {
        return res.json({ ok: true, mode: "shadow", weights: { rl3: 0, ms1: 1 }, rl3ModelVersion: null, lastTrainedAt: null, promotionReady: false });
      }
      const status = await hybrid.getStatus();
      return res.json({ ok: true, ...status });
    } catch (err) {
      console.error("[MetaSelector] hybrid-status error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /set-rl3-weight (SUPER_ADMIN, RL-6) ─────────────────────────────

  router.post("/set-rl3-weight", superAdminGuard, async (req, res) => {
    try {
      const { weight } = req.body || {};
      const w = parseFloat(weight);
      if (!Number.isFinite(w) || w < 0 || w > 1) {
        return res.status(400).json({ ok: false, error: "weight must be 0.0-1.0" });
      }

      const hybrid = getHybridAdvisor();
      if (!hybrid) {
        return res.status(503).json({ ok: false, error: "HybridAdvisor not available" });
      }

      hybrid.setWeights(w);
      process.env.WEIGHT_RL3 = String(w);

      return res.json({ ok: true, message: `WEIGHT_RL3 set to ${w}`, weights: hybrid.getWeights() });
    } catch (err) {
      console.error("[MetaSelector] set-rl3-weight error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /rag/readiness (Sprint 6 / RAG-PROD-1) ───────────────────────────
  /**
   * Return Sprint 6 RAG readiness thresholds check.
   * AUC >= 0.65, Accuracy >= 50%, Precision >= 55%, TradeCount >= 1000.
   */
  router.get("/rag/readiness", async (req, res) => {
    try {
      const svc = getMLShadowService();
      if (!svc) {
        return res.json({
          ok: true,
          ready: false,
          failures: ["MLShadowService not available"],
          auc: 0, accuracy: 0, precision: 0, tradeCount: 0,
        });
      }
      const readiness = await svc.checkReadinessThresholds();
      return res.json({ ok: true, ...readiness });
    } catch (err) {
      console.error("[MetaSelector] rag/readiness error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /rag/promote (SUPER_ADMIN, Sprint 6 / RAG-PROD-1) ───────────────
  /**
   * Promote RAG from shadow to advisory mode.
   * Requires: checkReadinessThresholds() to pass.
   * Sets RAG_MODE=advisory in memory and logs to AuditLog.
   */
  router.post("/rag/promote", superAdminGuard, async (req, res) => {
    try {
      const { confirm } = req.body || {};
      if (confirm !== true) {
        return res.status(400).json({ ok: false, error: "confirm: true required in body" });
      }

      const svc = getMLShadowService();
      if (!svc) {
        return res.status(503).json({ ok: false, error: "MLShadowService not available" });
      }

      // Check readiness thresholds
      const readiness = await svc.checkReadinessThresholds();
      if (!readiness.ready) {
        return res.status(409).json({
          ok:       false,
          error:    `RAG not ready for promotion: ${readiness.failures.join(", ")}`,
          readiness,
        });
      }

      // Promote to advisory
      process.env.RAG_MODE = "advisory";

      // Log to AuditLog (best-effort — table may not exist)
      const user     = req.user || req.adminUser;
      const userId   = user?.id ?? user?.userId ?? null;
      const username = user?.username ?? user?.email ?? "unknown";

      try {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "AuditLog" (action, entity, "entityId", "userId", metadata, "createdAt")
           VALUES ('RAG_PROMOTE', 'RAG_MODE', 'advisory', $1::text::uuid, $2::jsonb, NOW())`,
          userId,
          JSON.stringify({ from: "shadow", to: "advisory", triggeredBy: username, readiness })
        );
      } catch {
        // AuditLog table may not exist — log to console as fallback
        console.log(`[MetaSelector] RAG promoted to advisory by ${username} (no AuditLog table)`);
      }

      await notifyInfo(
        `[RAG Advisory] RAG mode promoted to ADVISORY by ${username}. ` +
        `AUC=${readiness.auc.toFixed(3)}, Accuracy=${(readiness.accuracy * 100).toFixed(1)}%, ` +
        `Precision=${(readiness.precision * 100).toFixed(1)}%, Trades=${readiness.tradeCount}`
      ).catch(() => {});

      return res.json({
        ok:       true,
        message:  "RAG promoted to advisory mode",
        ragMode:  "advisory",
        readiness,
      });
    } catch (err) {
      console.error("[MetaSelector] rag/promote error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /rag/revert (SUPER_ADMIN, Sprint 6 / RAG-PROD-1) ────────────────
  /**
   * Revert RAG from advisory back to shadow mode.
   * Instant revert — no readiness check required.
   */
  router.post("/rag/revert", superAdminGuard, async (req, res) => {
    try {
      const previousMode = process.env.RAG_MODE || "shadow";
      process.env.RAG_MODE = "shadow";

      const user     = req.user || req.adminUser;
      const username = user?.username ?? user?.email ?? "unknown";

      try {
        const userId = user?.id ?? user?.userId ?? null;
        await prisma.$executeRawUnsafe(
          `INSERT INTO "AuditLog" (action, entity, "entityId", "userId", metadata, "createdAt")
           VALUES ('RAG_REVERT', 'RAG_MODE', 'shadow', $1::text::uuid, $2::jsonb, NOW())`,
          userId,
          JSON.stringify({ from: previousMode, to: "shadow", triggeredBy: username })
        );
      } catch {
        console.log(`[MetaSelector] RAG reverted to shadow by ${username} (no AuditLog table)`);
      }

      await notifyInfo(
        `[RAG Advisory] RAG mode REVERTED to shadow by ${username}. Previous mode: ${previousMode}.`
      ).catch(() => {});

      return res.json({
        ok:          true,
        message:     "RAG reverted to shadow mode",
        ragMode:     "shadow",
        previousMode,
      });
    } catch (err) {
      console.error("[MetaSelector] rag/revert error:", err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _emitAdvisoryEvent(wss, symbol, result) {
  if (!wss) return;
  const payload = JSON.stringify({
    type:    "meta_selector_recommendation",
    symbol,
    regime:          result.regime,
    confidence:      result.confidence,
    recommendations: result.recommendations,
    mode:            result.mode,
    timestamp:       result.timestamp,
  });
  wss.clients?.forEach(client => {
    if (client.readyState === 1 /* OPEN */) {
      try { client.send(payload); } catch { /* ignore */ }
    }
  });
}
