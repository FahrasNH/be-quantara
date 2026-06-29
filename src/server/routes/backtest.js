/**
 * Backtest Routes
 * Provides endpoints for accessing backtest metrics, equity curves, and trade data
 */

const express = require("express");
const { asyncHandler } = require("../../middleware/errorHandler");
const BacktestLoader = require("../services/BacktestLoader");
const BacktestHistoryService = require("../services/BacktestHistoryService");
const BacktestCsvService = require("../services/BacktestCsvService");
const HistoricalKlinesService = require("../services/HistoricalKlinesService");
const ReportGeneratorService = require("../services/ReportGeneratorService");
const OptimizationAnalysisService = require("../services/OptimizationAnalysisService");
const db = require("../../infrastructure/db/database");
const { simulateTrade, applyTradingCosts } = require("../../../scripts/lib/simulator");
const { STRATEGIES } = require("../../domain/legacyStrategies");
const { runRealBacktest } = require("../services/RealStrategyBacktestService");
const GrokConfirmService = require("../services/GrokConfirmService");
const GrokConfirmBatchProcessor = require("../services/GrokConfirmBatchProcessor");
const GrokBacktestJobService = require("../services/GrokBacktestJobService");
const cfg = require("../../config/env");

const USER_STRATEGY_KEYS = ["ADAPTIVE_FUSION", "TREND_MOMENTUM", "MEAN_REVERSION", "BREAKOUT_RETEST"];
const GROK_CONFIRM_STRATEGIES = new Set(USER_STRATEGY_KEYS);
const GROK_CONFIRM_MAX_SIGNALS = 500;

function validateGrokConfirmPayload(body) {
  const {
    strategy_key: strategyKeyRaw,
    symbol,
    signals = [],
    tpAdjust = true,
    tpBandPct,
    tpRejectAction,
  } = body ?? {};

  const strategyKey = String(strategyKeyRaw || "").toUpperCase();
  if (!GROK_CONFIRM_STRATEGIES.has(strategyKey)) {
    return {
      error: {
        status: 400,
        message: "Grok Confirm Gate hanya untuk ADAPTIVE_FUSION, TREND_MOMENTUM, MEAN_REVERSION, BREAKOUT_RETEST",
      },
    };
  }
  if (!Array.isArray(signals)) {
    return { error: { status: 400, message: "signals harus berupa array" } };
  }
  if (!signals.length) {
    return {
      ok: true,
      empty: true,
      strategyKey,
      symbol,
      signals,
      tpAdjust,
      tpBandPct,
      tpRejectAction,
    };
  }
  if (signals.length > GROK_CONFIRM_MAX_SIGNALS) {
    return {
      error: {
        status: 400,
        message: `Maksimal ${GROK_CONFIRM_MAX_SIGNALS} sinyal per request backtest`,
      },
    };
  }

  return {
    ok: true,
    empty: false,
    strategyKey,
    symbol,
    signals,
    tpAdjust,
    tpBandPct,
    tpRejectAction,
  };
}
const STRATEGY_ABBREV = {
  ADAPTIVE_FUSION: "AF",
  TREND_MOMENTUM: "TM",
  MEAN_REVERSION: "MR",
  BREAKOUT_RETEST: "BR",
};

function buildStrategyList() {
  return USER_STRATEGY_KEYS.map(key => {
    const s = STRATEGIES[key];
    return {
      id: key,
      key,
      abbrev: STRATEGY_ABBREV[key],
      name: s.label,
      label: s.label,
      description: s.description,
      type: "builtin",
      interval: s.interval,
      defaults: {
        emaFast: s.emaFast,
        emaSlow: s.emaSlow,
        rsiPeriod: s.rsiPeriod,
        rsiOB: s.rsiOverbought,
        atrMult: s.atrMultiplier,
        riskReward: s.riskReward,
        riskPerTrade: s.riskPerTrade,
        capital: 500,
        bbPeriod: 20,
        bbStdDev: 2,
        rsiOversold: s.rsiOversold,
        rsiOverbought: s.rsiOverbought,
        rangeLookback: s.sidewaysRangeLookback || 20,
        afMinVotes: s.afMinVotes || 3,
      },
    };
  });
}

