// ─────────────────────────────────────────────────────────────────────────────
// exchangeRateGate.js — global throttle lintas client/koin/user (satu IP server)
//
// OKX ≈ 40 req/2s per IP; multi-strategy × multi-koin tanpa koordinasi memicu
// 50011. CCXT enableRateLimit hanya per-instance → N koin = N antrian paralel.
// Gate ini men-serialisasi panggilan publik per exchange dengan jarak minimum.
// ─────────────────────────────────────────────────────────────────────────────

const RATE_LIMIT_RE = /Too many requests|too frequent|over limit|rate.?limit|ratelimit|\b50011\b|\b30007\b|\b429\b/i;

/** Jarak minimum antar request per exchange (ms). */
const MIN_SPACING_MS = {
  okx:     120,
  binance: 100,
  bitget:  100,
};

const chains = new Map();

function isRateLimitError(err) {
  if (!err) return false;
  const code = err.code ?? err?.response?.data?.code;
  if (code === 50011 || code === "50011" || code === 30007 || code === "30007") return true;
  return RATE_LIMIT_RE.test(String(err.message || ""));
}

/**
 * Jalankan fn setelah menunggu giliran throttle global untuk exchangeId.
 * @param {string} exchangeId — "okx" | "binance" | "bitget" | ...
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withExchangeGate(exchangeId, fn) {
  const id = String(exchangeId || "bitget").toLowerCase();
  const spacing = MIN_SPACING_MS[id] ?? 100;

  const prev = chains.get(id) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => new Promise((r) => setTimeout(r, spacing)))
    .then(() => fn());

  chains.set(id, run.catch(() => {}));
  return run;
}

/** Test-only: reset antrian throttle. */
function _resetGates() {
  chains.clear();
}

module.exports = { withExchangeGate, isRateLimitError, RATE_LIMIT_RE, _resetGates };
