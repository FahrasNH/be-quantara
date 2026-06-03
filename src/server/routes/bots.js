// ─── src/server/routes/bots.js ───────────────────────────────────────────────
// Bot management endpoints: start, stop, status, config, logs, balance, positions
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");

module.exports = function createBotsRouter({ bots, getBot, broadcast, SYMBOLS_LIST }) {
  const router = Router();

  // Daftar semua bot
  router.get("/", (req, res) => {
    const result = {};
    for (const [sym, bot] of bots) result[sym] = bot.getState();
    res.json(result);
  });

  // Status satu bot
  router.get("/:symbol", (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    res.json(bot.getState());
  });

  // Start satu bot
  router.post("/:symbol/start", async (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    try {
      await bot.start();
      res.json({ ok: true, symbol: req.params.symbol.toUpperCase(), message: "Bot berhasil dijalankan" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Stop satu bot
  router.post("/:symbol/stop", async (req, res) => {
    const bot = getBot(req.params.symbol);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    try {
      await bot.stop();
      res.json({ ok: true, symbol: req.params.symbol.toUpperCase(), message: "Bot berhasil dihentikan" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // Switch strategi per bot
  router.post("/:symbol/strategy", async (req, res) => {
    const BotEngine = require("../../application/BotEngine");

    const sym      = req.params.symbol.toUpperCase();
    const strategy = (req.body.strategy || "").toUpperCase();

    if (!["A", "B", "C"].includes(strategy)) {
      return res.status(400).json({ error: "Strategy tidak valid. Pilih: A, B, atau C" });
    }

    const oldBot = getBot(sym);
    if (!oldBot) return res.status(404).json({ error: "Symbol tidak tersedia" });

    const wasRunning = oldBot.getState().running;
    if (wasRunning) await oldBot.stop();
    oldBot.removeAllListeners();

    db.setSetting(`strategy_${sym}`, strategy);

    const capital = parseFloat(process.env[`CAPITAL_${sym}`]) || parseFloat(process.env.CAPITAL) || 500;
    const newBot  = new BotEngine({ symbol: sym, capital, strategy });

    newBot.on("log",    entry => broadcast({ type: "log",    symbol: sym, data: entry }));
    newBot.on("status", state => broadcast({ type: "status", symbol: sym, data: state }));

    bots.set(sym, newBot);
    if (wasRunning) await newBot.start();

    res.json({
      ok:            true,
      symbol:        sym,
      strategy,
      strategyLabel: newBot.config.strategyLabel,
      signalType:    newBot.config.signalType,
      restarted:     wasRunning,
      message:       `Strategi diganti ke [${strategy}] ${newBot.config.strategyLabel}${wasRunning ? " — bot di-restart otomatis" : ""}`,
    });
  });

  return router;
};
