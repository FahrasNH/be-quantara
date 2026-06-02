// ─────────────────────────────────────────────
// db.js — Quantara SQLite Database
// Persistensi: trades, sessions, equity, logs
// Gunakan: const db = require('./db')
// ─────────────────────────────────────────────

const Database = require("better-sqlite3");
const path     = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "quantara.db");

// Buka / buat database
const db = new Database(DB_PATH);

// Aktifkan WAL mode (lebih cepat untuk write bersamaan read)
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─────────────────────────────────────────────
// INISIALISASI TABEL
// ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange        TEXT    NOT NULL,
    symbol          TEXT    NOT NULL,
    mode            TEXT    NOT NULL DEFAULT 'dry_run',  -- 'live' | 'dry_run'
    started_at      DATETIME NOT NULL DEFAULT (datetime('now')),
    stopped_at      DATETIME,
    initial_capital REAL    DEFAULT 0,
    final_capital   REAL    DEFAULT 0,
    total_trades    INTEGER DEFAULT 0,
    wins            INTEGER DEFAULT 0,
    losses          INTEGER DEFAULT 0,
    config          TEXT                                  -- JSON params strategi
  );

  CREATE TABLE IF NOT EXISTS trades (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    exchange     TEXT    NOT NULL,
    symbol       TEXT    NOT NULL,
    side         TEXT    NOT NULL,   -- 'LONG' | 'SHORT'
    entry_price  REAL    NOT NULL,
    exit_price   REAL,               -- NULL jika masih terbuka
    sl           REAL,
    tp           REAL,
    size         REAL,
    pnl          REAL,               -- NULL jika masih terbuka
    pnl_pct      REAL,
    reason       TEXT,               -- 'TP' | 'SL' | 'Reversal'
    open_time    DATETIME NOT NULL,
    close_time   DATETIME,           -- NULL jika masih terbuka
    atr          REAL,
    dry_run      INTEGER DEFAULT 1,  -- 1 = simulasi, 0 = live
    order_id     TEXT                -- exchange order ID (live only)
  );

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id     INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    timestamp      DATETIME NOT NULL DEFAULT (datetime('now')),
    capital        REAL     NOT NULL,
    price          REAL,
    open_positions INTEGER  DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS candle_cache (
    exchange  TEXT    NOT NULL,
    symbol    TEXT    NOT NULL,
    interval  TEXT    NOT NULL,
    timestamp INTEGER NOT NULL,
    open      REAL,
    high      REAL,
    low       REAL,
    close     REAL,
    volume    REAL,
    cached_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (exchange, symbol, interval, timestamp)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER REFERENCES bot_sessions(id) ON DELETE CASCADE,
    timestamp  DATETIME NOT NULL DEFAULT (datetime('now')),
    level      TEXT     NOT NULL,  -- 'trade' | 'error' | 'warn'
    message    TEXT     NOT NULL
  );

  -- Index untuk query umum
  CREATE INDEX IF NOT EXISTS idx_trades_session   ON trades(session_id);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol    ON trades(symbol, open_time DESC);
  CREATE INDEX IF NOT EXISTS idx_equity_session   ON equity_snapshots(session_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_logs_session     ON logs(session_id);
  CREATE INDEX IF NOT EXISTS idx_candle_lookup    ON candle_cache(exchange, symbol, interval, timestamp DESC);
`);

// ─────────────────────────────────────────────
// PREPARED STATEMENTS
// ─────────────────────────────────────────────

const stmts = {
  // Sessions
  openSession: db.prepare(`
    INSERT INTO bot_sessions (exchange, symbol, mode, initial_capital, config)
    VALUES (@exchange, @symbol, @mode, @initial_capital, @config)
  `),
  closeSession: db.prepare(`
    UPDATE bot_sessions
    SET stopped_at = datetime('now'),
        final_capital = @final_capital,
        total_trades  = @total_trades,
        wins          = @wins,
        losses        = @losses
    WHERE id = @id
  `),
  updateSessionStats: db.prepare(`
    UPDATE bot_sessions
    SET final_capital = @final_capital,
        total_trades  = @total_trades,
        wins          = @wins,
        losses        = @losses
    WHERE id = @id
  `),
  getSession: db.prepare(`SELECT * FROM bot_sessions WHERE id = ?`),
  getSessions: db.prepare(`
    SELECT * FROM bot_sessions ORDER BY started_at DESC LIMIT ?
  `),
  // Cari sesi yang masih terbuka (belum ada stopped_at) untuk resume
  getLastOpenSession: db.prepare(`
    SELECT * FROM bot_sessions
    WHERE exchange = ? AND symbol = ? AND stopped_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `),

  // Trades
  insertTrade: db.prepare(`
    INSERT INTO trades
      (session_id, exchange, symbol, side, entry_price, sl, tp, size, open_time, atr, dry_run, order_id)
    VALUES
      (@session_id, @exchange, @symbol, @side, @entry_price, @sl, @tp, @size,
       @open_time, @atr, @dry_run, @order_id)
  `),
  closeTrade: db.prepare(`
    UPDATE trades
    SET exit_price = @exit_price,
        pnl        = @pnl,
        pnl_pct    = @pnl_pct,
        reason     = @reason,
        close_time = @close_time
    WHERE id = @id
  `),
  getTradeByOrderId: db.prepare(`
    SELECT * FROM trades WHERE order_id = ? AND session_id = ?
  `),
  getOpenTrades: db.prepare(`
    SELECT * FROM trades WHERE session_id = ? AND close_time IS NULL
  `),
  // Cari semua posisi terbuka untuk symbol tertentu lintas semua sesi
  getOpenTradesBySymbol: db.prepare(`
    SELECT t.*, s.exchange AS _exchange
    FROM trades t
    JOIN bot_sessions s ON s.id = t.session_id
    WHERE t.symbol = ? AND t.close_time IS NULL
    ORDER BY t.open_time ASC
  `),
  getTrades: db.prepare(`
    SELECT * FROM trades
    WHERE (:session_id IS NULL OR session_id = :session_id)
      AND (:symbol IS NULL OR symbol = :symbol)
    ORDER BY open_time DESC
    LIMIT :limit
  `),
  getTradeStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses,
      SUM(pnl) as total_pnl,
      AVG(pnl) as avg_pnl,
      MAX(pnl) as best_trade,
      MIN(pnl) as worst_trade
    FROM trades
    WHERE session_id = ? AND close_time IS NOT NULL
  `),

  // Equity snapshots
  insertEquity: db.prepare(`
    INSERT INTO equity_snapshots (session_id, capital, price, open_positions)
    VALUES (@session_id, @capital, @price, @open_positions)
  `),
  getEquity: db.prepare(`
    SELECT timestamp, capital, price, open_positions
    FROM equity_snapshots
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `),
  getLatestEquity: db.prepare(`
    SELECT * FROM equity_snapshots WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1
  `),

  // Candle cache
  upsertCandles: db.prepare(`
    INSERT OR REPLACE INTO candle_cache
      (exchange, symbol, interval, timestamp, open, high, low, close, volume, cached_at)
    VALUES
      (@exchange, @symbol, @interval, @timestamp, @open, @high, @low, @close, @volume, unixepoch())
  `),
  getCachedCandles: db.prepare(`
    SELECT * FROM candle_cache
    WHERE exchange = @exchange
      AND symbol   = @symbol
      AND interval = @interval
      AND cached_at > unixepoch() - @max_age_sec
    ORDER BY timestamp ASC
  `),
  clearOldCache: db.prepare(`
    DELETE FROM candle_cache
    WHERE cached_at < unixepoch() - 86400
  `),

  // Logs
  insertLog: db.prepare(`
    INSERT INTO logs (session_id, level, message)
    VALUES (@session_id, @level, @message)
  `),
  getLogs: db.prepare(`
    SELECT * FROM logs
    WHERE session_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `),
};

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

