/**
 * Backtest Routes
 * Provides endpoints for accessing backtest metrics, equity curves, and trade data
 */

const express = require("express");
const { EventEmitter } = require("events");
const crypto = require("crypto");
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
const { runRealBacktest, runTripleTypeBacktest, runMultiTypeBacktest } = require("../services/RealStrategyBacktestService");
const GrokConfirmService = require("../services/GrokConfirmService");
const GrokConfirmBatchProcessor = require("../services/GrokConfirmBatchProcessor");
const GrokBacktestJobService = require("../services/GrokBacktestJobService");
const cfg = require("../../config/env");
const { STRATEGY_SUPPORTED_TYPES, validateTypeOrderForStrategy, expandAllTypes } = require("../../constants/strategySupportedTypes");

// ─── Backtest Job Store ────────────────────────────────────────────────────────
// Each job runs async on the server; clients subscribe via SSE.
// Jobs survive client disconnects — the computation keeps running on the server.
class BacktestJob extends EventEmitter {
  constructor(id) {
    super();
    this.setMaxListeners(20);
    this.id = id;
    this.status = "pending"; // pending | running | done | error | cancelled
    this.createdAt = Date.now();
    this.result = null;
    this.error = null;
    this.aborted = false;
    this.progressLog = []; // replay buffer for reconnecting clients
    this.abortController = new AbortController();
  }

  progress(data) {
    const ev = { ...data, ts: Date.now() };
    this.progressLog.push(ev);
    if (this.progressLog.length > 300) this.progressLog.shift();
    this.emit("progress", ev);
  }

  done(result) {
    this.status = "done";
    this.result = result;
    this.emit("result", result);
  }

  fail(errMsg) {
    this.status = "error";
    this.error = errMsg;
    this.emit("jobError", errMsg);
  }

  cancel() {
    if (this.aborted) return;
    this.aborted = true;
    this.status = "cancelled";
    this.abortController.abort();
    this.emit("cancelled");
  }
}

const jobStore = new Map();

// Cleanup jobs older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, job] of jobStore) {
    if (job.createdAt < cutoff) jobStore.delete(id);
  }
}, 5 * 60_000).unref?.();

