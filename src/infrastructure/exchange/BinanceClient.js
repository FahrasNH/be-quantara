// ─────────────────────────────────────────────────────────────────────────────
// BinanceClient.js — Binance USDT-M Futures client via CCXT
//
// Scope (Task A + C): market-data + onboarding only —
//   • getPerpetualSymbols()  → list USDT-M linear perpetual pairs (public)
//   • getTicker()            → last price + 24h change
//   • getBalance()           → futures USDT wallet equity
//   • validatePermissions()  → enforce futures-only, reject withdrawal (Task C)
//
// Full trading (openPosition/closePosition/setTPSL) is intentionally NOT here —
// trading via Binance is a separate future task. This client backs the dynamic
// symbol picker and key-onboarding validation only.
// ─────────────────────────────────────────────────────────────────────────────

const ccxt = require("ccxt");

/** Normalise "BTC/USDT:USDT" or "BTCUSDT" → "BTCUSDT". */
function toRawSymbol(symbol) {
  if (!symbol) return "BTCUSDT";
  if (symbol.includes("/")) return symbol.split("/")[0].toUpperCase() + "USDT";
  return symbol.toUpperCase();
}

/** "BTCUSDT" → "BTC/USDT:USDT" (CCXT unified linear-swap symbol). */
function toCcxtSymbol(symbol) {
  if (symbol.includes("/")) return symbol;
  const base = symbol.slice(0, -4);
  return `${base}/USDT:USDT`;
}

class BinanceClient {
  constructor(apiKey, secretKey) {
    this.exchange = new ccxt.binance({
      apiKey,
      secret: secretKey,
      enableRateLimit: true,
      options: {
        defaultType: "future", // USDT-M perpetual (AC-2)
      },
    });
    this.symbol = null;
  }

  // ── MARKET DATA ───────────────────────────────────────────────────────────

  /**
   * List all tradable USDT-M linear perpetual pairs.
   * Public data — works without API keys. Filters out inverse, spot, options,
   * and non-active markets. Returns the normalized cross-exchange shape.
   * @returns {Promise<Array<{symbol,baseAsset,quoteAsset,minQty}>>}
   */
  async getPerpetualSymbols() {
    const markets = await this.exchange.loadMarkets();
    const out = [];
    for (const m of Object.values(markets)) {
      // USDT-M linear perpetual only: swap + linear + quote USDT + active
      if (!m.swap || !m.linear) continue;
      if (m.quote !== "USDT") continue;
      if (m.active === false) continue;
      out.push({
        symbol: `${m.base}USDT`,
        baseAsset: m.base,
        quoteAsset: m.quote,
        minQty: m.limits?.amount?.min ?? null,
      });
    }
    out.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return out;
  }

  async getTicker(symbol) {
    const t = await this.exchange.fetchTicker(toCcxtSymbol(symbol));
    return {
      symbol: toRawSymbol(symbol),
      last: t.last,
      bestBid: t.bid,
      bestAsk: t.ask,
      change24h: t.percentage || 0,
    };
  }

  // ── ACCOUNT ───────────────────────────────────────────────────────────────

  async getBalance(marginCoin = "USDT") {
    try {
      const balance = await this.exchange.fetchBalance({ type: "future" });
      const free = balance?.free?.[marginCoin] ?? 0;
      const used = balance?.used?.[marginCoin] ?? 0;
      const total = balance?.total?.[marginCoin] ?? free + used;
      return { available: free, equity: total, unrealizedPL: 0 };
    } catch (err) {
      throw new Error(`getBalance error: ${err.message}`);
    }
  }

  // ── SECURITY: API key permission validation (Task C) ───────────────────────

  /**
   * Validate that the Binance API key has the CORRECT permission set:
   *   • MUST     have futures enabled
   *   • MUST NOT have withdrawal enabled
   *
   * Uses `GET /sapi/v1/account/apiRestrictions`, which returns explicit
   * permission flags. NOTE: the task originally suggested `GET /fapi/v1/account`,
   * but that endpoint only confirms futures *reading* works — it cannot detect
   * the withdrawal permission. apiRestrictions is the only endpoint that surfaces
   * `enableWithdrawals`, so it is used here to satisfy AC-1 + AC-2 correctly.
   *
   * @returns {Promise<{ ok: true, futures: boolean, withdrawal: boolean }>}
   * @throws {Error & {statusCode:400, code:string}} on disallowed permissions
   */
  async validatePermissions() {
    let restrictions;
    try {
      // CCXT v4: camelCase matches endpoint `account/apiRestrictions`.
      const fetchRestrictions = this.exchange.sapiGetAccountApiRestrictions;
      if (typeof fetchRestrictions !== "function") {
        throw new Error("CCXT Binance SAPI apiRestrictions method unavailable");
      }
      restrictions = await fetchRestrictions.call(this.exchange);
    } catch (err) {
      const hint = err.message?.includes("-2015") || /invalid api-key/i.test(err.message || "")
        ? " Periksa API key/secret dan pastikan IP publik VPS ada di whitelist Binance."
        : "";
      const e = new Error(
        `Tidak bisa memverifikasi izin API key Binance.${hint} Pastikan key valid, Futures aktif, dan IP whitelist benar.`
      );
      e.statusCode = 400;
      e.code = "BINANCE_VALIDATION_FAILED";
      e.originalMessage = err.message;
      throw e;
    }

    // Binance returns string/boolean flags depending on transport — coerce.
    const truthy = (v) => v === true || v === "true" || v === 1 || v === "1";
    const withdrawal = truthy(restrictions?.enableWithdrawals);
    const futures = truthy(restrictions?.enableFutures);

    if (withdrawal) {
      const e = new Error(
        "Withdrawal permission terdeteksi pada API key. Cabut izin withdrawal di pengaturan API Binance sebelum menghubungkan."
      );
      e.statusCode = 400;
      e.code = "WITHDRAWAL_PERMISSION_DETECTED";
      throw e;
    }

    if (!futures) {
      const e = new Error(
        "API key tidak memiliki izin Futures. Aktifkan 'Enable Futures' di pengaturan API Binance."
      );
      e.statusCode = 400;
      e.code = "FUTURES_PERMISSION_MISSING";
      throw e;
    }

    return { ok: true, futures: true, withdrawal: false };
  }
}

module.exports = BinanceClient;
module.exports.toRawSymbol = toRawSymbol;
module.exports.toCcxtSymbol = toCcxtSymbol;
