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
   * ⚠️ BUG FIX (naked-position incident, LAB/USDT live): the previous version passed
   * type:"stopMarket" / "takeProfitMarket" as the CCXT order type. CCXT does NOT
   * recognise those as unified types — it uppercases to "STOPMARKET", which is not in
   * the market's `info.orderTypes`, so Binance rejects with
   *   "binance stopMarket is not a valid order type for the X market".
   * SL/TP then never placed → position ran naked → BotEngine emergency-closed in a
   * loop (5×/6min). See binance.js createOrderRequest: STOP_MARKET / TAKE_PROFIT_MARKET
   * are reached ONLY via the unified `stopLossPrice` / `takeProfitPrice` PARAM on a
   * `market` order (isStopLoss / isTakeProfit), never via a type string.
   *
   * Correct Binance-native approach:
   *   - type:"market" + stopLossPrice|takeProfitPrice → CCXT maps to STOP_MARKET / TAKE_PROFIT_MARKET
   *   - closePosition:true  → close the FULL position on trigger (no quantity → no lot-size mismatch;
   *                           binance.js keeps quantityIsRequired=false when closePosition is set)
   *   - workingType:MARK_PRICE → trigger on mark price (anti-manipulation)
   *   - priceProtect:true   → reject triggers too close to mark price
   *
   * Falls back to explicit size+reduceOnly if closePosition is rejected (e.g. the
   * position was partially filled before the SL is placed).
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP     = planType === "profit_plan";
    const isLong   = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const marketSymbol = this._marketSymbol(symbol);
    const trigPrice = this._fmtPrice(marketSymbol, triggerPrice);
    // The unified param that CCXT translates into STOP_MARKET / TAKE_PROFIT_MARKET.
    const priceKey = isTP ? "takeProfitPrice" : "stopLossPrice";
    const errors = [];

    // ── Pendekatan 1: closePosition (tidak perlu size — paling robust) ────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        undefined,  // no quantity when closePosition=true
        undefined,
        {
          [priceKey]:    trigPrice,
          closePosition: "true",
          workingType:   "MARK_PRICE",
          priceProtect:  "true",
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
        "market",
        closeSide,
        size,
        undefined,
        {
          [priceKey]:  trigPrice,
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
