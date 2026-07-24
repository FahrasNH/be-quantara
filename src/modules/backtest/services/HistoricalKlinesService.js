/**
 * HistoricalKlinesService — OHLCV historis real dari exchange user (Phase 2 backtest).
 *
 * Flow: query candle_cache → partial hit → fetch gap only → merge → write cache.
 * Paginasi via CCXT fetchOHLCV + exchangeRateGate, cache DB + mem TTL,
 * gap-fill bar hilang, clamp rentang ke 2020-01-01 atau listing date.
 */

"use strict";

const ccxt = require("ccxt");
const db = require("../../../infrastructure/db/database");
const { withExchangeGate } = require("../../../infrastructure/exchange/exchangeRateGate");
const { getConnectedExchange } = require("../../trading/services/ExchangeService");
const { EXCHANGE_META } = require("../../../infrastructure/exchange/index");
const BacktestCandleCache = require("./BacktestCandleCache");

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
/** Batas bar per request — cegah OOM + timeout gateway pada rentang besar (mis. max × 15m).
 *  Default lowered from 500k → 150k (BUG-CRITICAL 502): multi-type AF already stacks
 *  several series; 500k single-fetch was enough to OOM small API hosts. */
const MAX_BARS = Number(process.env.BACKTEST_KLINES_MAX_BARS) || 150_000;
/** Fetch deadline — 15 min covers ~1000 API pages for 500k 1m candles on first load (DB cache after). */
const FETCH_DEADLINE_MS = Number(process.env.BACKTEST_KLINES_FETCH_DEADLINE_MS) || 900_000;
const MIN_CACHE_COVERAGE = 0.85;

const clientCache = new Map();
const memCache = new Map();
const listingCache = new Map();

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
  if (!sym) throw new Error("symbol is required");
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
 * allowClamp=true → selalu clamp (digunakan oleh triple-TF backtest untuk TF pendek).
 */
