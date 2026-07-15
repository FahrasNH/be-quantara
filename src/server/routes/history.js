// ─── src/server/routes/history.js ────────────────────────────────────────────
// Database / history endpoints: sessions, trades, equity, logs
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");
const db = require("../../infrastructure/db/database");
const {
  TRADE_EXPORT_COLUMNS,
  toCsv: toCsvShared,
  buildPerformanceSummaryCsv,
} = require("#shared/csv/tradeExportCsv.js");

// parseInt yang aman — kembalikan `def` jika nilai tidak finite
const safeInt = (val, def = 0) => {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : def;
};

// Rate-limit sederhana untuk endpoint mahal
let lastRecalc = 0;

module.exports = function createHistoryRouter({ SYMBOLS_LIST, getAllBots }) {
  const router = Router();

  router.get("/sessions", async (req, res) => {
    try {
      const limit    = Math.min(safeInt(req.query.limit, 20), 500);
      const symbol   = req.query.symbol || null;
      const sessions = await db.getSessions(limit, symbol, req.userId ?? null);

      // Enrich dengan status live: sesi hanya benar-benar "aktif" bila bot-nya
      // masih running di memory (sessionId cocok). Tanpa ini, crash/restart VPS
      // membuat stopped_at tetap NULL → semua sesi lama tampak "AKTIF" di UI.
      const liveBots = getAllBots ? getAllBots(req.userId) : [];
      // Kumpulkan SEMUA session id yang sedang live. Untuk multi-strategy, satu bot
      // (coordinator) menampung banyak engine — masing-masing punya sessionId sendiri.
      // getSessionIds() menyatukan keduanya (engine tunggal → [id]; coordinator → [id…]).
      const liveSessionIds = new Set();
      for (const b of liveBots) {
        if (!b.getState?.().running) continue;
        const ids = typeof b.getSessionIds === "function"
          ? b.getSessionIds()
          : (b.sessionId ? [b.sessionId] : []);
        for (const id of ids) if (id) liveSessionIds.add(id);
      }

      const enriched = sessions.map(s => ({
        ...s,
        // Override: sesi terbuka (stopped_at NULL) tapi botnya tidak running → tandai closed
        stopped_at: s.stopped_at ?? (liveSessionIds.has(s.id) ? null : new Date().toISOString()),
        is_live_running: liveSessionIds.has(s.id),
      }));

      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/sessions/:id", async (req, res) => {
    try {
      const session = await db.getSession(safeInt(req.params.id, 0), req.userId ?? null);
      if (!session) return res.status(404).json({ error: "Session tidak ditemukan" });
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // CORE CSV columns (Sprint 14 redesign) — shared with admin + backtest export.
  const TRADE_COLUMNS = TRADE_EXPORT_COLUMNS;

  const toCsv = (data, columns = TRADE_COLUMNS) => {
    // columns = null → derive dari keys baris pertama (dipakai endpoint insights
    // yang punya skema field berbeda). label = key apa adanya.
    if (columns == null) {
      const cols = data[0] ? Object.keys(data[0]).map((k) => [k, k]) : [];
      return toCsvShared(data, cols);
    }
    return toCsvShared(data, columns);
  };

  // Ringkasan performa (Performance Summary) — header eksplisit Metric,Value.
  // Hanya menghitung trade tertutup (status "Closed"); open & cancelled dikecualikan
  // dari total (BUG-008). Tidak ada baris pemisah kosong (BUG-005).
  const buildSummaryCsv = buildPerformanceSummaryCsv;

  router.get("/trades", async (req, res) => {
    try {
      const sessionId = req.query.session_id ? safeInt(req.query.session_id, 0) : null;
      const symbol    = req.query.symbol || null;
      const format    = req.query.format || "json";
      const dryRun    = req.query.dry_run === undefined ? null
        : req.query.dry_run === "true";
      const limit     = format === "csv"
        ? Math.min(safeInt(req.query.limit, 5000), 5000)
        : Math.min(safeInt(req.query.limit, 100), 1000);

      if (format === "csv") {
        const data = await db.getTradesExport({ symbol, dryRun, limit, userId: req.userId ?? null });
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="quantara-trades-${Date.now()}.csv"`);
        // BUG-005/008: blok ringkasan dengan header eksplisit Metric,Value (bukan
        // "Unnamed: 1") dan TANPA baris kosong; total hanya dari trade tertutup
        // (status closed) — open & cancelled dikecualikan.
        const summaryCsv = buildSummaryCsv(data);
        return res.send(`${summaryCsv}\n${toCsv(data)}`);
      }

      res.json(await db.getTrades({ sessionId, symbol, limit, userId: req.userId ?? null }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/trades/stats/:sessionId", async (req, res) => {
    try {
      res.json(await db.getTradeStats(safeInt(req.params.sessionId, 0), req.userId ?? null));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/equity/:sessionId", async (req, res) => {
    try {
      res.json(await db.getEquity(safeInt(req.params.sessionId, 0), req.userId ?? null));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Equity curve kumulatif semua sesi (untuk tampilan "All-Time")
  router.get("/equity-all", async (req, res) => {
    try {
      const mode = req.query.mode || "live"; // default live saja
      res.json(await db.getAllEquity(mode, req.userId ?? null));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/db/logs/:sessionId", async (req, res) => {
    try {
      const limit = Math.min(safeInt(req.query.limit, 200), 1000);
      res.json(await db.getLogs(safeInt(req.params.sessionId, 0), limit, req.userId ?? null));
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
      // Scope per user (#13): hanya recalc sesi milik pemanggil, bukan seluruh DB.
      const sessions = await db.getSessions(500, null, req.userId ?? null);
      const results  = [];
      for (const s of sessions) {
        const { rows: trades } = await db._pool.query(
          `SELECT pnl, fee, funding FROM trades
           WHERE session_id = $1 AND close_time IS NOT NULL AND pnl IS NOT NULL
             AND status IS DISTINCT FROM 'cancelled'`,
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

      const data = await db.getInsights({ symbol, dryRun, limit, userId: req.userId ?? null });

      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="quantara-insights-${Date.now()}.csv"`);
        return res.send(toCsv(data, null));
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
