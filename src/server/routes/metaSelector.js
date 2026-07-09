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

const metaSelector           = require("../../domain/MetaSelectorEngine");
const ShadowCollectionService = require("../services/ShadowCollectionService");
const { notifyInfo }         = require("../../infrastructure/notifications/TelegramNotifier");
const prisma                 = require("../../infrastructure/db/prismaClient");

// Sprint 5 / RL-6 — lazy-loaded HybridAdvisor
let _hybridAdvisor = null;
function getHybridAdvisor() {
  if (_hybridAdvisor) return _hybridAdvisor;
  try {
    const HybridAdvisor   = require("../../domain/HybridAdvisor");
    const WinPredictor    = require("../../domain/WinPredictor");
    const FeatureEngineer = require("../../domain/FeatureEngineer");
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

// ── Guards ────────────────────────────────────────────────────────────────────

function superAdminGuard(req, res, next) {
  const user = req.user || req.adminUser || null;
  const role = user?.role ?? req._role ?? "";
  if (role !== "SUPER_ADMIN") {
    return res.status(403).json({ ok: false, error: "SUPER_ADMIN role required" });
  }
  return next();
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

  router.get("/recommend/:symbol", async (req, res) => {
    try {
      const symbol   = req.params.symbol.toUpperCase();
      const { strategies } = req.query;

      // Parse available strategies from query param or fallback to common list
      const availableStrategies = strategies
        ? String(strategies).split(",").map(s => s.trim()).filter(Boolean)
        : ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];

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

  router.get("/history/:symbol", async (req, res) => {
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