// ── Sessions ──────────────────────────────────

function openSession({ exchange, symbol, mode, initialCapital, config }) {
  const result = stmts.openSession.run({
    exchange,
    symbol,
    mode:            mode || (config?.dryRun ? "dry_run" : "live"),
    initial_capital: initialCapital ?? 0,
    config:          JSON.stringify(config ?? {}),
  });
  return result.lastInsertRowid;
}

/**
 * Cari sesi terakhir yang masih terbuka (stopped_at IS NULL) untuk resume
 * @returns {object|null} session row atau null
 */
function getLastOpenSession(exchange, symbol) {
  const row = stmts.getLastOpenSession.get(exchange, symbol);
  return row ? parseSession(row) : null;
}

function closeSession(sessionId, { finalCapital, totalTrades, wins, losses }) {
  stmts.closeSession.run({
    id:            sessionId,
    final_capital: finalCapital ?? 0,
    total_trades:  totalTrades  ?? 0,
    wins:          wins         ?? 0,
    losses:        losses       ?? 0,
  });
}

/**
 * Update stats sesi tanpa menutupnya (stopped_at tetap NULL)
 * Digunakan saat bot stop tapi masih ada posisi terbuka → sesi bisa di-resume
 */
function updateSessionStats(sessionId, { finalCapital, totalTrades, wins, losses }) {
  stmts.updateSessionStats.run({
    id:            sessionId,
    final_capital: finalCapital ?? 0,
    total_trades:  totalTrades  ?? 0,
    wins:          wins         ?? 0,
    losses:        losses       ?? 0,
  });
}

