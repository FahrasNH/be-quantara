// ─── src/server/routes/legacy.js ─────────────────────────────────────────────
// Legacy single-bot endpoints (backwards compatibility with older FE versions).
// Semua route ini meneruskan ke bot pertama atau bot berdasarkan ?symbol=
//
// BE-DEBT-01 (11 Jul 2026): DEPRECATED — do not use for new features.
// Canonical surface: /api/v1/bots/:symbol/*. Removal scheduled after confirming
// zero production traffic for 30 days (ops: check access logs for /api/v1/legacy).
// ─────────────────────────────────────────────────────────────────────────────

const { Router } = require("express");

module.exports = function createLegacyRouter({ getBot, SYMBOLS_LIST = [] }) {
  const router = Router();

  router.use((req, res, next) => {
    res.setHeader("Deprecation", "true");
    res.setHeader("Sunset", "Sat, 01 Nov 2026 00:00:00 GMT");
    res.setHeader(
      "Link",
      '</api/v1/bots>; rel="successor-version"'
    );
    next();
  });

  // Legacy start/stop (pakai query ?symbol= atau symbol pertama)
  router.post("/bot/start", async (req, res) => {
    const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot = getBot(req.userId, sym);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    try {
      await bot.start();
      res.json({ ok: true, symbol: sym, message: "Bot berhasil dijalankan" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.post("/bot/stop", async (req, res) => {
    const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot = getBot(req.userId, sym);
    if (!bot) return res.status(404).json({ error: "Symbol tidak tersedia" });
    try {
      await bot.stop();
      res.json({ ok: true, symbol: sym, message: "Bot berhasil dihentikan" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // SEC-003 fix: scope by req.userId; JANGAN fallback ke [...bots.values()][0]
  // (itu mengembalikan bot pertama user MANA SAJA → IDOR lintas-tenant).
  router.get("/status", (req, res) => {
    const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot = getBot(req.userId, sym);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan" });
    res.json(bot.getState());
  });

  router.get("/config", (req, res) => {
    const sym = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot = getBot(req.userId, sym);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan" });
    res.json(bot.getConfig());
  });

  router.get("/logs", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    const sym   = req.query.symbol?.toUpperCase() || SYMBOLS_LIST[0];
    const bot   = getBot(req.userId, sym);
    if (!bot) return res.status(404).json({ error: "Bot tidak ditemukan" });
    res.json(bot.getLogs(limit));
  });

  return router;
};
