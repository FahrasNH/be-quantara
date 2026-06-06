// ─────────────────────────────────────────────
// database.js — Quantara PostgreSQL Database
// Persistensi: trades, sessions, equity, logs (engine bot)
// Async API (node-postgres). Panggil await db.init() sebelum server.listen.
// ─────────────────────────────────────────────

const { Pool, types } = require("pg");

// int8 (BIGINT, OID 20) default-nya di-parse jadi string oleh pg untuk
// menghindari overflow. Timestamp candle (ms epoch) & COUNT(*) muat di
// JS safe integer, jadi paksa parseInt agar konsisten dgn perilaku SQLite.
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────
// INISIALISASI TABEL (dipanggil eksplisit via init())
// ─────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS bot_sessions (
    id              SERIAL PRIMARY KEY,
    exchange        TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,
    mode            TEXT    NOT NULL DEFAULT 'dry_run',
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at      TIMESTAMPTZ,
    initial_capital DOUBLE PRECISION DEFAULT 0,
    final_capital   DOUBLE PRECISION DEFAULT 0,
    total_trades    INTEGER DEFAULT 0,
    wins            INTEGER DEFAULT 0,
    losses          INTEGER DEFAULT 0,
    config          TEXT
  );

  CREATE TABLE IF NOT EXISTS trades (
    id           SERIAL PRIMARY KEY,
    session_id   INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    exchange     TEXT    NOT NULL,
    symbol       TEXT    NOT NULL,
    side         TEXT    NOT NULL,
    entry_price  DOUBLE PRECISION NOT NULL,
    exit_price   DOUBLE PRECISION,
    sl           DOUBLE PRECISION,
    tp           DOUBLE PRECISION,
    size         DOUBLE PRECISION,
    pnl          DOUBLE PRECISION,
    pnl_pct      DOUBLE PRECISION,
    reason       TEXT,
    open_time    TIMESTAMPTZ NOT NULL,
    close_time   TIMESTAMPTZ,
    atr          DOUBLE PRECISION,
    dry_run      INTEGER DEFAULT 1,
    order_id     TEXT,
    indicators   TEXT
  );

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id             SERIAL PRIMARY KEY,
    session_id     INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
    capital        DOUBLE PRECISION NOT NULL,
    price          DOUBLE PRECISION,
    open_positions INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS candle_cache (
    exchange   TEXT   NOT NULL,
    symbol     TEXT   NOT NULL,
    "interval" TEXT   NOT NULL,
    timestamp  BIGINT NOT NULL,
    open       DOUBLE PRECISION,
    high       DOUBLE PRECISION,
    low        DOUBLE PRECISION,
    close      DOUBLE PRECISION,
    volume     DOUBLE PRECISION,
    cached_at  BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
    PRIMARY KEY (exchange, symbol, "interval", timestamp)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         SERIAL PRIMARY KEY,
    session_id INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    timestamp  TIMESTAMPTZ NOT NULL DEFAULT now(),
    level      TEXT NOT NULL,
    message    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS backtest_history (
    id            SERIAL PRIMARY KEY,
    symbol        TEXT NOT NULL,
    timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
    metrics       TEXT NOT NULL,
    equity_curve  TEXT,
    trades_data   TEXT,
    config        TEXT,
    notes         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trades_session   ON trades(session_id);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol    ON trades(symbol, open_time DESC);
  CREATE INDEX IF NOT EXISTS idx_trades_close     ON trades(session_id, close_time);
  CREATE INDEX IF NOT EXISTS idx_equity_session   ON equity_snapshots(session_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_logs_session     ON logs(session_id);
  CREATE INDEX IF NOT EXISTS idx_candle_lookup    ON candle_cache(exchange, symbol, "interval", timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_candle_cache_at  ON candle_cache(cached_at);
  CREATE INDEX IF NOT EXISTS idx_backtest_symbol  ON backtest_history(symbol, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_backtest_time    ON backtest_history(timestamp DESC);
`;

/**
 * Buat tabel + index, lalu jalankan startup repair untuk sinkronkan stats sesi
 * dengan trade records aktual. Harus dipanggil & di-await sebelum server.listen.
 */
async function init() {
  await pool.query(SCHEMA_SQL);

  // Startup repair: perbaiki bug cross-session (trade buka di sesi A, tutup di B)
  try {
    const { rows: allSessions } = await pool.query(
      `SELECT id, initial_capital, wins, losses, total_trades FROM bot_sessions`
    );
    for (const s of allSessions) {
      const { rows } = await pool.query(
        `SELECT pnl FROM trades WHERE session_id = $1 AND close_time IS NOT NULL AND pnl IS NOT NULL`,
        [s.id]
      );
      if (rows.length === 0) {
        // Belum ada trade yang close (mis. hanya posisi terbuka). Pastikan
        // final_capital = initial_capital agar tidak tampil "Modal Akhir $0".
        const init = s.initial_capital || 0;
        if ((s.final_capital || 0) !== init) {
          await pool.query(
            `UPDATE bot_sessions SET final_capital = $2 WHERE id = $1`,
            [s.id, init]
          );
        }
        continue;
      }
      const wins     = rows.filter((r) => r.pnl > 0).length;
      const losses   = rows.filter((r) => r.pnl <= 0).length;
      const totalPnL = rows.reduce((sum, r) => sum + r.pnl, 0);
      const finalCap = (s.initial_capital || 0) + totalPnL;
      const mismatch = s.wins !== wins || s.losses !== losses || s.total_trades !== rows.length;
      if (mismatch) {
        await pool.query(
          `UPDATE bot_sessions SET wins=$2, losses=$3, total_trades=$4, final_capital=$5 WHERE id=$1`,
          [s.id, wins, losses, rows.length, finalCap]
        );
        console.log(`[DB repair] Sesi #${s.id}: wins ${s.wins}→${wins}, losses ${s.losses}→${losses}, total ${s.total_trades}→${rows.length}, finalCap $${finalCap.toFixed(2)}`);
      }
    }
  } catch (e) {
    console.warn(`[DB repair] Gagal: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

// ── Sessions ──────────────────────────────────

async function openSession({ exchange, symbol, mode, initialCapital, config }) {
  // final_capital diseed = initial_capital. Tanpa ini, kolom default 0 dan baru
  // terisi saat ada trade CLOSE — sehingga sesi yang masih punya posisi terbuka
  // saja menampilkan "Modal Akhir $0" yang keliru.
  const initCap = initialCapital ?? 0;
  const { rows } = await pool.query(
    `INSERT INTO bot_sessions (exchange, symbol, mode, initial_capital, final_capital, config)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
    [
      exchange,
      symbol,
      mode || (config?.dryRun ? "dry_run" : "live"),
      initCap,
      JSON.stringify(config ?? {}),
    ]
  );
  return rows[0].id;
}

/**
 * Cari sesi terakhir yang masih terbuka (stopped_at IS NULL) untuk resume
 * @returns {Promise<object|null>} session row atau null
 */
async function getLastOpenSession(exchange, symbol) {
  const { rows } = await pool.query(
    `SELECT * FROM bot_sessions
     WHERE exchange = $1 AND symbol = $2 AND stopped_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [exchange, symbol]
  );
  return rows[0] ? parseSession(rows[0]) : null;
}

async function closeSession(sessionId, { finalCapital, totalTrades, wins, losses }) {
  await pool.query(
    `UPDATE bot_sessions
     SET stopped_at = now(), final_capital = $2, total_trades = $3, wins = $4, losses = $5
     WHERE id = $1`,
    [sessionId, finalCapital ?? 0, totalTrades ?? 0, wins ?? 0, losses ?? 0]
  );
}

/**
 * Update stats sesi tanpa menutupnya (stopped_at tetap NULL).
 * Fire-and-forget: dipanggil dari konteks sync, jadi tangani error internal.
 */
async function updateSessionStats(sessionId, { finalCapital, totalTrades, wins, losses }) {
  try {
    await pool.query(
      `UPDATE bot_sessions
       SET final_capital = $2, total_trades = $3, wins = $4, losses = $5
       WHERE id = $1`,
      [sessionId, finalCapital ?? 0, totalTrades ?? 0, wins ?? 0, losses ?? 0]
    );
  } catch (e) {
    console.warn(`[DB] updateSessionStats gagal: ${e.message}`);
  }
}

/**
 * Hitung ulang stats sesi dari trade records aktual di DB.
 * Fire-and-forget best-effort — tidak boleh crash caller.
 */
async function recalcSessionStats(sessionId) {
  if (!sessionId) return;
  try {
    const { rows: sRows } = await pool.query(`SELECT * FROM bot_sessions WHERE id = $1`, [sessionId]);
    const session = sRows[0];
    if (!session) return;
    const { rows: trades } = await pool.query(
      `SELECT pnl FROM trades WHERE session_id = $1 AND close_time IS NOT NULL AND pnl IS NOT NULL`,
      [sessionId]
    );
    const wins     = trades.filter((t) => t.pnl > 0).length;
    const losses   = trades.filter((t) => t.pnl <= 0).length;
    const total    = trades.length;
    const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    const finalCap = (session.initial_capital || 0) + totalPnL;
    await pool.query(
      `UPDATE bot_sessions SET final_capital = $2, total_trades = $3, wins = $4, losses = $5 WHERE id = $1`,
      [sessionId, finalCap, total, wins, losses]
    );
  } catch (e) {
    console.warn(`[DB] recalcSessionStats gagal: ${e.message}`);
  }
}

const SESSIONS_BASE = `
  SELECT
    s.*,
    COALESCE(t.actual_pnl,    0) AS actual_pnl,
    COALESCE(t.actual_wins,   0) AS actual_wins,
    COALESCE(t.actual_losses, 0) AS actual_losses,
    COALESCE(t.actual_total,  0) AS actual_total
  FROM bot_sessions s
  LEFT JOIN (
    SELECT
      session_id,
      SUM(pnl)                                   AS actual_pnl,
      SUM(CASE WHEN pnl > 0  THEN 1 ELSE 0 END)  AS actual_wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END)  AS actual_losses,
      COUNT(*)                                   AS actual_total
    FROM trades
    WHERE close_time IS NOT NULL AND pnl IS NOT NULL
    GROUP BY session_id
  ) t ON t.session_id = s.id`;

/**
 * @param {number}      limit  — max session yang dikembalikan (default 20)
 * @param {string|null} symbol — filter per simbol (null = semua)
 */
async function getSessions(limit = 20, symbol = null) {
  if (symbol) {
    const { rows } = await pool.query(
      `${SESSIONS_BASE} WHERE s.symbol = $1 ORDER BY s.started_at DESC LIMIT $2`,
      [symbol.toUpperCase(), limit]
    );
    return rows.map(parseSession);
  }
  const { rows } = await pool.query(
    `${SESSIONS_BASE} ORDER BY s.started_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(parseSession);
}

async function getSession(id) {
  const { rows } = await pool.query(`SELECT * FROM bot_sessions WHERE id = $1`, [id]);
  return rows[0] ? parseSession(rows[0]) : null;
}

function parseSession(row) {
  return { ...row, config: safeParseJSON(row.config) };
}

// ── Trades ────────────────────────────────────

async function insertTrade({ sessionId, exchange, symbol, side, entryPrice, sl, tp, size, openTime, atr, dryRun, orderId, indicators }) {
  const { rows } = await pool.query(
    `INSERT INTO trades
       (session_id, exchange, symbol, side, entry_price, sl, tp, size, open_time, atr, dry_run, order_id, indicators)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      sessionId,
      exchange,
      symbol,
      side,
      entryPrice,
      sl ?? null,
      tp ?? null,
      size ?? null,
      openTime ? new Date(openTime).toISOString() : new Date().toISOString(),
      atr ?? null,
      dryRun ? 1 : 0,
      orderId ?? null,
      indicators ? JSON.stringify(indicators) : null,
    ]
  );
  return rows[0].id;
}

async function closeTrade(tradeId, { exitPrice, pnl, reason, closeTime }) {
  await pool.query(
    `UPDATE trades
     SET exit_price = $2, pnl = $3, pnl_pct = $4, reason = $5, close_time = $6
     WHERE id = $1`,
    [
      tradeId,
      exitPrice,
      pnl,
      null,
      reason,
      closeTime ? new Date(closeTime).toISOString() : new Date().toISOString(),
    ]
  );
}

async function getTrades({ sessionId = null, symbol = null, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM trades
     WHERE ($1::int IS NULL OR session_id = $1)
       AND ($2::text IS NULL OR symbol = $2)
     ORDER BY open_time DESC
     LIMIT $3`,
    [sessionId, symbol, Math.min(limit, 1000)]
  );
  return rows;
}

async function getTradeStats(sessionId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
       SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) AS losses,
       SUM(pnl) AS total_pnl,
       AVG(pnl) AS avg_pnl,
       MAX(pnl) AS best_trade,
       MIN(pnl) AS worst_trade
     FROM trades
     WHERE session_id = $1 AND close_time IS NOT NULL`,
    [sessionId]
  );
  return rows[0];
}

async function getOpenTrades(sessionId) {
  const { rows } = await pool.query(
    `SELECT * FROM trades WHERE session_id = $1 AND close_time IS NULL`,
    [sessionId]
  );
  return rows;
}

/**
 * Export data trade lengkap dengan snapshot indikator — untuk analitik / ML.
 * Hanya trade yang sudah tertutup (punya exit_price dan pnl).
 */
async function getInsights({ symbol = null, dryRun = null, limit = 500 } = {}) {
  let where = `close_time IS NOT NULL AND indicators IS NOT NULL`;
  const params = [];
  let i = 1;
  if (symbol) { where += ` AND symbol = $${i++}`; params.push(symbol); }
  if (dryRun !== null) { where += ` AND dry_run = $${i++}`; params.push(dryRun ? 1 : 0); }
  params.push(Math.min(limit, 5000));

  const { rows } = await pool.query(
    `SELECT t.*, s.mode, s.exchange AS _exchange
     FROM trades t
     LEFT JOIN bot_sessions s ON s.id = t.session_id
     WHERE ${where}
     ORDER BY t.open_time DESC
     LIMIT $${i}`,
    params
  );

  return rows.map((row) => {
    const ind = safeParseJSON(row.indicators);
    return {
      rsi:          ind.rsi          ?? null,
      atr:          ind.atr          ?? null,
      atrPct:       ind.atrPct       ?? null,
      volumeRatio:  ind.volumeRatio  ?? null,
      emaFast:      ind.emaFast      ?? null,
      emaSlow:      ind.emaSlow      ?? null,
      emaTrendBias: ind.emaTrendBias ?? null,
      htfTrend:     ind.htfTrend     ?? null,
      strategy:     ind.strategy     ?? null,
      side:         row.side,
      symbol:       row.symbol,
      entryPrice:   row.entry_price,
      exitPrice:    row.exit_price,
      sl:           row.sl,
      tp:           row.tp,
      size:         row.size,
      pnl:          row.pnl,
      pnlPct:       row.pnl_pct,
      reason:       row.reason,
      dryRun:       row.dry_run === 1,
      openTime:     row.open_time,
      closeTime:    row.close_time,
      result:       row.pnl > 0 ? "win" : "loss",
      rMultiple:    row.sl && row.entry_price ? parseFloat(((row.exit_price - row.entry_price) / Math.abs(row.entry_price - row.sl)).toFixed(2)) : null,
    };
  });
}

/**
 * Ambil semua posisi terbuka (close_time IS NULL) untuk symbol tertentu,
 * lintas SEMUA sesi — digunakan saat bot restart untuk restore posisi lama.
 */
async function getOpenTradesBySymbol(symbol) {
  const { rows } = await pool.query(
    `SELECT t.*, s.exchange AS _exchange
     FROM trades t
     JOIN bot_sessions s ON s.id = t.session_id
     WHERE t.symbol = $1 AND t.close_time IS NULL
     ORDER BY t.open_time ASC`,
    [symbol]
  );
  return rows;
}

// ── Equity ────────────────────────────────────

/** Fire-and-forget best-effort — tidak boleh crash caller. */
async function snapshotEquity({ sessionId, capital, price, openPositions }) {
  try {
    await pool.query(
      `INSERT INTO equity_snapshots (session_id, capital, price, open_positions)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, capital, price ?? null, openPositions ?? 0]
    );
  } catch (e) {
    console.warn(`[DB] snapshotEquity gagal: ${e.message}`);
  }
}