function getSessions(limit = 20) {
  return stmts.getSessions.all(limit).map(parseSession);
}

function getSession(id) {
  const row = stmts.getSession.get(id);
  return row ? parseSession(row) : null;
}

function parseSession(row) {
  return { ...row, config: safeParseJSON(row.config) };
}

// ── Trades ────────────────────────────────────

function insertTrade({ sessionId, exchange, symbol, side, entryPrice, sl, tp, size, openTime, atr, dryRun, orderId }) {
  const result = stmts.insertTrade.run({
    session_id:  sessionId,
    exchange,
    symbol,
    side,
    entry_price: entryPrice,
    sl:          sl   ?? null,
    tp:          tp   ?? null,
    size:        size ?? null,
    open_time:   openTime ? new Date(openTime).toISOString() : new Date().toISOString(),
    atr:         atr  ?? null,
    dry_run:     dryRun ? 1 : 0,
    order_id:    orderId ?? null,
  });
  return result.lastInsertRowid;
}

function closeTrade(tradeId, { exitPrice, pnl, reason, closeTime }) {
  const pnlPct = null; // calculé en dehors si besoin
  stmts.closeTrade.run({
    id:          tradeId,
    exit_price:  exitPrice,
    pnl,
    pnl_pct:     pnlPct,
    reason,
    close_time:  closeTime ? new Date(closeTime).toISOString() : new Date().toISOString(),
  });
}

function getTrades({ sessionId = null, symbol = null, limit = 100 } = {}) {
  return stmts.getTrades.all({
    session_id: sessionId,
    symbol:     symbol,
    limit:      Math.min(limit, 1000),
  });
}

function getTradeStats(sessionId) {
  return stmts.getTradeStats.get(sessionId);
}

function getOpenTrades(sessionId) {
  return stmts.getOpenTrades.all(sessionId);
}

/**
 * Ambil semua posisi terbuka (close_time IS NULL) untuk symbol tertentu,
 * lintas SEMUA sesi — digunakan saat bot restart untuk restore posisi lama.
 */
function getOpenTradesBySymbol(symbol) {
  return stmts.getOpenTradesBySymbol.all(symbol);
}

// ── Equity ────────────────────────────────────

function snapshotEquity({ sessionId, capital, price, openPositions }) {
  stmts.insertEquity.run({
    session_id:     sessionId,
    capital,
    price:          price         ?? null,
    open_positions: openPositions ?? 0,
  });
}

function getEquity(sessionId) {
  return stmts.getEquity.all(sessionId);
}

// ── Candle cache ──────────────────────────────

function cacheCandles(exchange, symbol, interval, candles) {
  const insert = db.transaction((rows) => {
    for (const c of rows) {
      stmts.upsertCandles.run({
        exchange, symbol, interval,
        timestamp: c.timestamp,
        open:      c.open,
        high:      c.high,
        low:       c.low,
        close:     c.close,
        volume:    c.volume ?? 0,
      });
    }
  });
  insert(candles);
}

function getCachedCandles(exchange, symbol, interval, maxAgeSeconds = 900) {
  const rows = stmts.getCachedCandles.all({ exchange, symbol, interval, max_age_sec: maxAgeSeconds });
  if (rows.length === 0) return null;
  return rows.map(r => ({
    timestamp: r.timestamp,
    date:      new Date(r.timestamp).toISOString(),
    open:      r.open,
    high:      r.high,
    low:       r.low,
    close:     r.close,
    volume:    r.volume,
  }));
}

function clearOldCache() {
  stmts.clearOldCache.run();
}

// ── Logs ──────────────────────────────────────

function insertLog({ sessionId, level, message }) {
  stmts.insertLog.run({ session_id: sessionId ?? null, level, message });
}

function getLogs(sessionId, limit = 200) {
  return stmts.getLogs.all(sessionId, limit);
}

// ── Utils ─────────────────────────────────────

function safeParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

function getDbPath() { return DB_PATH; }

// Export
module.exports = {
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
  // equity
  snapshotEquity,
  getEquity,
  // candles
  cacheCandles,
  getCachedCandles,
  clearOldCache,
  // logs
  insertLog,
  getLogs,
  // meta
  getDbPath,
  _db: db, // ekspor raw db untuk testing / migration
};
