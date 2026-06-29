/**
 * HistoricalKlinesService — OHLCV historis real dari exchange user (Phase 2 backtest).
 *
 * Paginasi via CCXT fetchOHLCV + exchangeRateGate, cache DB + mem TTL,
 * gap-fill bar hilang, clamp rentang ke 2020-01-01 atau listing date.
 */

"use strict";

const ccxt = require("ccxt");
const db = require("../../infrastructure/db/database");
const { withExchangeGate } = require("../../infrastructure/exchange/exchangeRateGate");
const { getConnectedExchange } = require("../../services/ExchangeService");
const { EXCHANGE_META } = require("../../infrastructure/exchange/index");

const SUPPORTED = new Set(["bitget", "okx", "binance"]);

const CCXT_OPTIONS = {
  binance: { defaultType: "future" },
  bitget: { defaultType: "swap", defaultSettle: "USDT" },
  okx: { defaultType: "swap" },
};

const CANDLE_INTERVAL_MS = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "6h": 21_600_000,
  "12h": 43_200_000, "1d": 86_400_000, "1w": 604_800_000,
};

const MIN_HISTORICAL_MS = Date.parse("2020-01-01T00:00:00.000Z");
const PAGE_SIZE = 500;
const PAUSE_MS = 120;
const MEM_CACHE_TTL_MS = Number(process.env.BACKTEST_KLINES_CACHE_TTL_MS) || 3_600_000;
/** Batas bar per request — cegah OOM + timeout gateway pada rentang besar (mis. max × 15m). */
const MAX_BARS = Number(process.env.BACKTEST_KLINES_MAX_BARS) || 50_000;  // v3.3: 20K → 50K (supports ~2 years 1h data)
/** Deadline fetch exchange agar request gagal rapi sebelum nginx 504 (default 240s). */
const FETCH_DEADLINE_MS = Number(process.env.BACKTEST_KLINES_FETCH_DEADLINE_MS) || 240_000;
const MIN_CACHE_COVERAGE = 0.85;

const clientCache = new Map();
const memCache = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getPublicClient(exchangeType) {
  const type = String(exchangeType || "bitget").toLowerCase();
  if (!clientCache.has(type)) {
    const ctor = ccxt[type];
    if (!ctor) throw new Error(`Exchange "${type}" tidak didukung.`);
    clientCache.set(
      type,
      new ctor({ enableRateLimit: true, options: CCXT_OPTIONS[type] || {} })
    );
  }
  return clientCache.get(type);
}

function toMarketSymbol(symbol) {
  const sym = String(symbol || "").toUpperCase().trim();
  if (!sym) throw new Error("symbol diperlukan");
  return sym.includes("/") ? sym : `${sym.replace(/USDT$/, "")}/USDT:USDT`;
}

function normalizeBatch(batch) {
  if (!Array.isArray(batch)) return [];
  return batch
    .filter(c => Array.isArray(c) && Number.isFinite(c[0]))
    .map(c => ({
      timestamp: c[0],
      date: new Date(c[0]).toISOString(),
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]) || 0,
    }));
}

/**
 * Dedup + sort ascending; buang bar dengan OHLC invalid.
 */
function dedupeAndValidate(candles) {
  const byTs = new Map();
  for (const c of candles || []) {
    if (!Number.isFinite(c.timestamp)) continue;
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) continue;
    byTs.set(c.timestamp, { ...c, filled: c.filled || false });
  }
  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Isi bar hilang dengan flat bar (close sebelumnya) — konservatif untuk backtest.
 */
function fillGaps(candles, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs || !candles?.length) return candles || [];

  const sorted = dedupeAndValidate(candles);
  const out = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const curr = sorted[i];
    let t = prev.timestamp + tfMs;

    while (t < curr.timestamp - tfMs * 0.5) {
      out.push({
        timestamp: t,
        date: new Date(t).toISOString(),
        open: prev.close,
        high: prev.close,
        low: prev.close,
        close: prev.close,
        volume: 0,
        filled: true,
      });
      t += tfMs;
    }
    out.push({ ...curr });
  }
  return out;
}

/**
 * Clamp rentang tanggal ke [effectiveStart, end] dengan batas now & MIN_HISTORICAL.
 */
