// ─── src/server/routes/bots-afs.js ───────────────────────────────────────────
// Bot management endpoints with Adaptive Fusion Strategy support
// start, stop, status, config, logs, balance, positions, strategy management
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");
const { strategyRegistry } = require("../../domain/strategy/StrategyRegistry");

module.exports = function createBotsRouter({ bots, getBot, broadcast, SYMBOLS_LIST }) {
  const router = Router();

  // Lazy-load AdaptiveStrategyEngine
  let AdaptiveStrategyEngine = null;
  const getAdaptiveEngine = () => {
    if (!AdaptiveStrategyEngine) {
      AdaptiveStrategyEngine = require("../../application/AdaptiveStrategyEngine");
    }
    return AdaptiveStrategyEngine;
  };

  /**
   * GET /api/v1/bots
   * List semua bots dengan status
   */
  router.get("/", (req, res) => {
    const result = {};
    for (const [sym, bot] of bots) {
      result[sym] = bot.getState();
    }
    res.json(result);
  });

  /**
   * GET /api/v1/bots/:symbol
   * Get status satu bot
   */
  router.get("/:symbol", (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    res.json(bot.getState());
  });

  /**
   * POST /api/v1/bots/:symbol/start
   * Start bot dengan strategi (default: Adaptive Fusion)
   *
   * Body:
   * {
   *   "strategyKey": "ADAPTIVE_FUSION", // optional
   *   "capital": 500,                    // optional
   *   "dryRun": false                    // optional
   * }
   */
  router.post("/:symbol/start", async (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    try {
      const { strategyKey = "ADAPTIVE_FUSION", capital, dryRun } = req.body;

      // Validate strategy
      const strategyValidation = strategyRegistry.validate(strategyKey);
      if (!strategyValidation.valid) {
        return res.status(400).json({
          ok: false,
          error: strategyValidation.error,
          availableStrategies: strategyValidation.available,
        });
      }

      // Stop existing bot jika running
      if (bot.getState().running) {
        await bot.stop();
      }

      // Update bot config jika ada override
      if (capital !== undefined) bot.config.capital = capital;
      if (dryRun !== undefined) bot.config.dryRun = dryRun;

      await bot.start();

      res.json({
        ok: true,
        symbol: req.params.symbol.toUpperCase(),
        strategy: strategyKey,
        message: `Bot berhasil dijalankan dengan ${strategyKey}`,
        state: bot.getState(),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/v1/bots/:symbol/stop
   * Stop bot
   */
  router.post("/:symbol/stop", async (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    try {
      await bot.stop();
      res.json({
        ok: true,
        symbol: req.params.symbol.toUpperCase(),
        message: "Bot berhasil dihentikan",
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/v1/bots/:symbol/strategy
   * Switch strategy untuk bot
   *
   * Body: { "strategyKey": "ADAPTIVE_FUSION" }
   */
  router.post("/:symbol/strategy", async (req, res) => {
    const sym = req.params.symbol.toUpperCase();
    const { strategyKey = "ADAPTIVE_FUSION" } = req.body;

    // Validate strategy
    const validation = strategyRegistry.validate(strategyKey);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
        availableStrategies: validation.available,
      });
    }

    const oldBot = getBot(sym);
    if (!oldBot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    const wasRunning = oldBot.getState().running;

    try {
      // Stop old bot
      if (wasRunning) await oldBot.stop();
      oldBot.removeAllListeners();

      // Create new bot dengan strategy baru
      const capital = parseFloat(process.env[`CAPITAL_${sym}`]) || parseFloat(process.env.CAPITAL) || 500;
      const AdaptiveEngine = getAdaptiveEngine();
      const newBot = new AdaptiveEngine({
        symbol: sym,
        capital,
        strategyKey,
      });

      // Setup listeners
      newBot.on("log", (entry) => broadcast({ type: "log", symbol: sym, data: entry }));
      newBot.on("status", (state) => broadcast({ type: "status", symbol: sym, data: state }));

      // Replace bot
      bots.set(sym, newBot);

      // Restart jika tadinya running
      if (wasRunning) await newBot.start();

      res.json({
        ok: true,
        symbol: sym,
        strategyKey,
        strategyLabel: newBot.strategy.config.label,
        restarted: wasRunning,
        message: `Strategi diganti ke ${newBot.strategy.config.label}${wasRunning ? " — bot di-restart" : ""}`,
        state: newBot.getState(),
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/v1/bots/strategies/available
   * List semua available strategies
   */
  router.get("/strategies/available", (req, res) => {
    res.json({
      ok: true,
      strategies: strategyRegistry.getUIChoices(),
      count: strategyRegistry.count(),
    });
  });

  /**
   * GET /api/v1/bots/strategies/info/:strategyKey
   * Get detail info tentang strategy
   */
  router.get("/strategies/info/:strategyKey", (req, res) => {
    try {
      const info = strategyRegistry.getInfo(req.params.strategyKey);
      res.json({ ok: true, strategy: info });
    } catch (err) {
      res.status(404).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/v1/bots/:symbol/strategy-analysis
   * Get real-time strategy analysis untuk bot (AFS specific)
   */
  router.get("/:symbol/strategy-analysis", (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    // Check jika bot punya method AFS-specific
    const hasStrategyMethod = typeof bot.getStrategyRankings === "function";

    if (!hasStrategyMethod) {
      return res.json({
        ok: true,
        symbol: req.params.symbol,
        strategy: bot.config.strategyKey,
        afsEnabled: false,
        message: "Bot tidak menggunakan Adaptive Fusion Strategy",
      });
    }

    res.json({
      ok: true,
      symbol: req.params.symbol,
      strategy: bot.config.strategyKey,
      afsEnabled: true,
      rankings: bot.getStrategyRankings(),
      positionConflicts: bot.getPositionConflicts ? bot.getPositionConflicts() : null,
      state: bot.getState(),
    });
  });

  /**
   * GET /api/v1/bots/:symbol/position-conflicts
   * Get detailed position conflict info (AFS specific)
   */
  router.get("/:symbol/position-conflicts", (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    const hasMethod = typeof bot.getPositionConflicts === "function";
    if (!hasMethod) {
      return res.json({
        ok: true,
        symbol: req.params.symbol,
        message: "Position conflict detection not available",
      });
    }

    const conflicts = bot.getPositionConflicts();
    res.json({
      ok: true,
      symbol: req.params.symbol,
      ...conflicts,
    });
  });

  /**
   * GET /api/v1/bots/:symbol/logs
   * Get logs untuk bot
   */
  router.get("/:symbol/logs", (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const logs = bot.getLogs(limit);

    res.json({
      ok: true,
      symbol: req.params.symbol,
      count: logs.length,
      logs,
    });
  });

  /**
   * GET /api/v1/bots/:symbol/balance
   * Get balance untuk bot
   */
  router.get("/:symbol/balance", async (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    try {
      if (bot.config.dryRun) {
        return res.json({
          ok: true,
          symbol: req.params.symbol,
          balance: bot.state.capital,
          dryRun: true,
          available: bot.state.capital,
          equity: bot.state.capital,
        });
      }

      const balance = await bot.client.getBalance(bot.config.marginCoin);
      res.json({
        ok: true,
        symbol: req.params.symbol,
        ...balance,
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
};
