// ─── src/server/routes/history.js ────────────────────────────────────────────
// Database / history endpoints: sessions, trades, equity, logs
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");

module.exports = function createHistoryRouter({ SYMBOLS_LIST }) {
  const router = Router();

  router.get("/sessions", (req, res) => {
    try {
      const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
      const symbol = req.query.symbol || null;
      res.json(db.getSessions(limit, symbol));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/sessions/:id", (req, res) => {
    try {
      const session = db.getSession(parseInt(req.params.id));
      if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/trades", (req, res) => {
    try {
      const sessionId = req.query.session_id ? parseInt(req.query.session_id) : null;
      const symbol    = req.query.symbol || null;
      const limit     = Math.min(parseInt(req.query.limit) || 100, 1000);
      res.json(db.getTrades({ sessionId, symbol, limit }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/trades/stats/:sessionId", (req, res) => {
    try {
      res.json(db.getTradeStats(parseInt(req.params.sessionId)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/equity/:sessionId", (req, res) => {
    try {
      res.json(db.getEquity(parseInt(req.params.sessionId)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/logs/:sessionId", (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      res.json(db.getLogs(parseInt(req.params.sessionId), limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/info", (req, res) => {
    try {
      res.json({ path: db.getDbPath(), symbols: SYMBOLS_LIST });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
