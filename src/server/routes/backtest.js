/**
 * Backtest Routes
 * Provides endpoints for accessing backtest metrics, equity curves, and trade data
 */

const express = require("express");
const { asyncHandler } = require("../../infrastructure/middleware/errorHandler");
const BacktestLoader = require("../services/BacktestLoader");
const BacktestHistoryService = require("../services/BacktestHistoryService");

module.exports = function createBacktestRouter(context) {
  const router = express.Router();
  const { SYMBOLS_LIST } = context;

  /**
   * GET /api/v1/backtest/metrics
   * Get all latest backtest metrics for all symbols
   */
  router.get("/metrics", asyncHandler(async (req, res) => {
    const metrics = await BacktestLoader.getAllMetrics(SYMBOLS_LIST);
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      metrics,
    });
  }));

  /**
   * GET /api/v1/backtest/:symbol/summary
   * Get latest backtest summary for a symbol
   */
  router.get("/:symbol/summary", asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const summary = await BacktestLoader.loadSummary(symbol);

    if (!summary) {
      return res.status(404).json({
        ok: false,
        error: `No backtest data found for ${symbol}`,
      });
    }

    res.json({
      ok: true,
      symbol,
      ...summary,
    });
  }));

  /**
   * GET /api/v1/backtest/:symbol/equity
   * Get latest equity curve for a symbol
   */
  router.get("/:symbol/equity", asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const equity = await BacktestLoader.loadEquityCurve(symbol);

    if (!equity || equity.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `No equity curve data found for ${symbol}`,
      });
    }

    res.json({
      ok: true,
      symbol,
      dataPoints: equity.length,
      data: equity,
    });
  }));

  /**
   * GET /api/v1/backtest/:symbol/trades
   * Get latest trades for a symbol with pagination
   */
  router.get("/:symbol/trades", asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const pageLimit = Math.min(parseInt(limit) || 50, 200);
    const pageOffset = parseInt(offset) || 0;

    const trades = await BacktestLoader.loadTrades(symbol);

    if (!trades || trades.length === 0) {
      return res.status(404).json({
        ok: false,
        error: `No trade data found for ${symbol}`,
      });
    }

    const paginated = trades.slice(pageOffset, pageOffset + pageLimit);

    res.json({
      ok: true,
      symbol,
      total: trades.length,
      limit: pageLimit,
      offset: pageOffset,
      returned: paginated.length,
      data: paginated,
    });
  }));

  /**
   * POST /api/v1/backtest/refresh
   * Refresh backtest cache (clear all cached data)
   */
  router.post("/refresh", asyncHandler(async (req, res) => {
    const { symbol } = req.body;

    if (symbol) {
      BacktestLoader.clearCache(symbol);
      res.json({
        ok: true,
        message: `Backtest cache cleared for ${symbol}`,
      });
    } else {
      BacktestLoader.clearCache();
      res.json({
        ok: true,
        message: "Backtest cache cleared for all symbols",
      });
    }
  }));

  /**
   * GET /api/v1/backtest/health
   * Check backtest data availability
   */
  router.get("/health", asyncHandler(async (req, res) => {
    const health = {};

    for (const symbol of SYMBOLS_LIST) {
      const summary = await BacktestLoader.loadSummary(symbol);
      health[symbol] = {
        hasData: !!summary,
        lastGenerated: summary?.timestamp_generated || null,
      };
    }

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      health,
    });
  }));

  /**
   * POST /api/v1/backtest/save
   * Save backtest result to history database
   */
  router.post("/save", asyncHandler(async (req, res) => {
    const { symbol, metrics, equityCurve, tradesData, config, notes } = req.body;

    if (!symbol || !metrics) {
      return res.status(400).json({
        ok: false,
        error: "symbol and metrics are required",
      });
    }

    const id = BacktestHistoryService.saveBacktest(
      symbol,
      metrics,
      equityCurve,
      tradesData,
      config,
      notes
    );

    res.json({
      ok: true,
      id,
      message: `Backtest result saved for ${symbol}`,
    });
  }));

  /**
   * GET /api/v1/backtest/history
   * Get backtest history (with optional symbol filter)
   * Query params: symbol (optional), limit (optional, default 20)
   */
  router.get("/history", asyncHandler(async (req, res) => {
    const { symbol, limit = 20 } = req.query;
    const pageLimit = Math.min(parseInt(limit) || 20, 100);

    let data;
    if (symbol) {
      data = BacktestHistoryService.getHistory(symbol, pageLimit);
    } else {
      data = BacktestHistoryService.getAllHistory(pageLimit);
    }

    res.json({
      ok: true,
      symbol: symbol || "all",
      count: data.length,
      data,
    });
  }));

  /**
   * GET /api/v1/backtest/history/:id
   * Get specific backtest by ID
   */
  router.get("/history/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const record = BacktestHistoryService.getById(parseInt(id));

    if (!record) {
      return res.status(404).json({
        ok: false,
        error: `Backtest history with ID ${id} not found`,
      });
    }

    res.json({
      ok: true,
      data: record,
    });
  }));

  /**
   * GET /api/v1/backtest/history/:symbol/statistics
   * Get statistics for backtest history of a symbol
   */
  router.get("/history/:symbol/statistics", asyncHandler(async (req, res) => {
    const { symbol } = req.params;
    const stats = BacktestHistoryService.getStatistics(symbol);

    res.json({
      ok: true,
      statistics: stats,
    });
  }));

  /**
   * GET /api/v1/backtest/history/compare/:id1/:id2
   * Compare two backtest results
   */
  router.get("/history/compare/:id1/:id2", asyncHandler(async (req, res) => {
    const { id1, id2 } = req.params;

    const comparison = BacktestHistoryService.compareBacktests(parseInt(id1), parseInt(id2));

    res.json({
      ok: true,
      comparison,
    });
  }));

  return router;
};
