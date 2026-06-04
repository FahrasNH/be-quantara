/**
 * Health Check Routes
 * Provides monitoring endpoints for system health, database, and bot status
 */

const express = require("express");
const { asyncHandler } = require("../../infrastructure/middleware/errorHandler");

module.exports = function createHealthRouter(context) {
  const router = express.Router();
  const { bots, sharedClient, SYMBOLS_LIST, healthChecker, db } = context;

  /**
   * GET /api/v1/health
   * Comprehensive system health status
   */
  router.get("/", asyncHandler(async (req, res) => {
    const runningBots = [...bots.entries()]
      .filter(([, bot]) => bot.getState().running)
      .map(([sym]) => sym);

    const botsStatus = [];
    for (const [symbol, bot] of bots) {
      const botState = bot.getState();
      if (healthChecker) {
        healthChecker.updateBotStatus(symbol, botState);
      }
      botsStatus.push({
        symbol,
        running: botState.running,
        capital: botState.capital,
        totalTrades: botState.totalTrades,
        winRate: botState.winRate,
        openPositions: botState.openPositions.length,
        errors: botState.errors,
        lastTick: botState.lastTick,
      });
    }

    // Get database health
    let dbHealthy = false;
    let dbLatency = 0;
    try {
      const start = Date.now();
      const count = db.getSetting("__health_check__"); // Dummy query
      dbLatency = Date.now() - start;
      dbHealthy = true;
      if (healthChecker) healthChecker.setDatabaseHealth(true, dbLatency);
    } catch (err) {
      dbHealthy = false;
      if (healthChecker) healthChecker.setDatabaseHealth(false, 0);
    }

    // Get exchange health
    let exchangeHealthy = false;
    let exchangeLatency = 0;
    try {
      const start = Date.now();
      await sharedClient.getPrice(SYMBOLS_LIST[0] || "BTCUSDT");
      exchangeLatency = Date.now() - start;
      exchangeHealthy = true;
      if (healthChecker) healthChecker.setExchangeHealth(true, exchangeLatency);
    } catch (err) {
      exchangeHealthy = false;
      if (healthChecker) healthChecker.setExchangeHealth(false, 0);
    }

    const health = healthChecker ? healthChecker.getStatus() : null;

    const response = {
      ok: true,
      timestamp: new Date().toISOString(),
      version: "2.0.0",
      uptime: `${Math.floor(process.uptime())}s`,
      environment: process.env.NODE_ENV || "development",
      mode: process.env.DRY_RUN !== "false" ? "dry_run" : "live",

      // System
      system: {
        node: process.version,
        platform: process.platform,
        pid: process.pid,
        memory: {
          heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
        },
      },

      // API
      api: {
        status: "operational",
        port: process.env.PORT || 3000,
        wsConnected: context.wss?.clients?.size || 0,
      },

      // Bots
      bots: {
        total: SYMBOLS_LIST.length,
        running: runningBots.length,
        symbols: botsStatus,
      },

      // Dependencies
      dependencies: {
        database: {
          healthy: dbHealthy,
          latency: `${dbLatency}ms`,
        },
        exchange: {
          healthy: exchangeHealthy,
          latency: `${exchangeLatency}ms`,
        },
      },

      // Overall status
      overall: {
        healthy: dbHealthy && exchangeHealthy,
        status: (dbHealthy && exchangeHealthy) ? "operational" : "degraded",
        alerts: health?.alerts?.length || 0,
      },

      // Health checker data (if available)
      ...(health && { healthMetrics: health }),
    };

    res.json(response);
  }));

  /**
   * GET /api/v1/health/detailed
   * Detailed health metrics including performance data
   */
  router.get("/detailed", asyncHandler(async (req, res) => {
    if (!healthChecker) {
      return res.status(503).json({
        ok: false,
        message: "Health checker not initialized",
      });
    }

    const health = healthChecker.getStatus();
    res.json(health);
  }));

  /**
   * GET /api/v1/health/bots/:symbol
   * Health status of a specific bot
   */
  router.get("/bots/:symbol", asyncHandler(async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const bot = [...bots.entries()].find(([sym]) => sym === symbol)?.[1];

    if (!bot) {
      return res.status(404).json({
        ok: false,
        error: "BOT_NOT_FOUND",
        message: `No bot found for symbol ${symbol}`,
      });
    }

    const state = bot.getState();
    const logs = bot.getLogs(50);

    res.json({
      ok: true,
      bot: {
        symbol,
        running: state.running,
        capital: state.capital,
        totalTrades: state.totalTrades,
        openPositions: state.openPositions.length,
        errors: state.errors,
        checkCount: state.checkCount,
        lastTick: state.lastTick,
        riskState: state.riskState,
        recentLogs: logs,
      },
    });
  }));

  /**
   * GET /api/v1/health/ready
   * Kubernetes-style readiness probe
   */
  router.get("/ready", asyncHandler(async (req, res) => {
    const ready = [...bots.entries()].some(([, bot]) => bot.getState().running);
    const status = ready ? 200 : 503;
    res.status(status).json({
      ok: ready,
      message: ready ? "System is ready" : "No bots running",
    });
  }));

  /**
   * GET /api/v1/health/live
   * Kubernetes-style liveness probe
   */
  router.get("/live", (req, res) => {
    res.status(200).json({ ok: true, message: "Process is alive" });
  });

  return router;
};
