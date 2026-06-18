// ─────────────────────────────────────────────────────────────────────────────
// ExchangeService.js — cross-exchange market metadata + key validation
//
// Responsibilities (Task A + C):
//   • getPerpetualSymbols(userId) — resolve the user's connected exchange, then
//     return its live USDT-M linear perpetual pairs, normalized to one shape.
//   • validateExchangeKey(exchangeType, creds) — dispatch onboarding validation
//     (Binance: futures-only / no-withdrawal; Bitget: balance reachability).
//
// Symbol listing is PUBLIC market data: it does NOT use the user's API keys.
// userId is used ONLY to look up which exchange the user connected (from their
// own UserExchange record) → IDOR-safe by construction (AC-7). The symbol list
// for a given exchange is identical for every user, so the cache is keyed by
// exchange, not by user — no cross-user data ever flows through it.
// ─────────────────────────────────────────────────────────────────────────────

const ccxt = require("ccxt");
// PrismaClient bersama (satu instance untuk seluruh proses) — lihat prismaClient.js

const prisma = require("../infrastructure/db/prismaClient");

// Supported exchanges for symbol listing (public, keyless CCXT).
const SUPPORTED = new Set(["bitget", "okx", "binance"]);

// CCXT options that select USDT-M linear perpetuals per exchange.
const CCXT_OPTIONS = {
  binance: { defaultType: "future" },
  bitget: { defaultType: "swap", defaultSettle: "USDT" },
  okx: { defaultType: "swap" },
};

// ── Caches ──────────────────────────────────────────────────────────────────
// Keyless CCXT instance per exchange (reused across calls).
const clientCache = new Map(); // exchangeType -> ccxt instance
// Normalized symbol list per exchange with timestamp.
const symbolCache = new Map(); // exchangeType -> { ts, symbols }

const SYMBOL_TTL_MS = 5 * 60 * 1000; // AC-4: 5-minute TTL

function getPublicClient(exchangeType) {
  if (!clientCache.has(exchangeType)) {
    const ctor = ccxt[exchangeType];
    if (!ctor) throw new Error(`Exchange "${exchangeType}" tidak didukung oleh CCXT.`);
    clientCache.set(
      exchangeType,
      new ctor({ enableRateLimit: true, options: CCXT_OPTIONS[exchangeType] || {} })
    );
  }
  return clientCache.get(exchangeType);
}

/** Normalize a CCXT market list → [{symbol, baseAsset, quoteAsset, minQty}]. */
function normalizeMarkets(markets) {
  const out = [];
  for (const m of Object.values(markets)) {
    if (!m.swap || !m.linear) continue;       // linear perpetual only
    if (m.quote !== "USDT") continue;         // USDT-M only (exclude inverse/USDC)
    if (m.active === false) continue;
    out.push({
      symbol: `${m.base}USDT`,
      baseAsset: m.base,
      quoteAsset: m.quote,
      minQty: m.limits?.amount?.min ?? null,
    });
  }
  // De-dup (some exchanges expose the same base twice) + stable sort.
  const seen = new Set();
  const unique = out.filter((s) => (seen.has(s.symbol) ? false : seen.add(s.symbol)));
  unique.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return unique;
}

/**
 * Resolve the exchange the user currently has connected (active record).
 * @returns {Promise<string|null>} exchangeType or null if none connected.
 */
/**
 * Resolve the exchange the user currently has connected (active record).
 * Enforces 1-user-1-exchange: jika ada >1 aktif, simpan yang terbaru saja.
 * @returns {Promise<string|null>} exchangeType or null if none connected.
 */
