/**
 * Causal MTF candle builder for Trend Following.
 *
 * The caller evaluates an entry candle at its close.  A higher MTF candle is
 * usable only after the entry candle reaches that MTF bucket's end; otherwise
 * the index points to the previous completed MTF candle.  This keeps the
 * Donchian layer free from forming-bar lookahead.
 */

"use strict";

const INTERVAL_MS = Object.freeze({
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
});

function intervalToMs(interval) {
  if (Number.isFinite(Number(interval)) && Number(interval) > 0) return Number(interval);
  return INTERVAL_MS[String(interval || "").toLowerCase()] || null;
}

function aggregateCandles(candles, intervalMs) {
  const groups = new Map();
  for (const candle of candles || []) {
    const timestamp = Number(candle.timestamp ?? candle.openTime ?? candle.time);
    if (!Number.isFinite(timestamp)) continue;
    const bucket = Math.floor(timestamp / intervalMs) * intervalMs;
    const existing = groups.get(bucket);
    if (!existing) {
      groups.set(bucket, {
        timestamp: bucket,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume) || 0,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume) || 0;
  }
  return [...groups.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * @returns {{ candles: object[], indexByEntry: number[], entryIntervalMs: number, mtfIntervalMs: number }|null}
 */
function buildTrendFollowingMtfContext(entryCandles, { entryInterval, mtfInterval } = {}) {
  const entryIntervalMs = intervalToMs(entryInterval);
  const mtfIntervalMs = intervalToMs(mtfInterval);
  if (!entryCandles?.length || !entryIntervalMs || !mtfIntervalMs) return null;
  if (mtfIntervalMs < entryIntervalMs) return null;

  const candles = aggregateCandles(entryCandles, mtfIntervalMs);
  const indexByBucket = new Map(candles.map((c, i) => [c.timestamp, i]));
  const indexByEntry = entryCandles.map((c) => {
    const timestamp = Number(c.timestamp ?? c.openTime ?? c.time);
    if (!Number.isFinite(timestamp)) return -1;
    const bucket = Math.floor(timestamp / mtfIntervalMs) * mtfIntervalMs;
    const bucketIndex = indexByBucket.get(bucket);
    if (bucketIndex == null) return -1;

    // Entry candles are timestamped at their open.  At the last entry bar in
    // the bucket, its close reaches the MTF close; earlier bars must use the
    // previous completed MTF candle.
    const entryClose = timestamp + entryIntervalMs;
    return entryClose >= bucket + mtfIntervalMs ? bucketIndex : bucketIndex - 1;
  });

  return { candles, indexByEntry, entryIntervalMs, mtfIntervalMs };
}

module.exports = {
  INTERVAL_MS,
  intervalToMs,
  aggregateCandles,
  buildTrendFollowingMtfContext,
};