async function getEquity(sessionId) {
  const { rows } = await pool.query(
    `SELECT timestamp, capital, price, open_positions
     FROM equity_snapshots
     WHERE session_id = $1
     ORDER BY timestamp ASC`,
    [sessionId]
  );
  return rows;
}

/**
 * Semua equity snapshot dari SEMUA sesi, diurutkan waktu (kurva akumulatif).
 * Opsional filter by mode ("live" | "dry_run").
 */
async function getAllEquity(mode = "live") {
  const modeFilter = mode ? "AND bs.mode = $1" : "";
  const params     = mode ? [mode] : [];
  const { rows } = await pool.query(
    `SELECT es.timestamp, es.capital, es.price, es.open_positions, bs.symbol, bs.mode
     FROM equity_snapshots es
     JOIN bot_sessions bs ON bs.id = es.session_id
     WHERE 1=1 ${modeFilter}
     ORDER BY es.timestamp ASC`,
    params
  );
  return rows;
}

// ── Candle cache ──────────────────────────────

/** Fire-and-forget best-effort — upsert dalam transaksi. */
async function cacheCandles(exchange, symbol, interval, candles) {
  if (!candles || candles.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of candles) {
      await client.query(
        `INSERT INTO candle_cache
           (exchange, symbol, "interval", timestamp, open, high, low, close, volume, cached_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, extract(epoch from now())::bigint)
         ON CONFLICT (exchange, symbol, "interval", timestamp)
         DO UPDATE SET
           open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
           close = EXCLUDED.close, volume = EXCLUDED.volume, cached_at = EXCLUDED.cached_at`,
        [exchange, symbol, interval, c.timestamp, c.open, c.high, c.low, c.close, c.volume ?? 0]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* noop */ }
    console.warn(`[DB] cacheCandles gagal: ${e.message}`);
  } finally {
    client.release();
  }
}