function clampDateRange({ startMs, endMs, listingMs, autoListing = false }) {
  const now = Date.now();
  let end = Number.isFinite(endMs) ? endMs : now;
  end = Math.min(end, now);

  let start = Number.isFinite(startMs) ? startMs : MIN_HISTORICAL_MS;
  start = Math.max(start, MIN_HISTORICAL_MS);

  if (autoListing && Number.isFinite(listingMs) && listingMs > start) {
    start = listingMs;
  }

  if (start >= end) {
    start = Math.max(MIN_HISTORICAL_MS, end - 30 * 86_400_000);
  }

  return { startMs: start, endMs: end };
}

function estimateBarCount(startMs, endMs, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(1, Math.floor((endMs - startMs) / tfMs));
}

/**
 * Tolak/clamp rentang yang melebihi MAX_BARS.
 * periodId=max → clamp start (bukan error); custom/3m/6m/12m → error jika terlalu besar.
 */
function enforceBarLimit(startMs, endMs, timeframe, periodId) {
  const bars = estimateBarCount(startMs, endMs, timeframe);
  if (bars <= MAX_BARS) {
    return { startMs, endMs, bars, clamped: false };
  }

  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  const maxRangeMs = MAX_BARS * tfMs;
  const clampedStart = Math.max(startMs, endMs - maxRangeMs);
  const clampedBars = estimateBarCount(clampedStart, endMs, timeframe);

  if (String(periodId || "").toLowerCase() === "max") {
    return { startMs: clampedStart, endMs, bars: clampedBars, clamped: true };
  }

  const e = new Error(
    `Rentang terlalu besar (~${bars.toLocaleString("en-US")} bar, maks ${MAX_BARS.toLocaleString("en-US")}). ` +
    "Gunakan timeframe lebih tinggi (mis. 1h/1d) atau periode lebih pendek."
  );
  e.statusCode = 400;
  e.code = "TOO_MANY_BARS";
  e.estimatedBars = bars;
  e.maxBars = MAX_BARS;
  throw e;
}

function periodToRange(periodId, customStart, customEnd) {
  const now = Date.now();
  const day = 86_400_000;

  switch (String(periodId || "").toLowerCase()) {
    case "3m":
      return { startMs: now - 90 * day, endMs: now };
    case "6m":
      return { startMs: now - 180 * day, endMs: now };
    case "12m":
      return { startMs: now - 365 * day, endMs: now };
    case "max":
      return { startMs: MIN_HISTORICAL_MS, endMs: now };
    case "custom": {
      const startMs = customStart ? Date.parse(customStart) : MIN_HISTORICAL_MS;
      const endMs = customEnd ? Date.parse(`${customEnd}T23:59:59.999Z`) : now;
      return { startMs, endMs };
    }
    default:
      return null;
  }
}

function memCacheKey(exchange, symbol, timeframe, startMs, endMs) {
  return `${exchange}:${symbol}:${timeframe}:${startMs}:${endMs}`;
}

function getMemCached(key) {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > MEM_CACHE_TTL_MS) {
    memCache.delete(key);
    return null;
  }
  return hit.data;
}

function setMemCached(key, data) {
  memCache.set(key, { ts: Date.now(), data });
}

async function detectListingTimestamp(exchange, client, marketSymbol, timeframe) {
  try {
    const batch = await withExchangeGate(exchange, () =>
      client.fetchOHLCV(marketSymbol, timeframe, MIN_HISTORICAL_MS, 1)
    );
    const rows = normalizeBatch(batch);
    if (rows.length) return rows[0].timestamp;
  } catch { /* fallback ke MIN_HISTORICAL */ }
  return MIN_HISTORICAL_MS;
}

function findMissingRanges(candles, startMs, endMs, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs) return [{ startMs, endMs }];
  if (!candles?.length) return [{ startMs, endMs }];

  const sorted = dedupeAndValidate(candles);
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