const USER_STRATEGY_KEYS = ["ADAPTIVE_FUSION", "TREND_FOLLOWING", "MEAN_REVERSION", "BREAKOUT_RETEST"];
// GROK_CONFIRM_STRATEGIES includes USER keys + internal AF aliases (AF_SMC runs real engine w/ server-side gate)
// + the v2.0 component keys (TS_TF/MD_MR/BS_BR). The FE sends v2.0 component keys for tier legs
// (FORGE/MINT/VAULT), so omitting them here rejected every Grok-gated Trend Following / Mean Reversion /
// Breakout leg with a 400 even though the tier was valid. legacyStrategies.STRATEGIES already resolves
// these keys downstream, so accepting them is safe.
const GROK_CONFIRM_STRATEGIES = new Set([
  ...USER_STRATEGY_KEYS,
  "AF_SMC",
  "SMART_MONEY_CONCEPTS",
  "TS_TF",
  "MD_MR",
  "BS_BR",
]);
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
        message: "Grok Confirm Gate hanya untuk strategi Adaptive Fusion, Trend Surge (TS_TF), Mean Drift (MD_MR), dan Breakout (BS_BR)",
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
  TREND_FOLLOWING: "TM",
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
   * Starts an async backtest job and returns { ok, jobId }.
   * Subscribe to GET /stream/:jobId for SSE progress + result.
   * Cancel with DELETE /cancel/:jobId.
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
      debug: debugMode = false,
      grok_gate: grokGate = false,
    } = req.body;

    const sym = (pair || symbol || "").toUpperCase();
    const strategyKey = String(strategyKeyRaw || "ADAPTIVE_FUSION").toUpperCase();
    if (!sym) return res.status(400).json({ ok: false, error: "symbol/pair is required" });

    // Validate tpMode if provided
    const tpMode = parameters?.tpMode;
    if (tpMode && !["fixed", "partial", "auto"].includes(tpMode)) {
      return res.status(400).json({ ok: false, error: `Invalid tpMode: ${tpMode}. Allowed: fixed, partial, auto` });
    }

    const strategyCfg = STRATEGIES[strategyKey] || STRATEGIES["ADAPTIVE_FUSION"];
    if (!strategyCfg && !["AF_SMC"].includes(strategyKey)) {
      return res.status(400).json({ ok: false, error: `Unknown strategy: ${strategyKey}` });
    }

    // Create job
    const jobId = crypto.randomUUID();
    const job = new BacktestJob(jobId);
    jobStore.set(jobId, job);

    // Run async — client subscribes via SSE, server keeps running even if client disconnects
    _runBacktestJobAsync(job, req.userId, {
      sym, strategyKey, strategyCfg,
      periodId, customStart, customEnd,
      capital, enableFees, enableSlippage,
      parameters, entryTfOverride, htfTfOverride, debugMode, grokGate,
    }).catch((err) => {
      if (job.status !== "cancelled") job.fail(err.message || "Backtest failed");
    });

    return res.json({ ok: true, jobId });
  }));

  /**
   * GET /api/v1/backtest/stream/:jobId
   * Server-Sent Events stream for backtest progress and result.
   * Re-connect safe: replays progress log on reconnect; sends cached result if already done.
   */
  router.get("/stream/:jobId", (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found or expired (30-min TTL)" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable nginx proxy buffering
    res.flushHeaders();

    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Replay progress log for reconnecting clients
    for (const p of job.progressLog) send("progress", p);

    // If already settled, send final event and close
    if (job.status === "done")      { send("result", job.result); res.end(); return; }
    if (job.status === "error")     { send("jobError", { message: job.error }); res.end(); return; }
    if (job.status === "cancelled") { send("cancelled", {}); res.end(); return; }

    // Heartbeat every 20 s to prevent proxy/browser timeouts
    const ping = setInterval(() => { if (!res.writableEnded) res.write(":ping\n\n"); }, 20_000);

    const onProgress  = (d) => send("progress", d);
    const onResult    = (d) => { send("result", d); res.end(); };
    const onError     = (m) => { send("jobError", { message: m }); res.end(); };
    const onCancelled = ()  => { send("cancelled", {}); res.end(); };

    job.on("progress",   onProgress);
    job.on("result",     onResult);
    job.on("jobError",   onError);
    job.on("cancelled",  onCancelled);

    req.on("close", () => {
      clearInterval(ping);
      job.off("progress",  onProgress);
      job.off("result",    onResult);
      job.off("jobError",  onError);
      job.off("cancelled", onCancelled);
    });
  });

  /**
   * GET /api/v1/backtest/job-status/:jobId
   * Polling-based alternative to SSE stream. Returns current job state + all progress logs.
   * Client polls every ~1s until status is "done", "error", or "cancelled".
   */
  router.get("/job-status/:jobId", asyncHandler(async (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "Job not found or expired (30-min TTL)" });

    return res.json({
      ok: true,
      status: job.status,           // "pending"|"running"|"done"|"error"|"cancelled"
      progress: job.progressLog,    // all progress events accumulated so far
      result: job.result || null,
      error: job.error || null,
    });
  }));

  /**
   * DELETE /api/v1/backtest/cancel/:jobId
   * Abort a running or pending backtest job.
   */
  router.delete("/cancel/:jobId", asyncHandler(async (req, res) => {
    const job = jobStore.get(req.params.jobId);
    if (!job) return res.status(404).json({ ok: false, error: "Job not found" });
    job.cancel();
    return res.json({ ok: true, message: "Backtest cancelled" });
  }));

  return router;
};

// ─── Async job runner ─────────────────────────────────────────────────────────
const AF_SMC_KEYS = new Set(["AF_SMC", "ADAPTIVE_FUSION", "SMART_MONEY_CONCEPTS"]);
const TYPE_TF = {
  Scalping: { entry: "15m", trend: "4h" },  // AF-SCALP-14: 5m→15m — 5m has zero edge, 15m net PF 1.03
  Intraday: { entry: "15m", trend: "4h" },  // v3.0: 5m→15m entry, 4h HTF bias
  Swing:    { entry: "4h",  trend: "1w" },
};

