/**
 * signalIdempotency.js  (src/domain/signalIdempotency.js)
 *
 *   Jika WebSocket reconnect atau candle-close event diterima 2x,
 *   BotEngine bisa open 2 positions untuk sinyal yang sama.
 *   Fix: setiap sinyal diberi idempotency key = hash(symbol + strategy + candleTimestamp + direction).
 *   Sinyal yang sama dalam TTL window dibuang.
 *
 * Pattern: In-memory Map dengan TTL. Tidak perlu Redis untuk deployment single-instance.
 * Jika scale multi-instance, ganti dengan Redis SET NX EX (key: signal:{sha1}, TTL 300s).
 */

'use strict';

const crypto = require('crypto');

/** @type {Map<string, number>} key → expiresAt (epoch ms) */
const _seen = new Map();

/** TTL default: 5 menit — cukup panjang untuk cover delay reconnect */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Buat idempotency key dari parameter sinyal.
 * Key di-hash SHA-1 agar deterministic dan compact.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} params.strategy
 * @param {number} params.candleOpenTime   - epoch ms dari open candle yang men-trigger sinyal
 * @param {string} params.direction        - 'LONG' | 'SHORT'
 * @returns {string} hex string (40 chars)
 */
function makeSignalKey({ symbol, strategy, candleOpenTime, direction }) {
  const raw = `${symbol}:${strategy}:${candleOpenTime}:${direction}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * Cek apakah sinyal sudah pernah diproses.
 * Jika belum → catat dan return false (proses sinyal).
 * Jika sudah → return true (buang sinyal, duplicate).
 *
 * @param {Object} signalParams  - sama seperti makeSignalKey
 * @param {number} [ttlMs]       - override TTL
 * @returns {boolean}  true = duplicate, false = baru
 */
function isDuplicate(signalParams, ttlMs = DEFAULT_TTL_MS) {
  // Bersihkan expired entries setiap kali (lazy GC — O(n) tapi infrequent)
  const now = Date.now();
  for (const [k, exp] of _seen) {
    if (exp <= now) _seen.delete(k);
  }

  const key = makeSignalKey(signalParams);

  if (_seen.has(key)) {
    return true; // duplicate
  }

  _seen.set(key, now + ttlMs);
  return false; // baru — proses
}

/**
 * Reset manual — dipakai saat unit test
 */
function _resetForTests() {
  _seen.clear();
}

module.exports = { isDuplicate, makeSignalKey, _resetForTests };