async function fetchPaginated(exchange, client, marketSymbol, timeframe, startMs, endMs, opts = {}) {
  const { onProgress, deadlineMs = Date.now() + FETCH_DEADLINE_MS } = opts;
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs) throw new Error(`Timeframe tidak didukung: ${timeframe}`);

  const byTs = new Map();
  let cursor = startMs;
  const maxIters = Math.ceil((endMs - startMs) / (tfMs * PAGE_SIZE)) + 10;
  let guard = 0;

  while (cursor < endMs && guard++ < maxIters) {
    if (Date.now() > deadlineMs) {
      const e = new Error(
        "Fetch klines melebihi batas waktu. Coba periode lebih pendek, timeframe lebih tinggi, atau ulangi nanti (cache mungkin sudah terisi sebagian)."
      );
      e.statusCode = 504;
      e.code = "KLINES_FETCH_TIMEOUT";
      throw e;
    }
    let batch;
    try {
      batch = await withExchangeGate(exchange, () =>
        client.fetchOHLCV(marketSymbol, timeframe, cursor, PAGE_SIZE)
      );
    } catch (e) {
      await sleep(500);
      try {
        batch = await withExchangeGate(exchange, () =>
          client.fetchOHLCV(marketSymbol, timeframe, cursor, PAGE_SIZE)
        );
      } catch {
        break;
      }
    }

    const rows = normalizeBatch(batch);
    if (!rows.length) break;

    for (const c of rows) {
      if (c.timestamp >= startMs && c.timestamp <= endMs) {
        byTs.set(c.timestamp, c);
      }
    }

    const lastTs = rows[rows.length - 1].timestamp;
    if (!Number.isFinite(lastTs) || lastTs <= cursor) break;
    cursor = lastTs + tfMs;

    if (onProgress) onProgress(byTs.size);
    if (PAUSE_MS) await sleep(PAUSE_MS);
    if (lastTs >= endMs) break;
  }

  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchPaginatedRanges(exchange, client, marketSymbol, timeframe, ranges, opts = {}) {
  const merged = new Map();
  for (const range of ranges) {
    if (range.startMs >= range.endMs) continue;
    const chunk = await fetchPaginated(
      exchange,
      client,
      marketSymbol,
      timeframe,
      range.startMs,
      range.endMs,
      opts
    );
    for (const c of chunk) merged.set(c.timestamp, c);
  }
  return Array.from(merged.values()).sort((a, b) => a.timestamp - b.timestamp);
}

async function loadFromDbCache(exchange, symbol, timeframe, startMs, endMs) {
  try {
    if (typeof db.getCachedCandlesInRange === "function") {
      return await db.getCachedCandlesInRange(exchange, symbol, timeframe, startMs, endMs);
    }
  } catch { /* miss OK */ }
  return null;
}

function coverageRatio(candles, startMs, endMs, timeframe) {
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs || !candles?.length) return 0;
  const expected = Math.max(1, Math.floor((endMs - startMs) / tfMs));
  return candles.length / expected;
}

/**
 * @returns {Promise<{ok,exchange,exchangeLabel,symbol,timeframe,startMs,endMs,listingMs,bars,candles,gapsFilled,cached,source}>}
 */
