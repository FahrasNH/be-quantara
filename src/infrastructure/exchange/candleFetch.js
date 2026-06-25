// ─────────────────────────────────────────────────────────────────────────────
// candleFetch.js — cache DB + global rate gate untuk OHLCV
// ─────────────────────────────────────────────────────────────────────────────

const db = require("../db/database");

const LTF_CACHE_TTL = 900;  // 15 menit — selaras _fetchCandles lama
const HTF_CACHE_TTL = 600;  // 10 menit — HTF 1h tidak perlu refresh tiap tick

/**
 * Ambil candle: cache fresh → exchange (throttled) → cache stale.
 * @param {object} client — BitgetClient | CcxtFuturesClient
 * @param {object} opts
 * @returns {Promise<object[]>}
 */
async function fetchCandlesWithCache(client, opts) {
  const {
    exchange = "bitget",
    symbol,
    interval,
    limit = 200,
    cacheTtlSeconds = LTF_CACHE_TTL,
    minBars = 1,
    since,
  } = opts;

  if (!client?.getCandles) throw new Error("fetchCandlesWithCache: client tanpa getCandles");

  const minRequired = Math.max(minBars, 1);
  const tf = String(interval || "15m").toLowerCase();

  try {
    const cached = await db.getCachedCandles(exchange, symbol, tf, cacheTtlSeconds);
    if (cached && cached.length >= minRequired) return cached;
  } catch { /* cache miss OK */ }

  const candles = await client.getCandles(symbol, tf, limit, since);

  if (candles?.length) {
    db.cacheCandles(exchange, symbol, tf, candles).catch(() => {});
  }
  if (candles && candles.length >= minRequired) return candles;

  try {
    const stale = await db.getCachedCandles(exchange, symbol, tf, 86_400);
    if (stale && stale.length >= minRequired) return stale;
  } catch { /* */ }

  if (candles?.length) return candles;
  throw new Error(`fetchCandlesWithCache: insufficient candles for ${symbol} ${tf}`);
}

module.exports = { fetchCandlesWithCache, LTF_CACHE_TTL, HTF_CACHE_TTL };