async function getCachedCandles(exchange, symbol, interval, maxAgeSeconds = 900) {
  const { rows } = await pool.query(
    `SELECT * FROM candle_cache
     WHERE exchange = $1 AND symbol = $2 AND "interval" = $3
       AND cached_at > extract(epoch from now())::bigint - $4
     ORDER BY timestamp ASC`,
    [exchange, symbol, interval, maxAgeSeconds]
  );
  if (rows.length === 0) return null;
  return rows.map((r) => ({
    timestamp: r.timestamp,
    date:      new Date(r.timestamp).toISOString(),
    open:      r.open,
    high:      r.high,
    low:       r.low,
    close:     r.close,
    volume:    r.volume,
  }));
}

async function clearOldCache() {
  await pool.query(
    `DELETE FROM candle_cache WHERE cached_at < extract(epoch from now())::bigint - 86400`
  );
}

// ── Logs ──────────────────────────────────────

/** Fire-and-forget best-effort — tidak boleh crash caller. */
async function insertLog({ sessionId, level, message }) {
  try {
    await pool.query(
      `INSERT INTO logs (session_id, level, message) VALUES ($1, $2, $3)`,
      [sessionId ?? null, level, message]
    );
  } catch (e) {
    console.warn(`[DB] insertLog gagal: ${e.message}`);
  }
}