// TS_TF/MD_MR reuse AF_SMC's own Scalping/Intraday/Swing TF definitions (same
// TYPE_TF above) instead of a single fragile entry TF. TS_TF's canonical
// single-TF entry was 5m — on exchanges with shallow 5m history (e.g. Bitget)
// that ONE fetch failing killed the whole backtest. Running Intraday(15m)+
// Swing(4h) avoids 5m entirely; MD_MR keeps Scalping(5m)+Intraday(15m) but now
// degrades per-type like AF instead of failing outright if 5m comes back empty.
const MULTI_TYPE_STRATEGY_MAP = {
  TS_TF: ["Intraday", "Swing"],
  TREND_FOLLOWING: ["Intraday", "Swing"],
  MD_MR: ["Scalping", "Intraday"],
  MEAN_REVERSION: ["Scalping", "Intraday"],
};

// Per-TF period caps: limit how far back short TFs fetch (avoids timeout).
// 5m: 150 days covers multiple regimes without huge fetch
// 15m: 365 days fits comfortably (~35k bars)
// 4h+: no limit (few bars by nature)
const TYPE_MAX_PERIOD = {
  "1m":  "30d",     // (legacy fallback if sequence engine off)
  "5m": "180d",     // Scalping entry now 5m: 180 days ≈ 51.8k bars
  "15m": "365d",    // Intraday entry now 15m: 365 days ≈ 35k bars
  // Higher TFs used as trend/HTF (Scalping trend 1h, Intraday trend + Swing entry 4h,
  // Swing trend 1w). Previously UNCAPPED → picking "Maximum available" resolved to
  // 2020→now: 1h ≈ 57k bars, 4h ≈ 14k bars, each an unbounded paginated exchange
  // fetch (10s gate per page) → timeout / KLINES_NOT_FOUND on exchanges whose futures
  // history is shallower than 2020 (e.g. Bitget). Bounding "max" here keeps the
  // fetch finite while still giving multi-year coverage. Only bites when userDays
  // (max=3650) exceeds the cap; 3m/6m/12m pass through unchanged.
  "1h":  "730d",    // ≈ 17.5k bars
  "4h": "1460d",    // ≈ 8.7k bars (4 years)
  "1w": "3650d",    // ≈ 520 bars — effectively uncapped, explicit for clarity
};

// Safety: extra bar cap per TF (period cap is primary, this is backup)
const TYPE_MAX_BARS = {
  "1m":  90_000,
  "5m": 120_000,
  "15m": 60_000,
};

function getEffectivePeriod(userPeriodId, timeframe) {
  const maxPeriod = TYPE_MAX_PERIOD[timeframe];
  if (!maxPeriod) return userPeriodId; // no cap for this TF

  // Map user period to days
  const userDays = {
    "3m": 90,
    "6m": 180,
    "12m": 365,
    "max": 3650,
  }[userPeriodId] || null;

  if (!userDays) return userPeriodId; // custom/unknown, pass through

  const maxDays = parseInt(maxPeriod);
  if (userDays > maxDays) {
    return `${maxDays}d`;  // return synthetic period like "90d"
  }
  return userPeriodId;  // user period is shorter, use it
}

