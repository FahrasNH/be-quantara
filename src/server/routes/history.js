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

  // ── GET /api/insights ─────────────────────────────────────────────────────
  // Export snapshot indikator + hasil trade untuk analitik / ML.
  //
  // Query params:
  //   symbol  — filter per koin   (contoh: ETHUSDT)
  //   dry_run — "true" | "false"  (default: semua)
  //   limit   — max rows          (default 500, max 5000)
  //   format  — "json" (default) | "csv"
  //
  // Contoh response item:
  //   { rsi, atr, atrPct, volumeRatio, emaTrendBias, htfTrend, strategy,
  //     side, result, pnl, rMultiple, openTime, closeTime, ... }
  router.get("/insights", (req, res) => {
    try {
      const symbol  = req.query.symbol  || null;
      const limit   = Math.min(parseInt(req.query.limit) || 500, 5000);
      const dryRun  = req.query.dry_run === undefined ? null
        : req.query.dry_run === "true";
      const format  = req.query.format || "json";

      const data = db.getInsights({ symbol, dryRun, limit });

      if (format === "csv") {
        if (data.length === 0) return res.status(200).send("No data");
        const headers = Object.keys(data[0]).join(",");
        const rows    = data.map(r =>
          Object.values(r).map(v => (v === null ? "" : String(v))).join(",")
        ).join("\n");
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename="quantara-insights-${Date.now()}.csv"`);
        return res.send(`${headers}\n${rows}`);
      }

      // JSON default — sertakan summary statistik
      const wins   = data.filter(d => d.result === "win").length;
      const losses = data.filter(d => d.result === "loss").length;
      const avgRsi = data.length ? +(data.reduce((s, d) => s + (d.rsi || 0), 0) / data.length).toFixed(1) : null;
      const avgVol = data.length ? +(data.reduce((s, d) => s + (d.volumeRatio || 0), 0) / data.length).toFixed(2) : null;

      res.json({
        total:   data.length,
        wins,
        losses,
        winRate: data.length ? +((wins / data.length) * 100).toFixed(1) : 0,
        avgRsiAtEntry:    avgRsi,
        avgVolumeRatio:   avgVol,
        trades: data,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
