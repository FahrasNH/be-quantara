-- Archive OHLC-only refactor (Sprint 24): drop result bloat table.
-- OHLC SSOT remains candle_cache (universal, not per-user).

DROP TABLE IF EXISTS backtest_history CASCADE;