function enforceBarLimit(startMs, endMs, timeframe, periodId, allowClamp = false) {
  const bars = estimateBarCount(startMs, endMs, timeframe);
  if (bars <= MAX_BARS) {
    return { startMs, endMs, bars, clamped: false };
  }

  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  const maxRangeMs = MAX_BARS * tfMs;
  const clampedStart = Math.max(startMs, endMs - maxRangeMs);
  const clampedBars = estimateBarCount(clampedStart, endMs, timeframe);

  if (String(periodId || "").toLowerCase() === "max" || allowClamp) {
    return { startMs: clampedStart, endMs, bars: clampedBars, clamped: true };
  }

  const e = new Error(
    `Date range too large (~${bars.toLocaleString("en-US")} bars, max ${MAX_BARS.toLocaleString("en-US")}). ` +
    "Use a higher timeframe (e.g. 1h/1d) or a shorter period."
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
  const pid = String(periodId || "").toLowerCase();

  // Handle synthetic periods like "90d", "150d" (generated by getEffectivePeriod)
  const daysMatch = pid.match(/^(\d+)d$/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    return { startMs: now - days * day, endMs: now };
  }

  switch (pid) {
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
  // Cap cache entries — large multi-TF backtests otherwise retain several
  // 30k–60k candle arrays in the API process heap after the job finishes.
  const MAX_MEM_ENTRIES = Number(process.env.BACKTEST_KLINES_MEM_CACHE_ENTRIES) || 4;
  if (memCache.size >= MAX_MEM_ENTRIES) {
    const oldest = memCache.keys().next().value;
    if (oldest !== undefined) memCache.delete(oldest);
  }
  memCache.set(key, { ts: Date.now(), data });
}

async function detectListingTimestamp(exchange, client, marketSymbol, timeframe, sym) {
  const key = `${exchange}:${sym}:${timeframe}`;
  if (listingCache.has(key)) return listingCache.get(key);
  const pooled = BacktestCandleCache.getListingMs(exchange, sym, timeframe);
  if (Number.isFinite(pooled)) {
    listingCache.set(key, pooled);
    return pooled;
  }
  try {
    const batch = await withExchangeGate(exchange, () =>
      client.fetchOHLCV(marketSymbol, timeframe, MIN_HISTORICAL_MS, 1)
    );
    const rows = normalizeBatch(batch);
    if (rows.length) {
      listingCache.set(key, rows[0].timestamp);
      return rows[0].timestamp;
    }
  } catch { /* fallback ke MIN_HISTORICAL */ }
  listingCache.set(key, MIN_HISTORICAL_MS);
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
  const { onProgress, deadlineMs = Date.now() + FETCH_DEADLINE_MS, abortSignal } = opts;
  const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
  if (!tfMs) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const byTs = new Map();
  let cursor = startMs;
  const maxIters = Math.ceil((endMs - startMs) / (tfMs * PAGE_SIZE)) + 10;
  let guard = 0;

  const totalEstimated = Math.ceil((endMs - startMs) / tfMs);

  while (cursor < endMs && guard++ < maxIters) {
    if (abortSignal?.aborted) {
      const e = new Error("Backtest cancelled");
      e.code = "CANCELLED";
      throw e;
    }
    if (Date.now() > deadlineMs) {
      const e = new Error(
        "Candle fetch timed out. Try a shorter period, higher timeframe, or retry (partial cache may already be saved)."
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

    if (onProgress) onProgress(byTs.size, totalEstimated);
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
    const tfMs = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()] || 3_600_000;
    const frontierTs = Date.now() - tfMs * 3;
    if (typeof db.getCachedCandlesInRangeForBacktest === "function") {
      return await db.getCachedCandlesInRangeForBacktest(
        exchange, symbol, timeframe, startMs, endMs, frontierTs
      );
    }
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

/** Shared payload builder for session / DB / memory cache hits. */
function buildKlinesPayload({
  exchange,
  sym,
  timeframe,
  candles,
  startMs,
  endMs,
  listingMs,
  barLimit,
  source,
  cached = true,
}) {
  const validated = dedupeAndValidate(candles);
  const realBars = validated.length;
  const expectedBars = estimateBarCount(startMs, endMs, timeframe);
  const dataCoverage = expectedBars > 0 ? realBars / expectedBars : 1;
  const gapsBefore = validated.length;
  const filled = fillGaps(validated, timeframe);
  const gapsFilled = filled.length - gapsBefore;
  const meta = EXCHANGE_META[exchange] || EXCHANGE_META.bitget;
  return {
    ok: true,
    exchange,
    exchangeLabel: meta.label || meta.name || exchange,
    symbol: sym,
    timeframe,
    startMs,
    endMs,
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    listingMs,
    listingDate: new Date(listingMs).toISOString(),
    bars: filled.length,
    realBars,
    expectedBars,
    coverage: Number(dataCoverage.toFixed(4)),
    estimatedBars: barLimit?.bars,
    maxBars: MAX_BARS,
    rangeClamped: barLimit?.clamped ?? false,
    candles: filled,
    gapsFilled: Math.max(0, gapsFilled),
    cached,
    source,
  };
}

async function tryDbCachePayload(exchange, sym, timeframe, startMs, endMs, listingMs, barLimit) {
  const dbCandles = await loadFromDbCache(exchange, sym, timeframe, startMs, endMs);
  const cov = coverageRatio(dbCandles, startMs, endMs, timeframe);
  if (!dbCandles?.length || cov < MIN_CACHE_COVERAGE) return null;
  BacktestCandleCache.merge(exchange, sym, timeframe, dbCandles, { listingMs });
  return buildKlinesPayload({
    exchange,
    sym,
    timeframe,
    candles: dbCandles,
    startMs,
    endMs,
    listingMs,
    barLimit,
    source: "db",
    cached: true,
  });
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
    allowClamp = false,
    maxBarsOverride,  // per-component cap (e.g. 90k for Scalping 1m)
    warmupBars = 0,   // extend range BACKWARD by N bars (HTF indicator warmup —
                      // EMA50 on 1w needs 50 closed weeks before the eval window;
                      // without it a 12m backtest's Swing HTF layer is dead for
                      // most of the run and fail-closed gates block every entry)
    onProgress,
    abortSignal,
    exchangeType: exchangeTypeOverride, // Advance: public OHLCV from chosen venue
    cacheOnly = false, // skip exchange API — DB/session cache only (offline CLI)
  } = opts;

  const sym = String(symbol || "").toUpperCase().trim();
  if (!sym) {
    const e = new Error("symbol is required");
    e.statusCode = 400;
    throw e;
  }

  const override = String(exchangeTypeOverride || "").toLowerCase().trim();
  let exchange;
  if (override && SUPPORTED.has(override)) {
    // Advance candle-source override — public CCXT, no need to be connected to that venue.
    exchange = override;
  } else {
    exchange = await getConnectedExchange(userId);
    if (!exchange) {
      const e = new Error("No exchange connected. Connect an exchange in Settings.");
      e.statusCode = 400;
      e.code = "NO_EXCHANGE_CONNECTED";
      throw e;
    }
  }
  if (!SUPPORTED.has(exchange)) {
    const e = new Error(`Exchange "${exchange}" is not yet supported for backtesting.`);
    e.statusCode = 400;
    e.code = "EXCHANGE_NOT_SUPPORTED";
    throw e;
  }

  let startMs = startRaw ? Date.parse(startRaw) : NaN;
  let endMs = endRaw ? Date.parse(endRaw) : NaN;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    const range = periodToRange(periodId, customStart, customEnd);
    if (!range) {
      const e = new Error("periodId or start/end date is required");
      e.statusCode = 400;
      throw e;
    }
    startMs = range.startMs;
    endMs = range.endMs;
  }

  if (warmupBars > 0) {
    const tfMsPad = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
    if (tfMsPad) startMs -= warmupBars * tfMsPad;
  }

  const client = getPublicClient(exchange);
  const marketSymbol = toMarketSymbol(sym);

  const preListingMs = BacktestCandleCache.getListingMs(exchange, sym, timeframe) ?? MIN_HISTORICAL_MS;
  const preClamped = clampDateRange({ startMs, endMs, listingMs: preListingMs, autoListing });
  const preBarLimit = enforceBarLimit(preClamped.startMs, preClamped.endMs, timeframe, periodId, allowClamp);
  if (maxBarsOverride && preBarLimit.bars > maxBarsOverride) {
    const tfMs2 = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
    preBarLimit.startMs = Math.max(preBarLimit.startMs, preBarLimit.endMs - maxBarsOverride * tfMs2);
    preBarLimit.clamped = true;
  }

  const preSessionHit = BacktestCandleCache.tryGet(
    exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs
  );
  if (preSessionHit?.hit) {
    const listingMs = BacktestCandleCache.getListingMs(exchange, sym, timeframe) ?? preListingMs;
    const validated = dedupeAndValidate(preSessionHit.candles);
    const realBars = validated.length;
    const expectedBars = estimateBarCount(preBarLimit.startMs, preBarLimit.endMs, timeframe);
    const dataCoverage = expectedBars > 0 ? realBars / expectedBars : 1;
    const gapsBefore = validated.length;
    const candles = fillGaps(validated, timeframe);
    const gapsFilled = candles.length - gapsBefore;
    const meta = EXCHANGE_META[exchange] || EXCHANGE_META.bitget;
    const cacheKey = memCacheKey(exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs);
    const payload = {
      ok: true,
      exchange,
      exchangeLabel: meta.label || meta.name || exchange,
      symbol: sym,
      timeframe,
      startMs: preBarLimit.startMs,
      endMs: preBarLimit.endMs,
      startDate: new Date(preBarLimit.startMs).toISOString(),
      endDate: new Date(preBarLimit.endMs).toISOString(),
      listingMs,
      listingDate: new Date(listingMs).toISOString(),
      bars: candles.length,
      realBars,
      expectedBars,
      coverage: Number(dataCoverage.toFixed(4)),
      estimatedBars: preBarLimit.bars,
      maxBars: MAX_BARS,
      rangeClamped: preBarLimit.clamped,
      candles,
      gapsFilled: Math.max(0, gapsFilled),
      cached: true,
      source: preSessionHit.source,
    };
    setMemCached(cacheKey, payload);
    return payload;
  }

  // DB cache BEFORE loadMarkets — local CLI may be network-blocked while UI/server
  // already populated candle_cache from a prior successful backtest.
  const preDbHit = await tryDbCachePayload(
    exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs, preListingMs, preBarLimit,
  );
  if (preDbHit) {
    setMemCached(
      memCacheKey(exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs),
      preDbHit,
    );
    return preDbHit;
  }

  if (cacheOnly) {
    const e = new Error(
      `No cached klines in DB for ${sym} ${timeframe} (${exchange}, `
      + `${new Date(preBarLimit.startMs).toISOString().slice(0, 10)}–`
      + `${new Date(preBarLimit.endMs).toISOString().slice(0, 10)}). `
      + `Run a UI backtest on the server first (populates candle_cache), or use VPN/network for live fetch.`,
    );
    e.statusCode = 404;
    e.code = "KLINES_CACHE_MISS";
    throw e;
  }

  try {
    await client.loadMarkets();
  } catch (netErr) {
    const offlineDb = await tryDbCachePayload(
      exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs, preListingMs, preBarLimit,
    );
    if (offlineDb) {
      setMemCached(
        memCacheKey(exchange, sym, timeframe, preBarLimit.startMs, preBarLimit.endMs),
        offlineDb,
      );
      return offlineDb;
    }
    const e = new Error(
      `Exchange API unreachable (${exchange}: ${netErr.message}). `
      + `Use VPN/proxy, run on server with network, or populate DB cache via UI backtest + `
      + `DATABASE_URL + --cache-only.`,
    );
    e.statusCode = 503;
    e.code = "EXCHANGE_NETWORK_ERROR";
    e.cause = netErr;
    throw e;
  }

  const listingMs = await detectListingTimestamp(exchange, client, marketSymbol, timeframe, sym);
  const clamped = clampDateRange({ startMs, endMs, listingMs, autoListing });
  const barLimit = enforceBarLimit(clamped.startMs, clamped.endMs, timeframe, periodId, allowClamp);

  // Per-component bar cap: keep only the most recent N bars (Scalping 1m → 90k ≈ 62 days)
  if (maxBarsOverride && barLimit.bars > maxBarsOverride) {
    const tfMs2 = CANDLE_INTERVAL_MS[String(timeframe).toLowerCase()];
    barLimit.startMs = Math.max(barLimit.startMs, barLimit.endMs - maxBarsOverride * tfMs2);
    barLimit.clamped = true;
  }

  const effectiveStart = barLimit.startMs;
  const effectiveEnd = barLimit.endMs;

  const cacheKey = memCacheKey(exchange, sym, timeframe, effectiveStart, effectiveEnd);
  const memHit = getMemCached(cacheKey);
  if (memHit) {
    return { ...memHit, cached: true, source: "memory" };
  }

  const sessionHit = BacktestCandleCache.tryGet(exchange, sym, timeframe, effectiveStart, effectiveEnd);
  if (sessionHit?.hit) {
    const validated = dedupeAndValidate(sessionHit.candles);
    const realBars = validated.length;
    const expectedBars = estimateBarCount(effectiveStart, effectiveEnd, timeframe);
    const dataCoverage = expectedBars > 0 ? realBars / expectedBars : 1;
    const gapsBefore = validated.length;
    const candles = fillGaps(validated, timeframe);
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
      realBars,
      expectedBars,
      coverage: Number(dataCoverage.toFixed(4)),
      estimatedBars: barLimit.bars,
      maxBars: MAX_BARS,
      rangeClamped: barLimit.clamped,
      candles,
      gapsFilled: Math.max(0, gapsFilled),
      cached: true,
      source: sessionHit.source,
    };
    setMemCached(cacheKey, payload);
    return payload;
  }

  const deadlineMs = Date.now() + FETCH_DEADLINE_MS;
  let candles = sessionHit?.partial ? sessionHit.candles : null;
  let source = sessionHit?.partial ? "session-pool+exchange" : null;

  if (!candles?.length) {
    candles = await loadFromDbCache(exchange, sym, timeframe, effectiveStart, effectiveEnd);
    source = "db";
  }
  const coverage = coverageRatio(candles, effectiveStart, effectiveEnd, timeframe);

  if (!candles?.length || coverage < MIN_CACHE_COVERAGE) {
    const fetchOpts = { deadlineMs, onProgress, abortSignal };
    if (candles?.length && coverage >= 0.3) {
      const missing = sessionHit?.missingRanges?.length
        ? sessionHit.missingRanges
        : findMissingRanges(candles, effectiveStart, effectiveEnd, timeframe);
      if (missing.length) {
        const fetched = await fetchPaginatedRanges(
          exchange, client, marketSymbol, timeframe, missing, fetchOpts
        );
        const byTs = new Map((candles || []).map(c => [c.timestamp, c]));
        for (const c of fetched) byTs.set(c.timestamp, c);
        candles = Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
        source = source?.includes("session") ? source : "exchange+db";
        if (!source?.includes("exchange")) source = candles.length && source === "db" ? "exchange+db" : "exchange";
      }
    } else {
      candles = await fetchPaginated(
        exchange, client, marketSymbol, timeframe, effectiveStart, effectiveEnd, fetchOpts
      );
      source = "exchange";
    }

    if (candles.length) {
      db.cacheCandles(exchange, sym, timeframe, candles).catch(() => {});
    }
  } else if (!source) {
    source = "db";
  }

  BacktestCandleCache.merge(exchange, sym, timeframe, candles, { listingMs });

  if (!candles?.length) {
    const e = new Error(`No klines data found for ${sym} (${timeframe}) in the requested range.`);
    e.statusCode = 404;
    e.code = "KLINES_NOT_FOUND";
    throw e;
  }

  const validated = dedupeAndValidate(candles);
  const realBars = validated.length;

  // ── Data coverage (cross-exchange comparability) ──────────────────────────
  // Backtests run per-exchange, and Binance/Bitget/OKX return DIFFERENT amounts
  // of BTC history for the same window (listing depth, rate-limit truncation,
  // exchange downtime). Reasoning happens on ARRAY INDICES that assume uniform
  // time spacing, so unfilled gaps make index-distance ≠ time-distance — which
  // corrupts indicator windows and the sequence-engine freshness score, and does
  // so DIFFERENTLY per exchange. That is the root of the divergence seen across
  // Binance/Bitget/OKX. We therefore ALWAYS gap-fill (flat zero-volume bars keep
  // the index↔time alignment; the strategy ignores them — no volatility, no vol)
  // and surface a coverage ratio so partial data is visible, not silent.
  const expectedBars = estimateBarCount(effectiveStart, effectiveEnd, timeframe);
  const dataCoverage = expectedBars > 0 ? realBars / expectedBars : 1;

  const gapsBefore = candles.length;
  candles = fillGaps(validated, timeframe);
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
    realBars,
    expectedBars,
    coverage: Number(dataCoverage.toFixed(4)),
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
      message: "No exchange connected. Backtest real requires API keys in Settings.",
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
  listingCache.clear();
  BacktestCandleCache.clear();
}

module.exports = {
  fetchHistoricalKlines,
  getDataSourceStatus,
  getPublicClient,
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
  SUPPORTED,
  _clearCaches,
};