async function getLogs(sessionId, limit = 200) {
  const { rows } = await pool.query(
    `SELECT * FROM logs WHERE session_id = $1 ORDER BY timestamp DESC LIMIT $2`,
    [sessionId, limit]
  );
  return rows;
}

// ── User Settings ─────────────────────────────

async function getSetting(key, defaultValue = null) {
  const { rows } = await pool.query(`SELECT value FROM user_settings WHERE key = $1`, [key]);
  return rows[0] ? rows[0].value : defaultValue;
}

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO user_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, String(value)]
  );
}

// ── Backtest History ──────────────────────────

async function insertBacktestHistory({ symbol, metrics, equityCurve, tradesData, config, notes }) {
  const { rows } = await pool.query(
    `INSERT INTO backtest_history (symbol, metrics, equity_curve, trades_data, config, notes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      symbol.toUpperCase(),
      JSON.stringify(metrics),
      equityCurve ? JSON.stringify(equityCurve) : null,
      tradesData ? JSON.stringify(tradesData) : null,
      config ? JSON.stringify(config) : null,
      notes ?? null,
    ]
  );
  return rows[0].id;
}

async function getBacktestHistory(symbol, limit = 20) {
  const { rows } = await pool.query(
    `SELECT * FROM backtest_history WHERE symbol = $1 ORDER BY timestamp DESC LIMIT $2`,
    [symbol.toUpperCase(), limit]
  );
  return rows.map(mapBacktestRow);
}

async function getAllBacktestHistory(limit = 50) {
  const { rows } = await pool.query(
    `SELECT * FROM backtest_history ORDER BY timestamp DESC LIMIT $1`,
    [limit]
  );
  return rows.map(mapBacktestRow);
}

async function getBacktestHistoryById(id) {
  const { rows } = await pool.query(`SELECT * FROM backtest_history WHERE id = $1`, [id]);
  return rows[0] ? mapBacktestRow(rows[0]) : null;
}

function mapBacktestRow(row) {
  return {
    ...row,
    metrics:      safeParseJSON(row.metrics),
    equity_curve: safeParseJSON(row.equity_curve),
    trades_data:  safeParseJSON(row.trades_data),
    config:       safeParseJSON(row.config),
  };
}

// ── Utils ─────────────────────────────────────

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function getDbPath() { return process.env.DATABASE_URL || "postgres"; }

async function close() {
  await pool.end();
}

// Export
module.exports = {
  // lifecycle
  init,
  close,
  // sessions
  getLastOpenSession,
  openSession,
  closeSession,
  updateSessionStats,
  getSessions,
  getSession,
  // trades
  insertTrade,
  closeTrade,
  getTrades,
  getTradeStats,
  getOpenTrades,
  getOpenTradesBySymbol,
  getInsights,
  recalcSessionStats,
  // equity
  snapshotEquity,
  getEquity,
  getAllEquity,
  // candles
  cacheCandles,
  getCachedCandles,
  clearOldCache,
  // logs
  insertLog,
  getLogs,
  // user settings
  getSetting,
  setSetting,
  // backtest history
  insertBacktestHistory,
  getBacktestHistory,
  getAllBacktestHistory,
  getBacktestHistoryById,
  // meta
  getDbPath,
  _pool: pool,
};
