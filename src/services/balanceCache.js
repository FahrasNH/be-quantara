// ─────────────────────────────────────────────────────────────────────────────
// balanceCache.js — per-user authenticated balance reads with short TTL + backoff.
//
// Masalah (OPS-FIX-01): 9 bot × 3 strategi = 27 engine bisa memanggil getBalance()
// hampir bersamaan saat "Start All" → exchange membalas 50011 ("Too many requests").
// Balance gagal terbaca → equity dilaporkan 0 → gate margin START dilewati
// (BUG-FIX-02) sehingga over-allocation lolos. Cache TTL pendek meredam burst (1
// panggilan nyata per user untuk seluruh gelombang start), dan exponential backoff
// menahan retry saat kena rate-limit alih-alih langsung gagal → equity=0 palsu.
//
// CATATAN keamanan: ini membaca balance pakai API KEY user (authenticated), berbeda
// dari ExchangeService.js yang sengaja keyless/public. Sengaja dipisah ke modul ini
// agar ExchangeService tetap murni IDOR-safe. Cache di-key per (userId, exchange).
// ─────────────────────────────────────────────────────────────────────────────

const { createExchangeClient } = require("../infrastructure/exchange");

const cache = new Map(); // `${userId}:${exchangeType}` -> { balance, ts }
const TTL_MS = 5000;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Apakah error ini rate-limit exchange (OKX 50011 / generic "too many requests")? */
function _isRateLimit(err) {
  const code = err?.code ?? err?.response?.code;
  const msg = String(err?.message || err || "");
  return code === 50011 || code === "50011" ||
         /\b50011\b|too many requests|rate.?limit/i.test(msg);
}

/**
 * Baca balance user (cache TTL + backoff). Mengembalikan objek balance exchange
 * ({ equity, available, ... }). Melempar bila gagal setelah retry — caller WAJIB
 * fail-closed (jangan asumsikan equity=0 lalu lanjut).
 *
 * @param {string} userId
 * @param {string} exchangeType            — "okx" | "bitget" | "binance"
 * @param {{apiKey,apiSecret,apiPassphrase}} creds
 * @param {Object} [opts]
 * @param {string}  [opts.coin="USDT"]
 * @param {number}  [opts.ttlMs=5000]
 * @param {number}  [opts.maxRetries=4]
 * @param {number}  [opts.baseDelayMs=150] — delay backoff awal (test pakai kecil)
 * @param {Object}  [opts.client]          — inject client (untuk unit test)
 * @returns {Promise<Object>} balance
 */
async function getCachedBalance(userId, exchangeType, creds, opts = {}) {
  const {
    coin = "USDT", ttlMs = TTL_MS, maxRetries = 4,
    baseDelayMs = 150, client: injected = null,
  } = opts;

  const key = `${userId}:${exchangeType}`;
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.ts) < ttlMs) return hit.balance;

  const client = injected || createExchangeClient(exchangeType, {
    apiKey:        creds?.apiKey,
    apiSecret:     creds?.apiSecret,
    apiPassphrase: creds?.apiPassphrase,
  });

  let delay = baseDelayMs;
  let lastErr;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const balance = await client.getBalance(coin);
      cache.set(key, { balance, ts: Date.now() });
      return balance;
    } catch (err) {
      lastErr = err;
      if (_isRateLimit(err) && i < maxRetries) {
        await _sleep(delay);
        delay *= 2; // 150 → 300 → 600 → 1200ms
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Invalidate cache untuk satu user/exchange, atau seluruhnya bila tanpa argumen. */
function invalidate(userId, exchangeType) {
  if (userId && exchangeType) cache.delete(`${userId}:${exchangeType}`);
  else cache.clear();
}

module.exports = { getCachedBalance, invalidate, _isRateLimit, TTL_MS };
