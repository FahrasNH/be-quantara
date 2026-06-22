/**
 * coinGeckoClient.js  (src/infrastructure/market/coinGeckoClient.js)
 *
 * PAIR-TIER-02 (AC-PAIR-02)
 *
 * Lightweight CoinGecko free-tier wrapper for market cap, 24h volume, and
 * ATR-proxy data. Results are cached in-process for 24 hours to avoid
 * exhausting the 30 req/min free-tier rate limit.
 *
 * Fallback: if CoinGecko is unreachable/slow, caller receives null (graceful
 * degradation — PairClassifier static lookup still works).
 */

'use strict';

const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────
const COINGECKO_BASE  = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;   // 24 hours
const REQUEST_TIMEOUT = 8_000;                  // 8 s timeout

// Map exchange symbol → CoinGecko coin ID (extend as needed)
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

function _getCached(symbol) {
  const entry = _cache.get(symbol);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(symbol); return null; }
  return entry.data;
}

function _setCache(symbol, data) {
  _cache.set(symbol, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function _get(path) {
  return new Promise((resolve, reject) => {
    const url = `${COINGECKO_BASE}${path}`;
    const req = https.get(url, { timeout: REQUEST_TIMEOUT }, (res) => {
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch market data for a symbol from CoinGecko.
 * Returns null on timeout/error (callers must handle gracefully).
 *
 * @param {string} symbol  e.g. "BTCUSDT"
 * @returns {Promise<{marketCap: number, volume24h: number, priceChangePercent24h: number} | null>}
 */
async function getMarketData(symbol) {
  const sym = (symbol || '').toUpperCase();
  const cached = _getCached(sym);
  if (cached) return cached;

  const coinId = SYMBOL_TO_COINGECKO_ID[sym];
  if (!coinId) return null;   // unknown symbol — caller uses static tier

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
      circulatingSupply:     md.circulating_supply          ?? null,
    };

    _setCache(sym, result);
    return result;
  } catch (err) {
    // Non-fatal: log and return null so PairClassifier static table takes over
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
}

/**
 * Return current cache size (for admin/health endpoints).
 */
function getCacheSize() {
  return _cache.size;
}

module.exports = { getMarketData, getMarketDataBatch, clearCache, getCacheSize, SYMBOL_TO_COINGECKO_ID };
