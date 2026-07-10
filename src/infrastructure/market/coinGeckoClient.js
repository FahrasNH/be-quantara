/**
 * coinGeckoClient.js  (src/infrastructure/market/coinGeckoClient.js)
 *
 * PAIR-TIER-02 (AC-PAIR-02) — v2.1 dynamic lookup
 *
 * Lightweight CoinGecko free-tier wrapper for market cap, 24h volume, and
 * rank data. Resolves symbols dynamically via PairClassifier refresh data
 * and search API — no hardcoded coin lists required.
 *
 * Fallback: if CoinGecko is unreachable/slow, caller receives null (graceful
 * degradation — PairClassifier static LIQUID lookup still works).
 */

'use strict';

const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────
const COINGECKO_BASE  = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;   // 24 hours
const REQUEST_TIMEOUT = 8_000;                  // 8 s timeout

// Legacy map for well-known symbols (fast path when refresh not yet run)
const SYMBOL_TO_COINGECKO_ID = {
  BTCUSDT:     'bitcoin',
  ETHUSDT:     'ethereum',
  SOLUSDT:     'solana',
  BNBUSDT:     'binancecoin',
  XRPUSDT:     'ripple',
  ADAUSDT:     'cardano',
  DOGEUSDT:    'dogecoin',
  AVAXUSDT:    'avalanche-2',
  LINKUSDT:    'chainlink',
  DOTUSDT:     'polkadot',
  MATICUSDT:   'matic-network',
  LTCUSDT:     'litecoin',
  SUIUSDT:     'sui',
  WLDUSDT:     'worldcoin-wld',
  HYPEUSDT:    'hyperliquid',
  ENAUSDT:     'ethena',
  INJUSDT:     'injective-protocol',
  ARBUSDT:     'arbitrum',
  OPUSDT:      'optimism',
  TIAUSDT:     'celestia',
  SEIUSDT:     'sei-network',
  JUPUSDT:     'jupiter-exchange-solana',
  RENDERUSDT:  'render-token',
  FETUSDT:     'fetch-ai',
  GMXUSDT:     'gmx',
};

// ─── In-process cache ─────────────────────────────────────────────────────────
const _cache = new Map(); // symbol → { data, expiresAt }
const _searchCache = new Map(); // base → coinId

function _getCached(symbol) {
  const entry = _cache.get(symbol);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(symbol); return null; }
  return entry.data;
}

function _setCache(symbol, data) {
  _cache.set(symbol, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _baseOf(symbol) {
  let s = String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  s = s.replace(/(USDT|USDC|BUSD)$/, '');
  s = s.replace(/^(1000000|100000|10000|1000|1M)/, '');
  return s;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function _get(path) {
  return new Promise((resolve, reject) => {
    const url = `${COINGECKO_BASE}${path}`;
    const req = https.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Quantara-Bot/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('CoinGecko: invalid JSON')); }
      });
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CoinGecko: timeout')); });
  });
}

async function _resolveCoinId(symbol) {
  const sym = (symbol || '').toUpperCase();
  const base = _baseOf(sym);

  // 1. PairClassifier dynamic refresh data (authoritative, real-time)
  try {
    const { pairClassifier } = require('../classification/PairClassifier');
    const cg = pairClassifier.getCoinGeckoMarketData(sym);
    if (cg?.coinId) return cg.coinId;
  } catch { /* noop */ }

  // 2. Legacy static map
  if (SYMBOL_TO_COINGECKO_ID[sym]) return SYMBOL_TO_COINGECKO_ID[sym];

  // 3. Search API (for symbols outside top-250)
  if (_searchCache.has(base)) return _searchCache.get(base);

  try {
    const data = await _get(`/search?query=${encodeURIComponent(base)}`);
    const coins = data?.coins || [];
    const exact = coins.find(c => (c.symbol || '').toUpperCase() === base);
    const coinId = exact?.id || coins[0]?.id || null;
    if (coinId) _searchCache.set(base, coinId);
    return coinId;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch market data for a symbol from CoinGecko.
 * Returns null on timeout/error (callers must handle gracefully).
 *
 * @param {string} symbol  e.g. "BTCUSDT", "HYPEUSDT"
 * @returns {Promise<{marketCap: number, volume24h: number, priceChangePercent24h: number, marketCapRank: number|null} | null>}
 */
async function getMarketData(symbol) {
  const sym = (symbol || '').toUpperCase();
  const cached = _getCached(sym);
  if (cached) return cached;

  // Fast path: use PairClassifier refresh data without extra HTTP call
  try {
    const { pairClassifier } = require('../classification/PairClassifier');
    const cg = pairClassifier.getCoinGeckoMarketData(sym);
    if (cg?.marketCap && cg.volume24h) {
      const result = {
        coinId:                cg.coinId,
        symbol:                sym,
        marketCap:             cg.marketCap,
        volume24h:             cg.volume24h,
        priceChangePercent24h: cg.priceChange24h,
        marketCapRank:         cg.marketCapRank ?? null,
      };
      _setCache(sym, result);
      return result;
    }
  } catch { /* fall through */ }

  const coinId = await _resolveCoinId(sym);
  if (!coinId) return null;

  try {
    const data = await _get(
      `/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`
    );

    const md = data?.market_data;
    if (!md) return null;

    const result = {
      coinId,
      symbol:                sym,
      marketCap:             md.market_cap?.usd            ?? null,
      volume24h:             md.total_volume?.usd           ?? null,
      priceChangePercent24h: md.price_change_percentage_24h ?? null,
      marketCapRank:         data?.market_cap_rank          ?? null,
      circulatingSupply:     md.circulating_supply          ?? null,
    };

    _setCache(sym, result);
    return result;
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[CoinGecko] ${sym}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Batch fetch for multiple symbols. Results are returned as a Map.
 * Missing/failed symbols resolve to null (not thrown).
 *
 * @param {string[]} symbols
 * @returns {Promise<Map<string, Object|null>>}
 */
async function getMarketDataBatch(symbols) {
  const results = await Promise.allSettled(symbols.map(s => getMarketData(s)));
  return new Map(
    symbols.map((s, i) => [
      s.toUpperCase(),
      results[i].status === 'fulfilled' ? results[i].value : null,
    ])
  );
}

/**
 * Clear the in-process cache (useful for tests or forced refresh).
 */
function clearCache() {
  _cache.clear();
  _searchCache.clear();
}

/**
 * Return current cache size (for admin/health endpoints).
 */
function getCacheSize() {
  return _cache.size;
}

module.exports = { getMarketData, getMarketDataBatch, clearCache, getCacheSize, SYMBOL_TO_COINGECKO_ID };
