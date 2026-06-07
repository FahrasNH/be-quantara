// ─── src/server/routes/history.js ────────────────────────────────────────────
// Database / history endpoints: sessions, trades, equity, logs
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");

// parseInt yang aman — kembalikan `def` jika nilai tidak finite
const safeInt = (val, def = 0) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
};

// Rate-limit sederhana untuk endpoint mahal
let lastRecalc = 0;

module.exports = function createHistoryRouter({ SYMBOLS_LIST }) {
  const router = Router();

  router.get("/sessions", async (req, res) => {
    try {
      const limit  = Math.min(safeInt(req.query.limit, 20), 500);
      const symbol = req.query.symbol || null;
      res.json(await db.getSessions(limit, symbol, req.userId ?? null));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/sessions/:id", async (req, res) => {
    try {
      const session = await db.getSession(safeInt(req.params.id, 0));
      if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/trades", async (req, res) => {
    try {
      const sessionId = req.query.session_id ? safeInt(req.query.session_id, 0) : null;
      const symbol    = req.query.symbol || null;
      const limit     = Math.min(safeInt(req.query.limit, 100), 1000);
      res.json(await db.getTrades({ sessionId, symbol, limit, userId: req.userId ?? null }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/trades/stats/:sessionId", async (req, res) => {
    try {
      res.json(await db.getTradeStats(safeInt(req.params.sessionId, 0)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/equity/:sessionId", async (req, res) => {
    try {
      res.json(await db.getEquity(safeInt(req.params.sessionId, 0)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Equity curve kumulatif semua sesi (untuk tampilan "All-Time")
  router.get("/equity-all", async (req, res) => {
    try {
      const mode = req.query.mode || "live"; // default live saja
      res.json(await db.getAllEquity(mode));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/logs/:sessionId", async (req, res) => {
    try {
      const limit = Math.min(safeInt(req.query.limit, 200), 1000);
      res.json(await db.getLogs(safeInt(req.params.sessionId, 0), limit));
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

  // ── POST /api/db/recalc-sessions ─────────────────────────────────────────
  // Hitung ulang wins/losses/total_trades/final_capital dari trade records aktual.
  // Dipakai satu kali untuk memperbaiki data historis yang salah akibat
  // bug cross-session (trade buka di sesi A, tutup di sesi B).
  // Rate-limit: maks 1x per 60 detik agar tidak membebani DB.
  router.post("/db/recalc-sessions", async (req, res) => {
    const now = Date.now();
    if (now - lastRecalc < 60_000) {
      const wait = Math.ceil((60_000 - (now - lastRecalc)) / 1000);
      return res.status(429).json({ error: `Tunggu ${wait} detik sebelum recalc berikutnya.` });
    }
    lastRecalc = now;
    try {
      const sessions = await db.getSessions(500);
      const results  = [];
      for (const s of sessions) {
        const { rows: trades } = await db._pool.query(
          `SELECT pnl, fee, funding FROM trades WHERE session_id = $1 AND close_time IS NOT NULL AND pnl IS NOT NULL`,
          [s.id]
        );
        if (trades.length === 0) continue;
        const wins     = trades.filter(t => t.pnl > 0).length;
        const losses   = trades.filter(t => t.pnl <= 0).length;
        // final_capital pakai NET (pnl - fee - funding) agar cocok balance riil
        const totalNet = trades.reduce((sum, t) => sum + (t.pnl - (t.fee || 0) - (t.funding || 0)), 0);
        const finalCap = (s.initial_capital || 0) + totalNet;
        const mismatch = s.wins !== wins || s.losses !== losses || s.total_trades !== trades.length;
        if (mismatch) {
          await db.recalcSessionStats(s.id);
          results.push({
            sessionId: s.id,
            symbol:    s.symbol,
            before:    { wins: s.wins, losses: s.losses, total: s.total_trades },
            after:     { wins, losses, total: trades.length, finalCap: +finalCap.toFixed(4) },
          });
        }
      }
      res.json({ fixed: results.length, sessions: results });
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
  router.get("/insights", async (req, res) => {
    try {
      const symbol  = req.query.symbol  || null;
      const limit   = Math.min(safeInt(req.query.limit, 500), 5000);
      const dryRun  = req.query.dry_run === undefined ? null
        : req.query.dry_run === "true";
      const format  = req.query.format || "json";

      const data = await db.getInsights({ symbol, dryRun, limit });

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
