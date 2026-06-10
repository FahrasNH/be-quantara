-- Trade export data-integrity fields (BUG-001 / BUG-003 / BUG-004).
--
-- NOTE: persistensi runtime engine memakai tabel lowercase "trades" (dikelola
-- SCHEMA_SQL di src/infrastructure/db/database.js), BUKAN tabel Prisma "Trade".
-- Migration ini menambah kolom yang sama agar history migrasi konsisten dengan
-- skema runtime. Semua statement idempotent (IF NOT EXISTS / DO-guarded).

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