async function fetchHistoricalKlines(userId, opts = {}) {
  const {
    symbol,
    timeframe = "1d",
    start: startRaw,
    end: endRaw,
    periodId,
    customStart,
    customEnd,
    autoListing = false,
  } = opts;

  const sym = String(symbol || "").toUpperCase().trim();
  if (!sym) {
    const e = new Error("symbol diperlukan");
    e.statusCode = 400;
    throw e;
  }

  const exchange = await getConnectedExchange(userId);
  if (!exchange) {
    const e = new Error("Belum ada exchange yang terhubung. Hubungkan exchange di Settings.");
    e.statusCode = 400;
    e.code = "NO_EXCHANGE_CONNECTED";
    throw e;
  }
  if (!SUPPORTED.has(exchange)) {
    const e = new Error(`Exchange "${exchange}" belum didukung untuk backtest.`);
    e.statusCode = 400;
    e.code = "EXCHANGE_NOT_SUPPORTED";
    throw e;
  }

  let startMs = startRaw ? Date.parse(startRaw) : NaN;
  let endMs = endRaw ? Date.parse(endRaw) : NaN;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    const range = periodToRange(periodId, customStart, customEnd);
    if (!range) {
      const e = new Error("periodId atau start/end diperlukan");
      e.statusCode = 400;
      throw e;
    }
    startMs = range.startMs;
    endMs = range.endMs;
  }

  const client = getPublicClient(exchange);
  const marketSymbol = toMarketSymbol(sym);
  await client.loadMarkets();

  const listingMs = await detectListingTimestamp(exchange, client, marketSymbol, timeframe);
  const clamped = clampDateRange({ startMs, endMs, listingMs, autoListing });
  const barLimit = enforceBarLimit(clamped.startMs, clamped.endMs, timeframe, periodId);
  const effectiveStart = barLimit.startMs;
  const effectiveEnd = barLimit.endMs;

  const cacheKey = memCacheKey(exchange, sym, timeframe, effectiveStart, effectiveEnd);
  const memHit = getMemCached(cacheKey);
  if (memHit) {
    return { ...memHit, cached: true, source: "memory" };
  }

  const deadlineMs = Date.now() + FETCH_DEADLINE_MS;
  let candles = await loadFromDbCache(exchange, sym, timeframe, effectiveStart, effectiveEnd);
  let source = "db";
  const coverage = coverageRatio(candles, effectiveStart, effectiveEnd, timeframe);

  if (!candles?.length || coverage < MIN_CACHE_COVERAGE) {
    const fetchOpts = { deadlineMs };
    if (candles?.length && coverage >= 0.3) {
      const missing = findMissingRanges(candles, effectiveStart, effectiveEnd, timeframe);
      if (missing.length) {
        const fetched = await fetchPaginatedRanges(
          exchange, client, marketSymbol, timeframe, missing, fetchOpts
        );
        const byTs = new Map(candles.map(c => [c.timestamp, c]));
        for (const c of fetched) byTs.set(c.timestamp, c);
        candles = Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
        source = "exchange+db";
      }
    } else {
      candles = await fetchPaginated(
        exchange,
        client,
        marketSymbol,
        timeframe,
        effectiveStart,
        effectiveEnd,
        fetchOpts
      );
      source = "exchange";
    }

    if (candles.length) {
      db.cacheCandles(exchange, sym, timeframe, candles).catch(() => {});
    }
  }

  if (!candles?.length) {
    const e = new Error(`Tidak ada data klines untuk ${sym} (${timeframe}) pada rentang yang diminta.`);
    e.statusCode = 404;
    e.code = "KLINES_NOT_FOUND";
    throw e;
  }

  const gapsBefore = candles.length;
  // Gap-fill mahal pada dataset besar — skip jika >10k bar (backtest tetap valid).
  candles = candles.length > 10_000
    ? dedupeAndValidate(candles)
    : fillGaps(dedupeAndValidate(candles), timeframe);
  const gapsFilled = candles.length - gapsBefore;

  const meta = EXCHANGE_META[exchange] || EXCHANGE_META.bitget;
  const payload = {
    ok: true,
    exchange,
    exchangeLabel: meta.label || meta.name || exchange,
    symbol: sym,
    timeframe,
    startMs: effectiveStart,
    endMs: effectiveEnd,
    startDate: new Date(effectiveStart).toISOString(),
    endDate: new Date(effectiveEnd).toISOString(),
    listingMs,
    listingDate: new Date(listingMs).toISOString(),
    bars: candles.length,
    estimatedBars: barLimit.bars,
    maxBars: MAX_BARS,
    rangeClamped: barLimit.clamped,
    candles,
    gapsFilled: Math.max(0, gapsFilled),
    cached: !String(source).includes("exchange"),
    source,
  };

  setMemCached(cacheKey, payload);
  return payload;
}

async function getDataSourceStatus(userId) {
  const exchange = await getConnectedExchange(userId);
  if (!exchange) {
    return {
      ok: true,
      connected: false,
      exchange: null,
      exchangeLabel: null,
      message: "Belum ada exchange yang terhubung. Backtest real membutuhkan API key di Settings.",
    };
  }
  const meta = EXCHANGE_META[exchange] || EXCHANGE_META.bitget;
  return {
    ok: true,
    connected: true,
    exchange,
    exchangeLabel: meta.label || meta.name || exchange,
    supported: SUPPORTED.has(exchange),
  };
}

function _clearCaches() {
  clientCache.clear();
  memCache.clear();
}

module.exports = {
  fetchHistoricalKlines,
  getDataSourceStatus,
  dedupeAndValidate,
  fillGaps,
  clampDateRange,
  periodToRange,
  estimateBarCount,
  enforceBarLimit,
  findMissingRanges,
  coverageRatio,
  CANDLE_INTERVAL_MS,
  MIN_HISTORICAL_MS,
  MAX_BARS,
  _clearCaches,
};
