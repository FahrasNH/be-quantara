// ─────────────────────────────────────────────────────────────────────────────
// BinanceClient.js — Binance USDT-M Futures via CCXT
// ─────────────────────────────────────────────────────────────────────────────

const CcxtFuturesClient = require("./CcxtFuturesClient");
const { toRawSymbol, toCcxtSymbol } = require("./ccxtSymbol");

class BinanceClient extends CcxtFuturesClient {
  constructor(apiKey, secretKey) {
    super("binance", apiKey, secretKey, "", { defaultType: "future" });
  }

  async getPerpetualSymbols() {
    const markets = await this.exchange.loadMarkets();
    const out = [];
    for (const m of Object.values(markets)) {
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

  /**
   * Override setTPSL for Binance USDT-M Futures.
   *
   * CcxtFuturesClient.setTPSL uses generic CCXT params that Binance rejects or
   * misinterprets (unknown triggerPrice param, lot-size precision issues with
   * size+reduceOnly). Binance-native approach:
   *   - closePosition: "true"  → exchange closes the full position when triggered
   *                              (no quantity needed, no lot-size mismatch)
   *   - workingType: MARK_PRICE → triggers on mark price (anti-manipulation)
   *   - priceProtect: "true"   → rejects orders whose trigger is far from mark price
   *
   * Falls back to explicit size+reduceOnly if closePosition is rejected (e.g.
   * position partially filled before SL is placed).
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP     = planType === "profit_plan";
    const isLong   = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const trigPrice = parseFloat(triggerPrice);
    const marketSymbol = this._marketSymbol(symbol);
    const orderType    = isTP ? "takeProfitMarket" : "stopMarket";
    const errors = [];

    // ── Pendekatan 1: closePosition (tidak perlu size — paling robust) ────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        orderType,
        closeSide,
        undefined,  // no quantity when closePosition=true
        trigPrice,
        {
          stopPrice:    trigPrice,
          closePosition: "true",
          workingType:  "MARK_PRICE",
          priceProtect: "true",
        }
      );
      return { success: true, method: "binanceClosePosition", orderId: order.id };
    } catch (e1) {
      errors.push(`binanceClosePosition: ${e1.message}`);
    }

    // ── Pendekatan 2: size + reduceOnly (fallback jika closePosition ditolak) ─
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        orderType,
        closeSide,
        size,
        trigPrice,
        {
          stopPrice:   trigPrice,
          reduceOnly:  true,
          workingType: "MARK_PRICE",
        }
      );
      return { success: true, method: "binanceReduceOnly", orderId: order.id };
    } catch (e2) {
      errors.push(`binanceReduceOnly: ${e2.message}`);
    }

    const detail = errors.join(" | ");
    console.warn(`[setTPSL Binance] Semua pendekatan gagal (${planType}): ${detail}`);
    return { success: false, message: detail };
  }

  async validatePermissions() {
    let restrictions;
    try {
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
