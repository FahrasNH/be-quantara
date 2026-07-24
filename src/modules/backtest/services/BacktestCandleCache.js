/**
 * BacktestCandleCache — immutable in-process candle pool for backtest sessions.
 *
 * Key: {exchange}:{symbol}:{timeframe} (full series, slice on date range).
 * Survives multiple fetches within the same Node process (multi-TF job, warm worker).
 * Cross-process sharing falls through to PostgreSQL candle_cache (SSOT OHLC archive).
 * Partial hits expose missingRanges so HistoricalKlinesService fetches only gaps.
 */

"use strict";

const CANDLE_INTERVAL_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "12h": 43_200_000, "1d": 86_400_000, "1w": 604_800_000,
};

const MIN_SLICE_COVERAGE = 0.85;
const MAX_POOL_ENTRIES = Number(process.env.BACKTEST_CANDLE_POOL_ENTRIES) || 24;
const POOL_SESSION_TTL_MS = Number(process.env.BACKTEST_CANDLE_POOL_TTL_MS) || 30 * 60_000;

function dedupeByTs(candles) {
  const byTs = new Map();
  for (const c of candles || []) {
    if (!Number.isFinite(c?.timestamp)) continue;
    byTs.set(c.timestamp, c);
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

function coverageRatio(candles, startMs, endMs, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs || !candles?.length) return 0;
  const expected = Math.max(1, Math.floor((endMs - startMs) / tfMs));
  return candles.length / expected;
}

function findMissingRanges(candles, startMs, endMs, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs) return [{ startMs, endMs }];
  if (!candles?.length) return [{ startMs, endMs }];

  const sorted = dedupeByTs(candles);
  const ranges = [];

  if (sorted[0].timestamp > startMs + tfMs * 0.5) {
    ranges.push({ startMs, endMs: sorted[0].timestamp - tfMs });
  }

  const last = sorted[sorted.length - 1];
  if (last.timestamp < endMs - tfMs * 0.5) {
    ranges.push({ startMs: last.timestamp + tfMs, endMs });
  }

  return ranges.length ? ranges : [];
}

class BacktestCandleCache {
  constructor() {
    /** @type {Map<string, { candlesByTs: Map<number, object>, minTs: number, maxTs: number, lastAccessMs: number, lastFetchMs: number, listingMs?: number }>} */
    this.pool = new Map();
    this.stats = { hits: 0, misses: 0, partials: 0, merges: 0, entries: 0 };
  }

  seriesKey(exchange, symbol, timeframe) {
    return `${String(exchange).toLowerCase()}:${String(symbol).toUpperCase()}:${String(timeframe).toLowerCase()}`;
  }

  _touchEntry(key) {
    const entry = this.pool.get(key);
    if (!entry) return null;
    if (Date.now() - entry.lastAccessMs > POOL_SESSION_TTL_MS) {
      this.pool.delete(key);
      return null;
    }
    entry.lastAccessMs = Date.now();
    return entry;
  }

  _evictIfNeeded() {
    if (this.pool.size < MAX_POOL_ENTRIES) return;
    let oldestKey;
    let oldestAccess = Infinity;
    for (const [k, v] of this.pool) {
      if (v.lastAccessMs < oldestAccess) {
        oldestAccess = v.lastAccessMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) this.pool.delete(oldestKey);
  }

  _slice(entry, startMs, endMs) {
    const out = [];
    for (const c of entry.candlesByTs.values()) {
      if (c.timestamp >= startMs && c.timestamp <= endMs) out.push(c);
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
  }

  _recomputeBounds(entry) {
    if (!entry.candlesByTs.size) {
      entry.minTs = 0;
      entry.maxTs = 0;
      return;
    }
    let minTs = Infinity;
    let maxTs = -Infinity;
    for (const ts of entry.candlesByTs.keys()) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    entry.minTs = minTs;
    entry.maxTs = maxTs;
  }

  /**
   * Try to satisfy a range from the in-process pool.
   * @returns {null | { hit: true, candles, coverage, source } | { hit: false, partial: true, candles, coverage, missingRanges }}
   */
  tryGet(exchange, symbol, timeframe, startMs, endMs) {
    const key = this.seriesKey(exchange, symbol, timeframe);
    const entry = this._touchEntry(key);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }

    const sliced = this._slice(entry, startMs, endMs);
    const coverage = coverageRatio(sliced, startMs, endMs, timeframe);
    if (coverage >= MIN_SLICE_COVERAGE) {
      this.stats.hits += 1;
      return { hit: true, candles: sliced, coverage, source: "session-pool" };
    }

    this.stats.partials += 1;
    return {
      hit: false,
      partial: true,
      candles: sliced,
      coverage,
      missingRanges: findMissingRanges(sliced, startMs, endMs, timeframe),
    };
  }

  /** Merge fetched candles into the immutable pool (dedupe by timestamp). */
  merge(exchange, symbol, timeframe, candles, meta = {}) {
    if (!candles?.length) return;
    const key = this.seriesKey(exchange, symbol, timeframe);
    let entry = this._touchEntry(key);
    if (!entry) {
      this._evictIfNeeded();
      entry = {
        candlesByTs: new Map(),
        minTs: 0,
        maxTs: 0,
        lastAccessMs: Date.now(),
        lastFetchMs: Date.now(),
        listingMs: meta.listingMs,
      };
      this.pool.set(key, entry);
    }

    for (const c of candles) {
      if (!Number.isFinite(c?.timestamp)) continue;
      entry.candlesByTs.set(c.timestamp, c);
    }
    if (Number.isFinite(meta.listingMs)) entry.listingMs = meta.listingMs;
    entry.lastAccessMs = Date.now();
    entry.lastFetchMs = Date.now();
    this._recomputeBounds(entry);
    this.stats.merges += 1;
    this.stats.entries = this.pool.size;
  }

  getListingMs(exchange, symbol, timeframe) {
    const entry = this._touchEntry(this.seriesKey(exchange, symbol, timeframe));
    return entry?.listingMs ?? null;
  }

  clear() {
    this.pool.clear();
    this.stats = { hits: 0, misses: 0, partials: 0, merges: 0, entries: 0 };
  }

  getStats() {
    return { ...this.stats, entries: this.pool.size };
  }
}

const singleton = new BacktestCandleCache();

module.exports = singleton;
module.exports.BacktestCandleCache = BacktestCandleCache;
module.exports.MIN_SLICE_COVERAGE = MIN_SLICE_COVERAGE;
module.exports._coverageRatio = coverageRatio;
module.exports._findMissingRanges = findMissingRanges;
