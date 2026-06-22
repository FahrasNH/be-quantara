// ─── src/server/routes/market.js ─────────────────────────────────────────────
// Market data endpoints: tickers, candles, balance, positions
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");
const ExchangeService = require("../../services/ExchangeService");
const { symbolsRateLimiter } = require("../../middleware/marketRateLimiter");
const { pairClassifier } = require("../../infrastructure/classification/PairClassifier");

// parseInt yang aman — kembalikan `def` jika nilai tidak finite
const safeInt = (val, def = 0) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
};

const INTERVAL_MS = {
  "1m":  60_000,      "3m":  180_000,    "5m":  300_000,
  "15m": 900_000,     "30m": 1_800_000,  "1h":  3_600_000,
  "2h":  7_200_000,   "4h":  14_400_000, "6h":  21_600_000,
  "12h": 43_200_000,  "1d":  86_400_000, "1w":  604_800_000,
};

module.exports = function createMarketRouter({ sharedClient, bots, getBot, SYMBOLS_LIST }) {
  const router = Router();

  // ── Daftar simbol perpetual dari exchange yang terhubung user ──────────────
  // IDOR-safe: ExchangeService memakai req.userId (dari JWT) untuk menentukan
  // exchange milik user sendiri, lalu mengembalikan daftar simbol PUBLIK exchange
  // itu. Rate-limited 10/menit per user (anti-abuse API exchange).
  router.get("/symbols", symbolsRateLimiter, async (req, res) => {
    try {
      const { exchange, symbols, cached, stale } =
        await ExchangeService.getPerpetualSymbols(req.userId);
      res.json({ ok: true, exchange, symbols, cached, stale });
    } catch (err) {
      const status = err.statusCode || 500;
      res.status(status).json({
        ok: false,
        statusCode: status,
        code: err.code || "SYMBOLS_ERROR",
        message: err.message,
      });
    }
  });

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

  // SEC-MKT-1 (removed 2026-06-16): GET /market/balance and GET /market/positions
  // were backed by `sharedClient` (operator ENV keys), so they returned the
  // OPERATOR account's balance/positions to any authenticated user — an
  // information-disclosure smell. Both were dead endpoints (no FE caller; the FE
  // uses /account/exchange-balance and per-bot WebSocket state for live positions).
  // Per-user balance/positions are served by /account/* with the user's own creds.

  // Candles terkini
  router.get("/candles", async (req, res) => {
    try {
      const sym      = (req.query.symbol || SYMBOLS_LIST[0] || "BTCUSDT").toUpperCase();
      const bot      = getBot(req.userId, sym);
      const interval = req.query.interval || bot?.config?.interval || "15m";
      const limit    = Math.min(safeInt(req.query.limit, 200), 500);

      try {
        const candles = await sharedClient.getCandles(sym, interval, limit);
        db.cacheCandles("bitget", sym, interval, candles).catch(() => {});
        return res.json(candles);
      } catch (liveErr) {
        const stale = await db.getCachedCandles("bitget", sym, interval, 86_400);
        if (stale?.length) return res.json(stale);
        throw liveErr;
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Candles historis untuk backtest (pagination)
  router.get("/candles/backtest", async (req, res) => {
    try {
      const symbol    = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
      const timeframe = req.query.interval || "1d";
      const total     = Math.min(safeInt(req.query.limit, 500), 1000);

      // Cache fresh 1 jam — hindari banyak request ke Bitget saat jaringan lambat
      const cached = await db.getCachedCandles("bitget", symbol, timeframe, 3600);
      if (cached && cached.length >= Math.min(total, 50)) {
        return res.json(cached.slice(-total));
      }

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

      if (unique.length >= 50) {
        db.cacheCandles("bitget", symbol, timeframe, unique).catch(() => {});
        return res.json(unique);
      }

      // Fallback cache stale (24 jam) bila live fetch gagal sebagian
      const stale = await db.getCachedCandles("bitget", symbol, timeframe, 86_400);
      if (stale?.length >= 50) return res.json(stale.slice(-total));

      res.json(unique);
    } catch (err) {
      try {
        const symbol    = (req.query.symbol || SYMBOLS_LIST[0]).toUpperCase();
        const timeframe = req.query.interval || "1d";
        const stale = await db.getCachedCandles("bitget", symbol, timeframe, 86_400);
        if (stale?.length >= 50) return res.json(stale);
      } catch { /* noop */ }
      res.status(500).json({ error: err.message });
    }
  });

  // ── PAIR-TIER-03: GET /market/pair-classification/:symbol ─────────────────
  // Returns pair volatility tier + recommended strategies + param overrides.
  // Auth-required (authMiddleware already applied at app level for /api/v1/*).
  // Response is safe to cache on client (classification is deterministic &
  // stable intra-day; no per-user data exposed).
  router.get("/pair-classification/:symbol", (req, res) => {
    try {
      const symbol = (req.params.symbol || "").toUpperCase().trim();
      if (!symbol) {
        return res.status(400).json({ ok: false, message: "symbol param required" });
      }
      const result = pairClassifier.classify(symbol);
      res.json({
        ok: true,
        symbol,
        tier:                  result.tier,
        riskLevel:             result.riskLevel,
        recommendedStrategies: result.recommendedStrategies,
        cautiousStrategies:    result.cautiousStrategies,
        blockedStrategies:     result.blockedStrategies,
        paramOverrides:        result.paramOverrides,
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message });
    }
  });

  return router;
};