function normalizeMetrics(stats) {
  return {
    totalReturn: stats.totalReturn,
    grossReturn: stats.grossReturn,
    winRate: stats.winRate,
    maxDrawdown: stats.maxDrawdown,
    profitFactor: stats.profitFactor,
    sharpe: stats.sharpe,
    totalTrades: stats.totalTrades,
    finalCapital: stats.finalCapital,
    totalFees: stats.totalFees,
    wins: stats.wins,
    losses: stats.losses,
    riskReward: stats.riskReward,
    roi_pct: parseFloat(stats.totalReturn) || 0,
    win_rate_pct: parseFloat(stats.winRate) || 0,
    max_drawdown_pct: parseFloat(stats.maxDrawdown) || 0,
    profit_factor: parseFloat(stats.profitFactor) || 0,
  };
}

/** Phase 3 — simplified server-side backtest using shared simulator.js */
function runSimpleServerBacktest(candles, strategyKey, parameters = {}, options = {}) {
  const strat = STRATEGIES[strategyKey] || STRATEGIES.MEAN_REVERSION;
  const atrMult = (parameters.atrMult ?? strat.atrMultiplier ?? 1.4) * (parameters.slMultiplier ?? 1);
  const riskReward = parameters.riskReward ?? strat.riskReward ?? 2;
  const capital0 = parameters.capital ?? 500;
  const riskPerTrade = parameters.riskPerTrade ?? strat.riskPerTrade ?? 0.01;
  const feeRate = options.enableFees === false ? 0 : 0.0006;
  const slippageRate = options.enableSlippage ? 0.0005 : 0;

  let capital = capital0;
  const trades = [];
  const equity = [{ date: candles[0]?.date, value: capital }];

  for (let i = 30; i < candles.length - 5; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const atr = Math.max(c.high - c.low, (c.close - prev.close) ** 2) * 0.5 || c.close * 0.01;
    const side = c.close > prev.close ? "LONG" : "SHORT";
    const slDist = atr * atrMult;
    const entry = c.close;
    const sl = side === "LONG" ? entry - slDist : entry + slDist;
    const tp = side === "LONG" ? entry + slDist * riskReward : entry - slDist * riskReward;
    const risk = capital * riskPerTrade;
    const size = risk / slDist;

    const raw = simulateTrade(candles.slice(i), 0, side, { stopLoss: sl, takeProfit: tp });
    const t = applyTradingCosts(raw, { feeRate, slippageRate });
    const pnl = t.pnl * size;
    capital += pnl;
    trades.push({
      date: candles[Math.min(i + raw.exitBar, candles.length - 1)]?.date,
      side,
      entry,
      exit: t.exit,
      pnl,
      reason: t.reason,
    });
    equity.push({ date: candles[i].date, value: Math.round(capital * 100) / 100 });
    i += Math.max(1, raw.exitBar);
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const stats = {
    totalTrades: trades.length,
    winRate: trades.length ? ((wins / trades.length) * 100).toFixed(1) : "0.0",
    totalReturn: (((capital - capital0) / capital0) * 100).toFixed(2),
    finalCapital: capital.toFixed(2),
    wins,
    losses: trades.length - wins,
  };

  return { trades, equity, stats, strategyKey, parameters };
}

module.exports = function createBacktestRouter(context) {
  const router = express.Router();
  const { SYMBOLS_LIST } = context;

  /**
   * GET /api/v1/backtest/strategies
   * Daftar strategi user (4 built-in + preset custom)
   */
  router.get("/strategies", asyncHandler(async (req, res) => {
    const builtins = buildStrategyList();
    let presets = [];
    if (req.userId) {
      presets = (await BacktestHistoryService.getPresets(req.userId)).map(p => ({
        id: `preset-${p.id}`,
        key: p.strategyKey,
        name: p.name,
        label: p.name,
        type: "custom",
        parameters: p.parameters,
        presetId: p.id,
      }));
    }
    res.json({ ok: true, strategies: [...builtins, ...presets] });
  }));

  /**
   * POST /api/v1/backtest/strategies/import
   * Parse JSON parameter import
   */
  router.post("/strategies/import", asyncHandler(async (req, res) => {
    const { json, yaml, name, strategyKey = "ADAPTIVE_FUSION" } = req.body;
    let parsed = null;
    if (json) {
      try {
        parsed = typeof json === "string" ? JSON.parse(json) : json;
      } catch {
        return res.status(400).json({ ok: false, error: "JSON tidak valid" });
      }
    } else if (yaml && typeof yaml === "string") {
      parsed = {};
      for (const line of yaml.split("\n")) {
        const m = line.match(/^(\w+)\s*:\s*(.+)$/);
        if (m) parsed[m[1]] = Number.isNaN(Number(m[2])) ? m[2].trim() : Number(m[2]);
      }
    } else {
      return res.status(400).json({ ok: false, error: "json atau yaml diperlukan" });
    }
    const suggestedName = name || `Import ${strategyKey} ${new Date().toISOString().slice(0, 10)}`;
    res.json({
      ok: true,
      strategy: {
        id: `import-${Date.now()}`,
        key: strategyKey.toUpperCase(),
        name: suggestedName,
        label: suggestedName,
        type: "imported",
        parameters: parsed,
      },
      suggestedName,
      parameters: parsed,
    });
  }));

  /**
   * POST /api/v1/backtest/strategies/presets
   * Simpan preset parameter custom
   */
  router.post("/strategies/presets", asyncHandler(async (req, res) => {
    const { name, strategyKey, parameters } = req.body;
    if (!name || !strategyKey || !parameters) {
      return res.status(400).json({ ok: false, error: "name, strategyKey, parameters diperlukan" });
    }
    const preset = await BacktestHistoryService.savePreset(req.userId, name, strategyKey, parameters);
    res.json({ ok: true, preset });
  }));

  /**
   * DELETE /api/v1/backtest/strategies/presets/:id
   * Hapus preset milik user yang login
   */
  router.delete("/strategies/presets/:id", asyncHandler(async (req, res) => {
    const presetId = parseInt(req.params.id, 10);
    if (!Number.isFinite(presetId) || presetId <= 0) {
      return res.status(400).json({ ok: false, error: "ID preset tidak valid" });
    }
    const deleted = await BacktestHistoryService.deletePreset(req.userId, presetId);
    if (!deleted) {
      return res.status(404).json({ ok: false, error: "Preset tidak ditemukan" });
    }
    res.json({ ok: true });
  }));

  /**
   * GET /api/v1/backtest/data-source
   * Status exchange terhubung untuk backtest real
   */
  router.get("/data-source", asyncHandler(async (req, res) => {
    const status = await HistoricalKlinesService.getDataSourceStatus(req.userId);
    res.json(status);
  }));

  /**
   * GET /api/v1/backtest/klines
   * OHLCV historis real dari exchange user
   * Query: symbol, timeframe, start, end, periodId, customStart, customEnd, autoListing
   */
  router.get("/klines", asyncHandler(async (req, res) => {
    const {
      symbol,
      timeframe = "1d",
      start,
      end,
      periodId,
      customStart,
      customEnd,
      autoListing,
    } = req.query;

    const result = await HistoricalKlinesService.fetchHistoricalKlines(req.userId, {
      symbol,
      timeframe,
      start,
      end,
      periodId,
      customStart,
      customEnd,
      autoListing: autoListing === "1" || autoListing === "true",
    });

    res.json({
      ok: true,
      exchange: result.exchange,
      exchangeLabel: result.exchangeLabel,
      symbol: result.symbol,
      timeframe: result.timeframe,
      startDate: result.startDate,
      endDate: result.endDate,
      listingDate: result.listingDate,
      bars: result.bars,
      estimatedBars: result.estimatedBars,
      maxBars: result.maxBars,
      rangeClamped: result.rangeClamped,
      gapsFilled: result.gapsFilled,
      cached: result.cached,
      source: result.source,
      candles: result.candles,
    });
  }));

  /**
   * GET /api/v1/backtest/lookup
   * Cek arsip canonical shared — miss|reused|subset|extend
   */
  router.get("/lookup", asyncHandler(async (req, res) => {
    const {
      symbol,
      strategy_key: strategyKeyRaw,
      timeframe = "1d",
      parameters: parametersRaw,
      enableFees,
      enableSlippage,
      exchange,
      dataSource,
      period_label: periodLabel = "500",
      requested_start: requestedStart,
      requested_end: requestedEnd,
    } = req.query;

    const sym = String(symbol || "").toUpperCase();
    const strategyKey = String(strategyKeyRaw || "").toUpperCase();
    if (!sym || !strategyKey) {
      return res.status(400).json({ ok: false, error: "symbol dan strategy_key diperlukan" });
    }

    let parameters = {};
    if (parametersRaw) {
      try {
        parameters = typeof parametersRaw === "string" ? JSON.parse(parametersRaw) : parametersRaw;
      } catch {
        return res.status(400).json({ ok: false, error: "parameters JSON tidak valid" });
      }
    }

    const result = await BacktestHistoryService.lookupCanonical({
      symbol: sym,
      strategyKey,
      timeframe,
      parameters,
      enableFees: enableFees !== "false" && enableFees !== "0",
      enableSlippage: enableSlippage === "true" || enableSlippage === "1",
      exchange: exchange || "sim",
      dataSource: dataSource || "sim",
      periodLabel,
      requestedStart,
      requestedEnd,
    });

    res.json({ ok: true, ...result });
  }));

  /**
   * POST /api/v1/backtest/run
   * Simpan hasil backtest dari klien (Phase 1 — engine di FE)
   * Opsi B: canonical shared archive — reuse / extend / insert
   */
  router.post("/run", asyncHandler(async (req, res) => {
    const {
      strategy_id: strategyId,
      strategy_key: strategyKeyRaw,
      pair,
      symbol,
      timeframe = "1d",
      period_label: periodLabel = "500",
      parameters,
      metrics,
      equity_curve: equityCurve,
      trades,
      trades_data: tradesData,
      config,
      notes,
      multi_strategies: multiStrategies,
      data_start: dataStart,
      data_end: dataEnd,
      action: clientAction,
    } = req.body;

    const sym = (pair || symbol || "").toUpperCase();
    const strategyKey = (strategyKeyRaw || strategyId || "").replace(/^preset-\d+$|^import-/, "").toUpperCase();

    if (!sym || !metrics) {
      return res.status(400).json({ ok: false, error: "pair/symbol dan metrics diperlukan" });
    }

    if (clientAction === "reused") {
      const canonicalKey = BacktestHistoryService._buildKeyFromMeta({
        symbol: sym,
        strategyKey,
        timeframe,
        parameters: parameters || {},
        enableFees: config?.enableFees !== false,
        enableSlippage: !!config?.enableSlippage,
        exchange: config?.exchange || "sim",
        dataSource: config?.dataSource || "sim",
        periodLabel,
      });
      const existing = await db.findBacktestByCanonicalKey(canonicalKey);
      if (existing) {
        return res.json({
          ok: true,
          id: existing.id,
          action: "reused",
          message: `Backtest shared reused untuk ${sym}`,
        });
      }
    }

    const normalized = normalizeMetrics(metrics);
    const runConfig = {
      ...(config || {}),
      strategyKey,
      timeframe,
      periodLabel,
      parameters: parameters || {},
      multiStrategies: multiStrategies || null,
    };

    const id = await BacktestHistoryService.saveOrUpdateCanonical({
      symbol: sym,
      strategyKey,
      timeframe,
      periodLabel,
      parameters: parameters || {},
      enableFees: config?.enableFees !== false,
      enableSlippage: !!config?.enableSlippage,
      exchange: config?.exchange || "sim",
      dataSource: config?.dataSource || "sim",
      metrics: normalized,
      equityCurve: equityCurve || null,
      tradesData: trades || tradesData || null,
      config: runConfig,
      notes: notes || null,
      userId: req.userId,
      dataStart,
      dataEnd,
      action: clientAction || null,
    });

    res.json({
      ok: true,
      id,
      action: clientAction || "saved",
      message: `Backtest disimpan untuk ${sym}`,
    });
  }));

  /**
   * GET /api/v1/backtest/archive
   * Arsip backtest global shared (tanpa filter user)
   */
  router.get("/archive", asyncHandler(async (req, res) => {
    const { strategy, pair, limit = 50, offset = 0 } = req.query;
    const data = await BacktestHistoryService.getArchive({
      strategy,
      pair,
      limit,
      offset,
    });
    res.json({ ok: true, count: data.length, data });
  }));

  /**
   * POST /api/v1/backtest/export-csv
   * Export CSV single atau multi-run
   */
  router.post("/export-csv", asyncHandler(async (req, res) => {
    const { ids, mode = "trades" } = req.body;
    if (!ids?.length) {
      return res.status(400).json({ ok: false, error: "ids diperlukan" });
    }
    const records = await BacktestHistoryService.getByIds(ids.map(Number));
    if (!records.length) {
      return res.status(404).json({ ok: false, error: "Tidak ada record ditemukan" });
    }
    const csv = BacktestCsvService.exportBacktests(records, mode);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="quantara_backtest_trades_${Date.now()}.csv"`);
    res.send(csv);
  }));

  /**
   * DELETE /api/v1/backtest/runs/bulk
   * Hapus beberapa backtest sekaligus (bulk select di arsip)
   */
  router.delete("/runs/bulk", asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!ids?.length) {
      return res.status(400).json({ ok: false, error: "ids diperlukan" });
    }
    const result = await BacktestHistoryService.deleteRuns(ids, req.userId);
    res.json({ ok: true, ...result, message: `${result.deleted} backtest dihapus` });
  }));

  /**
   * DELETE /api/v1/backtest/run/:id
   * User hapus run sendiri; admin bisa hapus run user mana pun
   */
  router.delete("/run/:id", asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, error: "ID tidak valid" });
    }
    await BacktestHistoryService.deleteRun(id, req.userId);
    res.json({ ok: true, id, message: "Backtest dihapus" });
  }));

  /**
   * GET /api/v1/backtest/run/:id
   * Alias detail backtest by ID
   */
  router.get("/run/:id", asyncHandler(async (req, res) => {
    const record = await BacktestHistoryService.getById(parseInt(req.params.id, 10));
    if (!record) {
      return res.status(404).json({ ok: false, error: "Backtest tidak ditemukan" });
    }
    res.json({ ok: true, data: record });
  }));

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
   * POST /api/v1/backtest/grok-confirm
   * Batch Grok Confirm Gate untuk backtest — 1 call per sinyal rules.
   */
  router.post("/grok-confirm", asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    const access = await GrokConfirmService.canUseGrokConfirm(userId, { backtest: true });
    if (!access.allowed) {
      return res.status(403).json({ ok: false, message: access.reason });
    }

    const validated = validateGrokConfirmPayload(req.body);
    if (validated.error) {
      return res.status(validated.error.status).json({ ok: false, message: validated.error.message });
    }
    if (validated.empty) {
      return res.json({ ok: true, decisions: {}, stats: { total: 0, approved: 0, rejected: 0, apiCalls: 0 } });
    }

    const result = await GrokConfirmBatchProcessor.processBatch({
      userId,
      strategyKey: validated.strategyKey,
      symbol: validated.symbol,
      signals: validated.signals,
      tpAdjust: validated.tpAdjust,
      tpBandPct: validated.tpBandPct,
      tpRejectAction: validated.tpRejectAction,
    });

    res.json({ ok: true, ...result });
  }));

  /**
   * POST /api/v1/backtest/grok-job
   * Mulai job Grok Confirm async — respons cepat, proses lanjut di server.
   */
  router.post("/grok-job", asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }
    const access = await GrokConfirmService.canUseGrokConfirm(userId, { backtest: true });
    if (!access.allowed) {
      return res.status(403).json({ ok: false, message: access.reason });
    }

    const validated = validateGrokConfirmPayload(req.body);
    if (validated.error) {
      return res.status(validated.error.status).json({ ok: false, message: validated.error.message });
    }
    if (validated.empty) {
      return res.json({
        ok: true,
        jobId: null,
        status: "done",
        progress: { done: 0, total: 0 },
        decisions: {},
        stats: { total: 0, approved: 0, rejected: 0, apiCalls: 0 },
      });
    }

    const { existingDecisions } = req.body ?? {};

    const jobId = GrokBacktestJobService.createJob(userId, {
      strategy_key: validated.strategyKey,
      symbol: validated.symbol,
      signals: validated.signals,
      tpAdjust: validated.tpAdjust,
      tpBandPct: validated.tpBandPct,
      tpRejectAction: validated.tpRejectAction,
      existingDecisions: existingDecisions && typeof existingDecisions === "object"
        ? existingDecisions
        : {},
    });

    const job = GrokBacktestJobService.getJob(userId, jobId);
    res.json({
      ok: true,
      jobId,
      status: job?.status ?? "queued",
      progress: job?.progress ?? { done: 0, total: validated.signals.length },
      resumed: Object.keys(existingDecisions || {}).length > 0,
    });
  }));

  /**
   * GET /api/v1/backtest/grok-job/:jobId
   * Poll status/progress/hasil job Grok Confirm backtest.
   * HARUS sebelum /:symbol/* agar tidak tertangkap wildcard.
   */
  router.get("/grok-job/:jobId", asyncHandler(async (req, res) => {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, message: "Unauthorized" });
    }

    const job = GrokBacktestJobService.getJob(userId, req.params.jobId);
    if (!job) {
      return res.status(404).json({
        ok: false,
        message: "Job tidak ditemukan atau sudah kedaluwarsa",
      });
    }

    res.json({
      ok: true,
      jobId: req.params.jobId,
      ...GrokBacktestJobService.toPublicJob(job),
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
    const { symbol, metrics, equityCurve, tradesData, config, notes, strategy_key: strategyKey, timeframe, period_label: periodLabel } = req.body;

    if (!symbol || !metrics) {
      return res.status(400).json({
        ok: false,
        error: "symbol and metrics are required",
      });
    }

    const id = await BacktestHistoryService.saveBacktest(
      symbol,
      metrics,
      equityCurve,
      tradesData,
      config,
      notes,
      { userId: req.userId, strategyKey, timeframe, periodLabel }
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
      data = await BacktestHistoryService.getHistory(symbol, pageLimit);
    } else {
      data = await BacktestHistoryService.getAllHistory(pageLimit);
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
    const record = await BacktestHistoryService.getById(parseInt(id));

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
    const stats = await BacktestHistoryService.getStatistics(symbol);

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

    const comparison = await BacktestHistoryService.compareBacktests(parseInt(id1), parseInt(id2));

    res.json({
      ok: true,
      comparison,
    });
  }));

  /**
   * POST /api/v1/backtest/report/generate
   * Generate report in PDF, JSON, or HTML format
   */
  router.post("/report/generate", asyncHandler(async (req, res) => {
    const { symbol, backtest_id, format = "html", include_charts = true, include_trade_details = true } =
      req.body;

    if (!symbol && !backtest_id) {
      return res.status(400).json({
        ok: false,
        error: "symbol or backtest_id is required",
      });
    }

    const options = { include_charts, include_trade_details };
    let reportData;

    switch (format) {
      case "pdf":
      case "html":
        reportData = await ReportGeneratorService.generateHTMLReport(symbol, backtest_id, options);
        res.setHeader("Content-Type", "text/html");
        break;
      case "json":
        reportData = await ReportGeneratorService.generateJSONReport(symbol, backtest_id, options);
        res.setHeader("Content-Type", "application/json");
        break;
      default:
        return res.status(400).json({
          ok: false,
          error: "Unsupported format. Use 'pdf', 'html', or 'json'",
        });
    }

    res.json({
      ok: true,
      format,
      data: reportData,
    });
  }));

  /**
   * POST /api/v1/backtest/report/email
   * Email backtest report to recipient
   */
  router.post("/report/email", asyncHandler(async (req, res) => {
    const { symbol, backtest_id, email, include_charts = true, include_trade_details = true } = req.body;

    if (!symbol && !backtest_id) {
      return res.status(400).json({
        ok: false,
        error: "symbol or backtest_id is required",
      });
    }

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "email is required",
      });
    }

    const options = { include_charts, include_trade_details };
    const result = await ReportGeneratorService.sendReportEmail(symbol, backtest_id, email, options);

    res.json({
      ok: true,
      ...result,
    });
  }));

  /**
   * GET /api/v1/backtest/optimize
   * Get optimization analysis for backtest
   * Query params: symbol (optional), backtest_id (optional)
   */
  router.get("/optimize", asyncHandler(async (req, res) => {
    const { symbol, backtest_id, useAi } = req.query;

    if (!symbol && !backtest_id) {
      return res.status(400).json({
        ok: false,
        error: "symbol or backtest_id is required",
      });
    }

    const analysis = await OptimizationAnalysisService.analyzeBacktest(
      symbol,
      backtest_id ? parseInt(backtest_id) : null,
      {
        useAi: useAi !== "false",
        userId: req.userId,
      }
    );

    res.json({
      ok: true,
      data: analysis,
    });
  }));

  /**
   * POST /api/v1/backtest/optimize
   * Analisis optimasi dari metrik sesi backtest (prioritas) atau arsip DB.
   * Body: { symbol?, backtest_id?, metrics? }
   */
  router.post("/optimize", asyncHandler(async (req, res) => {
    const { symbol, backtest_id, metrics } = req.body || {};

    if (!metrics && !symbol && !backtest_id) {
      return res.status(400).json({
        ok: false,
        error: "metrics, symbol, or backtest_id is required",
      });
    }

    const metricsOverride = metrics
      ? OptimizationAnalysisService.mapSessionStats(metrics)
      : null;

    const useAi = req.body?.useAi !== false;
    const analysis = await OptimizationAnalysisService.analyzeBacktest(
      symbol,
      backtest_id ? parseInt(backtest_id, 10) : null,
      {
        metricsOverride,
        useAi,
        userId: req.userId,
        strategyKey: req.body?.strategyKey ?? null,
      }
    );

    res.json({
      ok: true,
      data: { ...analysis, source: metricsOverride ? "session" : "archive" },
    });
  }));

  /**
   * POST /api/v1/backtest/run-server
   * Phase 3 foundation — simplified server-side backtest (scripts/lib/simulator.js).
   * Bukan replika BotEngine penuh; untuk validasi silang & future migration.
   */
  router.post("/run-server", asyncHandler(async (req, res) => {
    const { candles, strategyKey = "MEAN_REVERSION", parameters = {}, options = {} } = req.body;
    if (!Array.isArray(candles) || candles.length < 50) {
      return res.status(400).json({ ok: false, error: "Minimal 50 candles diperlukan" });
    }
    const normalized = candles.map(c => ({
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volume ?? 0),
      date: c.date,
      timestamp: c.timestamp,
    }));
    const result = runSimpleServerBacktest(
      normalized,
      String(strategyKey).toUpperCase(),
      parameters,
      options,
    );
    res.json({
      ok: true,
      ...result,
      note: "Server-side simplified simulator — bukan BotEngine penuh (Phase 3 foundation)",
    });
  }));

  /**
   * POST /api/v1/backtest/run-real
   * TRUE 1:1 server-side backtest — replays candles through the REAL strategy
   * code (AdaptiveFusionStrategy.detectSignal + detectHTFTrend + risk gates),
   * exactly the path AdaptiveStrategyEngine uses live. Multi-TF: entry TF + HTF
   * are taken from the strategy's canonical config (AF: 15m entry + 1h HTF),
   * not from a single user-picked timeframe.
   *
   * Body: { symbol|pair, strategy_key, period_id|custom_start|custom_end,
   *         capital, enable_fees, enable_slippage, parameters,
   *         entry_timeframe?, htf_timeframe? }
   */
  router.post("/run-real", asyncHandler(async (req, res) => {
    const {
      symbol, pair,
      strategy_key: strategyKeyRaw,
      period_id: periodId,
      custom_start: customStart,
      custom_end: customEnd,
      capital = 1000,
      enable_fees: enableFees = true,
      enable_slippage: enableSlippage = false,
      parameters = {},
      entry_timeframe: entryTfOverride,
      htf_timeframe: htfTfOverride,
    } = req.body;

    const sym = (pair || symbol || "").toUpperCase();
    const strategyKey = String(strategyKeyRaw || "ADAPTIVE_FUSION").toUpperCase();
    if (!sym) return res.status(400).json({ ok: false, error: "symbol/pair diperlukan" });

    const cfg = STRATEGIES[strategyKey];
    if (!cfg) return res.status(400).json({ ok: false, error: `Strategi tidak dikenal: ${strategyKey}` });

    // Multi-TF layout: canonical strategy config decides entry + HTF (1:1 w/ live).
    const entryTf = entryTfOverride || cfg.interval || "15m";
    const htfTf = htfTfOverride !== undefined ? htfTfOverride : (cfg.higherTf || null);

    const fetchOpts = { periodId, customStart, customEnd };
    const entryRes = await HistoricalKlinesService.fetchHistoricalKlines(req.userId, {
      symbol: sym, timeframe: entryTf, ...fetchOpts,
    });
    const entryCandles = entryRes.candles || [];
    if (entryCandles.length < 60) {
      return res.status(400).json({ ok: false, error: `Data ${entryTf} tidak cukup (${entryCandles.length} bar)` });
    }

    let htfCandles = null;
    if (htfTf) {
      try {
        const htfRes = await HistoricalKlinesService.fetchHistoricalKlines(req.userId, {
          symbol: sym, timeframe: htfTf, ...fetchOpts,
        });
        htfCandles = htfRes.candles || null;
      } catch (e) {
        htfCandles = null; // fail-open on HTF fetch error; engine notes higherTf intent
      }
    }

    // v3.3: Add timing info for progress feedback (50K+ bars can take 15-30s)
    const startMs = Date.now();
    const result = runRealBacktest({
      entryCandles,
      htfCandles,
      strategyKey,
      capital: Number(capital) || 1000,
      enableFees: enableFees !== false,
      enableSlippage: !!enableSlippage,
      config: parameters,
    });
    const elapsedMs = Date.now() - startMs;

    res.json({
      ok: true,
      engine: "real-1to1",
      strategyKey,
      symbol: sym,
      entryTimeframe: entryTf,
      htfTimeframe: htfTf,
      entryBars: entryCandles.length,
      htfBars: htfCandles?.length ?? 0,
      dataStart: entryRes.startDate,
      dataEnd: entryRes.endDate,
      source: entryRes.source,
      computeTimeMs: elapsedMs,  // v3.3: show user how long backtest took
      ...result,
    });
  }));

  return router;
};