async function _runBacktestJobAsync(job, userId, opts) {
  const {
    sym, strategyKey, strategyCfg,
    periodId, customStart, customEnd,
    capital, enableFees, enableSlippage,
    parameters, entryTfOverride, htfTfOverride, debugMode, grokGate,
  } = opts;

  job.status = "running";
  const startMs = Date.now();
  const fetchOpts = { periodId, customStart, customEnd };
  const abortSignal = job.abortController.signal;

  const isAF = AF_SMC_KEYS.has(strategyKey);
  const multiTypeOrder = MULTI_TYPE_STRATEGY_MAP[strategyKey] || null;

  // Advance config: restrict run to selected trade types (Scalping/Intraday/Swing).
  // Sent by the FE as parameters.activeTypes; stripped from parameters so it never
  // leaks into the strategy config. Fallback to the full set when the filter would
  // empty the strategy (defensive — the FE already drops non-matching strategies).
  const VALID_TYPES = new Set(["Scalping", "Intraday", "Swing"]);
  const activeTypes = Array.isArray(parameters?.activeTypes)
    ? parameters.activeTypes.filter(t => VALID_TYPES.has(t))
    : null;
  if (parameters && "activeTypes" in parameters) delete parameters.activeTypes;
  const applyTypeFilter = (order) => {
    if (!activeTypes?.length) return order;
    const filtered = order.filter(t => activeTypes.includes(t));
    return filtered.length ? filtered : order;
  };

  if ((isAF || multiTypeOrder) && !entryTfOverride) {
    // Multi-type mode: each type fetches its own candles, runs only its own component.
    // AF_SMC uses supported types per STRATEGY_SUPPORTED_TYPES (Scalping/Swing, Intraday hidden per AF-SCALP-18);
    // TS_TF/MD_MR use a subset (see MULTI_TYPE_STRATEGY_MAP) but share the exact same
    // TF definitions/fetch resilience/period caps below.
    const entryCandles = {};
    const htfCandles   = {};
    const dataInfo     = {};

    // Normalize typeOrder: expand "All" to supported types, then filter by strategy support
    let typeOrder = isAF ? Object.keys(TYPE_TF) : multiTypeOrder;
    typeOrder = expandAllTypes(strategyKey, typeOrder); // expand "All" → actual supported types
    typeOrder = applyTypeFilter(typeOrder); // apply FE advance-config filter

    // Validate typeOrder against strategy's supported types
    const validation = validateTypeOrderForStrategy(strategyKey, typeOrder);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    for (const type of typeOrder) {
      const tfs = TYPE_TF[type];
      if (abortSignal.aborted) throw new Error("Cancelled");

      job.progress({ phase: "fetch", type, timeframe: tfs.entry, message: `Fetching ${type} candles (${tfs.entry})…`, pct: 0 });

      try {
        // Adjust period for this TF: Scalping 1m with user's 12m → use 90d instead
        const effectivePeriod = getEffectivePeriod(fetchOpts.periodId, tfs.entry);
        const typeMaxBars = TYPE_MAX_BARS[tfs.entry]; // undefined for 4h+ (no cap)
        const entryRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
          symbol: sym, timeframe: tfs.entry, ...fetchOpts, periodId: effectivePeriod, allowClamp: true, abortSignal,
          ...(typeMaxBars ? { maxBarsOverride: typeMaxBars } : {}),
          onProgress: (loaded, total) => {
            const pct = total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
            job.progress({ phase: "fetch", type, timeframe: tfs.entry, message: `${type} (${tfs.entry}): ${loaded.toLocaleString()} / ${total.toLocaleString()} bars`, pct });
          },
        });
        entryCandles[type] = entryRes.candles || [];
        dataInfo[type] = {
          entryBars: entryCandles[type].length,
          realBars: entryRes.realBars,
          coverage: entryRes.coverage,
          startDate: entryRes.startDate,
          endDate: entryRes.endDate,
          clamped: entryRes.clamped || false,
        };
      } catch (e) {
        if (e.code === "CANCELLED") throw e;
        entryCandles[type] = [];
        dataInfo[type] = { error: e.message };
      }

      job.progress({ phase: "fetch", type, timeframe: tfs.trend, message: `Fetching ${type} HTF candles (${tfs.trend})…`, pct: 0 });
      try {
        const effectiveHtfPeriod = getEffectivePeriod(fetchOpts.periodId, tfs.trend);
        const trendRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
          symbol: sym, timeframe: tfs.trend, ...fetchOpts, periodId: effectiveHtfPeriod, allowClamp: true, abortSignal,
        });
        htfCandles[type] = trendRes.candles || [];
      } catch (e) {
        if (e.code === "CANCELLED") throw e;
        htfCandles[type] = [];
      }
    }

    if (abortSignal.aborted) throw new Error("Cancelled");

    job.progress({ phase: "compute", message: isAF ? "Running triple-TF simulation…" : "Running multi-TF simulation…", pct: 0 });

    const typeTotal = typeOrder.length;
    let typesDone = 0;

    // Fetch daily candles for regime gate (shared across all types/strategies)
    let dailyCandles = [];
    try {
      job.progress({ phase: "fetch", message: "Fetching daily candles for regime gate…", pct: 0 });
      const dailyRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
        symbol: sym, timeframe: "1d", ...fetchOpts, allowClamp: true, abortSignal,
      });
      dailyCandles = dailyRes.candles || [];
    } catch (e) {
      if (e.code === "CANCELLED") throw e;
      console.warn("Failed to fetch daily candles for regime gate:", e.message);
      dailyCandles = [];
    }

    const computeOpts = {
      entryCandles,
      htfCandles,
      dailyCandles,
      // Risk ladder must normalize over the strategy's NATURAL type set, not the
      // user-filtered one — else "Scalping only" hands the 0.5%-weight leg the
      // FULL combined 3.5% cap (7x the ladder). See riskShareForType callers.
      naturalTypeOrder: isAF ? Object.keys(TYPE_TF) : multiTypeOrder,
      strategyKey,
      capital: Number(capital) || 1000,
      enableFees: enableFees !== false,
      enableSlippage: !!enableSlippage,
      config: parameters,
      abortSignal,
      // Grok Confirm Gate (AI) — post-hoc filter over produced trades
      grokGate: !!grokGate,
      userId,
      symbol: sym,
      onGrokProgress: (done, total) => {
        // phase:"grok" is routed by the FE to the right-hand Grok drawer (not the
        // inline stream log); done/total let the drawer show an accurate progress bar.
        job.progress({ phase: "grok", done, total, message: `Grok Confirm Gate: ${done}/${total} entri…`, pct: total > 0 ? Math.round(done / total * 100) : 0 });
      },
      onProgress: (pct, _bar, _total, type) => {
        const basePct = Math.round(typesDone / typeTotal * 100);
        const typePct = Math.round(pct / typeTotal);
        job.progress({ phase: "compute", type, message: `Computing ${type} signals… ${pct}%`, pct: basePct + typePct });
        if (pct >= 100) typesDone++;
      },
    };

    const result = isAF
      ? await runTripleTypeBacktest({ ...computeOpts, typeOrder })
      : await runMultiTypeBacktest(computeOpts, typeOrder);

    // AF-SCALP-13: emit ablation funnel to browser via SSE (instead of server log)
    const scalping = result.perTypeStats?.Scalping;
    if (scalping?.ablation) {
      const a = scalping.ablation;
      const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) : "0.0");
      const funnel = {
        phase: "info",
        type: "AF-SCALP-13-ABLATION",
        message: `[AF-SCALP-13] Scalping filter funnel:\n` +
          `  1. Raw setups (FVG+mitigation) : ${a.seqCandidate}\n` +
          `  2. - Rejection-wick gate       : -${a.rejByRejection} (${pct(a.rejByRejection, a.seqCandidate)}%)\n` +
          `     -> signals after rejection   : ${a.seqSignal}\n` +
          `  3. - Regime hard-block          : -${a.rejByRegime} (${pct(a.rejByRegime, a.seqSignal)}%)\n` +
          `  4. - 5m CHoCH validation        : -${a.rejByChoch}\n` +
          `  5. - Confidence floor           : -${a.rejByConf}\n` +
          `  = PASSED (tradeable signals)    : ${a.passed}`,
        ablation: a,
      };
      job.progress(funnel);
    }

    const modeLabel = typeOrder.map(t => `${t} (${TYPE_TF[t].entry}/${TYPE_TF[t].trend})`).join(" + ");

    job.done({
      ok: true,
      engine: isAF ? "real-1to1-triple-tf" : "real-1to1-multi-tf",
      strategyKey,
      symbol: sym,
      mode: isAF ? `SMC Sequence — ${modeLabel}` : `Multi-TF — ${modeLabel}`,
      dataInfo,
      computeTimeMs: Date.now() - startMs,
      ...result,
    });
    return;
  }

  // Single-TF mode
  const entryTf = entryTfOverride || strategyCfg?.interval || "15m";
  const htfTf   = htfTfOverride !== undefined ? htfTfOverride : (strategyCfg?.higherTf || null);

  // Per-TF period cap (same as the AF triple-TF path): a short entry TF like 5m
  // (Trend Following) over "12m" would fetch ~105k bars → huge fetch + a heavy
  // compute loop. Cap short TFs (5m→180d, 15m→365d) so single-strategy real-engine
  // runs stay responsive. 4h+ has no cap.
  const entryEffectivePeriod = getEffectivePeriod(fetchOpts.periodId, entryTf);
  const entryMaxBars = TYPE_MAX_BARS[entryTf];

  job.progress({ phase: "fetch", timeframe: entryTf, message: `Fetching ${entryTf} candles…`, pct: 0 });

  // A single-TF strategy (TS_TF entry 5m, MD_MR entry 15m) has ONLY this one data
  // source — unlike AF's triple-TF path, which catches per-type and degrades the
  // failing component to 0 trades while the others still run. A short TF like 5m
  // often has no deep history on some exchanges (e.g. Bitget serves only recent
  // 5m candles) → fetchOHLCV returns empty → KLINES_NOT_FOUND. Without this guard
  // that raw error propagates and kills the whole job (and, in a tier package, the
  // whole tier). Wrap it and fail with an ACTIONABLE, strategy-aware message.
  const stratLabel = strategyCfg?.label || strategyKey;
  let entryRes;
  try {
    entryRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
      symbol: sym, timeframe: entryTf, ...fetchOpts, periodId: entryEffectivePeriod, allowClamp: true, abortSignal,
      ...(entryMaxBars ? { maxBarsOverride: entryMaxBars } : {}),
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.min(99, Math.round(loaded / total * 100)) : 0;
        job.progress({ phase: "fetch", timeframe: entryTf, message: `Loading ${entryTf} candles: ${loaded.toLocaleString()} / ${total.toLocaleString()}`, pct });
      },
    });
  } catch (e) {
    if (e.code === "CANCELLED") throw e;
    const err = new Error(
      `${stratLabel}: gagal memuat candle ${entryTf} — ${e.message} ` +
      `Exchange mungkin tak menyediakan data ${entryTf} sejauh periode itu. ` +
      `Coba periode lebih pendek/terbaru, timeframe lebih tinggi, atau exchange lain (mis. Binance).`
    );
    err.code = e.code || "ENTRY_FETCH_FAILED";
    err.strategyKey = strategyKey;
    throw err;
  }
  const entryCandles = entryRes.candles || [];
  if (entryCandles.length < 60) {
    const err = new Error(
      `${stratLabel}: data ${entryTf} tidak cukup (${entryCandles.length} bar) untuk backtest. ` +
      `Coba periode lebih panjang, timeframe lebih tinggi, atau exchange lain.`
    );
    err.code = "INSUFFICIENT_DATA";
    err.strategyKey = strategyKey;
    throw err;
  }

  let htfCandles = null;
  if (htfTf) {
    job.progress({ phase: "fetch", timeframe: htfTf, message: `Fetching HTF candles (${htfTf})…`, pct: 0 });
    try {
      const htfRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
        symbol: sym, timeframe: htfTf, ...fetchOpts, periodId: getEffectivePeriod(fetchOpts.periodId, htfTf), allowClamp: true, abortSignal,
      });
      htfCandles = htfRes.candles || null;
    } catch { htfCandles = null; }
  }

  job.progress({ phase: "compute", message: "Running backtest simulation…", pct: 0 });

  // Fetch daily candles for regime gate
  let dailyCandles = [];
  try {
    job.progress({ phase: "fetch", message: "Fetching daily candles for regime gate…", pct: 0 });
    const dailyRes = await HistoricalKlinesService.fetchHistoricalKlines(userId, {
      symbol: sym, timeframe: "1d", ...fetchOpts, allowClamp: true, abortSignal,
    });
    dailyCandles = dailyRes.candles || [];
  } catch (e) {
    if (e.code === "CANCELLED") throw e;
    console.warn("Failed to fetch daily candles for regime gate:", e.message);
    dailyCandles = [];
  }

  job.progress({ phase: "compute", message: "Running backtest simulation…", pct: 0 });

  const result = await runRealBacktest({
    entryCandles,
    htfCandles,
    dailyCandles,
    strategyKey,
    capital: Number(capital) || 1000,
    enableFees: enableFees !== false,
    enableSlippage: !!enableSlippage,
    config: parameters,
    debug: !!debugMode,
    abortSignal,
    onProgress: (pct) => job.progress({ phase: "compute", message: `Simulating… ${pct}%`, pct }),
  });

  job.done({
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
    computeTimeMs: Date.now() - startMs,
    ...result,
  });
}
