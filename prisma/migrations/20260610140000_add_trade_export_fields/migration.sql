-- Trade export data-integrity fields (BUG-001 / BUG-003 / BUG-004).
--
-- NOTE: persistensi runtime engine memakai tabel lowercase "trades" (dikelola
-- SCHEMA_SQL di src/infrastructure/db/database.js), BUKAN tabel Prisma "Trade".
-- Migration ini menambah kolom yang sama agar history migrasi konsisten dengan
-- skema runtime. Semua statement idempotent (IF NOT EXISTS / DO-guarded).
--
-- Fresh Prisma-only DBs may not have engine tables yet (created on first boot).
-- Bootstrap minimal schema here so migrate deploy succeeds on empty dev DBs.

CREATE TABLE IF NOT EXISTS bot_sessions (
    id              SERIAL PRIMARY KEY,
    user_id         TEXT,
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
    session_id   INTEGER REFERENCES bot_sessions(id) ON DELETE SET NULL,
    exchange     TEXT    NOT NULL DEFAULT '',
    symbol       TEXT    NOT NULL DEFAULT '',
    side         TEXT    NOT NULL DEFAULT '',
    entry_price  DOUBLE PRECISION NOT NULL DEFAULT 0,
    exit_price   DOUBLE PRECISION,
    sl           DOUBLE PRECISION,
    tp           DOUBLE PRECISION,
    size         DOUBLE PRECISION,
    pnl          DOUBLE PRECISION,
    pnl_pct      DOUBLE PRECISION,
    reason       TEXT,
    open_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
    close_time   TIMESTAMPTZ,
    atr          DOUBLE PRECISION,
    dry_run      INTEGER DEFAULT 1,
    order_id     TEXT,
    indicators   TEXT
);

-- BUG-001: strategi di-denormalisasi langsung di trade record saat OPEN.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS strategy_name TEXT;

-- BUG-003: status trade — 'open' | 'closed' | 'cancelled' (zero-fill ghost).
ALTER TABLE trades ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';

-- BUG-001/004: penanda trade partial-exit.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_partial INTEGER DEFAULT 0;

-- Index untuk filter status (mis. exclude cancelled di win-rate).
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- Backfill status untuk baris lama: tertutup → 'closed', kecuali zero-fill
-- (exit == entry & pnl == 0) → 'cancelled'; sisanya tetap 'open'.
UPDATE trades
   SET status = CASE
     WHEN close_time IS NULL OR pnl IS NULL THEN 'open'
     WHEN exit_price IS NOT NULL AND exit_price = entry_price AND pnl = 0 THEN 'cancelled'
     ELSE 'closed'
   END
 WHERE status IS NULL OR status = 'open';