async function getConnectedExchange(userId) {
  const actives = await prisma.userExchange.findMany({
    where: { userId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: { id: true, exchangeType: true, apiKey: true, apiSecret: true, apiPassphrase: true, apiKeyHash: true },
  });

  if (actives.length > 1) {
    const keeper = actives[0];
    await prisma.userExchange.updateMany({
      where: { userId, deletedAt: null, NOT: { id: keeper.id } },
      data: { deletedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: userId },
      data: {
        apiKey: keeper.apiKey,
        apiSecret: keeper.apiSecret,
        apiPassphrase: keeper.apiPassphrase,
        apiKeyHash: keeper.apiKeyHash,
        exchangeType: keeper.exchangeType,
      },
    });
    return keeper.exchangeType.toLowerCase();
  }

  if (actives.length === 1) {
    const type = actives[0].exchangeType.toLowerCase();
    return type;
  }

  const legacy = await prisma.user.findUnique({
    where: { id: userId },
    select: { exchangeType: true, apiKey: true },
  });
  if (legacy?.apiKey && legacy?.exchangeType) {
    return legacy.exchangeType.toLowerCase();
  }
  return null;
}

/**
 * Return live USDT-M perpetual pairs for the user's connected exchange.
 * @param {string} userId
 * @returns {Promise<{exchange,symbols,cached,stale}>}
 * @throws {Error&{statusCode}} 400 if no exchange connected, 503 if down + no cache
 */
async function getPerpetualSymbols(userId) {
  const exchange = await getConnectedExchange(userId);
  if (!exchange) {
    const e = new Error("Belum ada exchange yang terhubung. Hubungkan exchange di Settings.");
    e.statusCode = 400;
    e.code = "NO_EXCHANGE_CONNECTED";
    throw e;
  }
  if (!SUPPORTED.has(exchange)) {
    const e = new Error(`Exchange "${exchange}" belum didukung untuk daftar simbol.`);
    e.statusCode = 400;
    e.code = "EXCHANGE_NOT_SUPPORTED";
    throw e;
  }

  // ── Cache hit within TTL (AC-4) ──────────────────────────────────────────
  const cached = symbolCache.get(exchange);
  if (cached && Date.now() - cached.ts < SYMBOL_TTL_MS) {
    return { exchange, symbols: cached.symbols, cached: true, stale: false };
  }

  // ── Fresh fetch ──────────────────────────────────────────────────────────
  try {
    const client = getPublicClient(exchange);
    const markets = await client.loadMarkets(true); // reload to pick up new listings
    const symbols = normalizeMarkets(markets);
    if (symbols.length === 0) throw new Error("Empty market list from exchange");
    symbolCache.set(exchange, { ts: Date.now(), symbols });
    return { exchange, symbols, cached: false, stale: false };
  } catch (err) {
    // ── Stale fallback (AC-5): never return empty / never 500 ───────────────
    if (cached?.symbols?.length) {
      return { exchange, symbols: cached.symbols, cached: true, stale: true };
    }
    const e = new Error(`Exchange ${exchange} sedang tidak tersedia. Coba lagi sebentar.`);
    e.statusCode = 503;
    e.code = "EXCHANGE_UNAVAILABLE";
    e.originalMessage = err.message;
    throw e;
  }
}

/**
 * Validate exchange API key permissions at onboarding (Task C).
 * @param {string} exchangeType
 * @param {{apiKey,apiSecret,apiPassphrase?}} creds
 * @returns {Promise<{ok:true, checked:boolean, detail?:object}>}
 * @throws {Error&{statusCode,code}} on disallowed permissions / invalid key
 */
async function validateExchangeKey(exchangeType, { apiKey, apiSecret, apiPassphrase }) {
  const type = (exchangeType || "").toLowerCase();

  if (type === "binance") {
    const BinanceClient = require("../infrastructure/exchange/BinanceClient");
    const client = new BinanceClient(apiKey, apiSecret);
    const detail = await client.validatePermissions(); // throws on bad perms
    return { ok: true, checked: true, detail };
  }

  if (type === "bitget") {
    // Reuse existing reachability check (balance call) — proves key validity.
    const BitgetClient = require("../infrastructure/exchange/BitgetClient");
    try {
      const client = new BitgetClient(apiKey, apiSecret, apiPassphrase);
      await client.getBalance("USDT");
      return { ok: true, checked: true };
    } catch (err) {
      const e = new Error("API key Bitget tidak valid, periksa kembali.");
      e.statusCode = 422;
      e.code = "BITGET_VALIDATION_FAILED";
      e.originalMessage = err.message;
      throw e;
    }
  }

  if (type === "okx") {
    const OkxClient = require("../infrastructure/exchange/OkxClient");
    const client = new OkxClient(apiKey, apiSecret, apiPassphrase);
    const detail = await client.validatePermissions();
    return { ok: true, checked: true, detail };
  }

  // Other exchanges: not validated here (trusted as-is).
  return { ok: true, checked: false };
}

/** Test-only: clear caches so unit tests are deterministic. */
function _clearCaches() {
  clientCache.clear();
  symbolCache.clear();
}

/** Test-only: force all cached symbol lists past their TTL (simulate expiry). */
function _expireCaches() {
  for (const v of symbolCache.values()) v.ts = 0;
}

module.exports = {
  getPerpetualSymbols,
  getConnectedExchange,
  validateExchangeKey,
  normalizeMarkets,
  SUPPORTED,
  SYMBOL_TTL_MS,
  _clearCaches,
  _expireCaches,
};
