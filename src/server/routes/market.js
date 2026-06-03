// ─── src/server/routes/market.js ─────────────────────────────────────────────
// Market data endpoints: tickers, candles, balance, positions
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");

const INTERVAL_MS = {
  "1m":  60_000,      "3m":  180_000,    "5m":  300_000,
  "15m": 900_000,     "30m": 1_800_000,  "1h":  3_600_000,
  "2h":  7_200_000,   "4h":  14_400_000, "6h":  21_600_000,
  "12h": 43_200_000,  "1d":  86_400_000, "1w":  604_800_000,
};

module.exports = function createMarketRouter({ sharedClient, bots, getBot, SYMBOLS_LIST }) {
  const router = Router();

  // Ticker harga real-time
  router.get("/tickers", async (req, res) => {
    try {
      const syms = (req.query.symbols || SYMBOLS_LIST.join(","))
        .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      const result = {};
      await Promise.all(syms.map(async sym => {
        try { result[sym] = await sharedClient.getTicker(sym); }
        catch { result[sym] = null; }
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Balance dari exchange
  router.get("/balance", async (req, res) => {
    try {
      const anyBot = [...bots.values()][0];
      res.json(await anyBot.client.getBalance("USDT"));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Posisi terbuka
  router.get("/positions", async (req, res) => {
    try {
      const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
      const bot = getBot(sym) || [...bots.values()][0];
      res.json(await bot.client.getPositions(bot.config.symbol));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Candles terkini
  router.get("/candles", async (req, res) => {
    try {
      const sym      = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
      const bot      = getBot(sym) || [...bots.values()][0];
      const interval = req.query.interval || bot.config.interval;
      const limit    = Math.min(parseInt(req.query.limit) || 200, 500);
      res.json(await sharedClient.getCandles(sym, interval, limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Candles historis untuk backtest (pagination)
  router.get("/candles/backtest", async (req, res) => {
    try {
      const symbol    = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
      const timeframe = req.query.interval || "1d";
      const total     = Math.min(parseInt(req.query.limit) || 500, 1000);
      const PAGE      = 200;
      const msPerBar  = INTERVAL_MS[timeframe] || 86_400_000;
      const allCandles = [];
      let since = Date.now() - total * msPerBar;

      while (allCandles.length < total) {
        const remaining = total - allCandles.length;
        const batch = await sharedClient.getCandles(symbol, timeframe, Math.min(remaining, PAGE), since);
        if (!batch || batch.length === 0) break;
        allCandles.push(...batch);
        since = batch[batch.length - 1].timestamp + msPerBar;
        if (batch.length < Math.min(remaining, PAGE)) break;
      }

      const seen   = new Set();
      const unique = allCandles
        .filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; })
        .sort((a, b) => a.timestamp - b.timestamp);

      res.json(unique);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
