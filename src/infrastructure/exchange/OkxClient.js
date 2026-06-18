// ─────────────────────────────────────────────────────────────────────────────
// OkxClient.js — OKX USDT-M perpetual swap via CCXT
// ─────────────────────────────────────────────────────────────────────────────

const CcxtFuturesClient = require("./CcxtFuturesClient");

class OkxClient extends CcxtFuturesClient {
  constructor(apiKey, secretKey, passphrase = "") {
    super("okx", apiKey, secretKey, passphrase, { defaultType: "swap" });
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
   * Override setTPSL for OKX USDT perpetual swap.
   *
   * CcxtFuturesClient.setTPSL method 1 (MARKET + stopLossPrice) fails for OKX
   * because OKX algo orders use a separate endpoint. Method 2 would work but
   * defaults to "last" price trigger (manipulation risk). This override uses:
   *   - triggerPriceType: "mark"  → trigger on mark price (OKX: triggerPxType)
   *     safer than last price — avoids flash-spike from firing SL/TP early
   *   - tdMode: "cross"           → already in _orderParams() for OKX but
   *     explicitly set here for clarity
   *   - reduceOnly: true          → ensure order only reduces position, no flip
   *
   * Falls back to last-price trigger if mark-price trigger is rejected.
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP      = planType === "profit_plan";
    const isLong    = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const trigPrice = parseFloat(triggerPrice);
    const marketSymbol = this._marketSymbol(symbol);
    const orderType    = isTP ? "takeProfitMarket" : "stopMarket";
    const errors = [];

    // ── Pendekatan 1: mark price trigger (anti-manipulation) ──────────────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        orderType,
        closeSide,
        size,
        trigPrice,
        {
          tdMode:           "cross",
          triggerPrice:     trigPrice,
          triggerPriceType: "mark",  // CCXT unified → OKX triggerPxType: mark
          reduceOnly:       true,
        }
      );
      return { success: true, method: "okxMarkPrice", orderId: order.id };
    } catch (e1) {
      errors.push(`okxMarkPrice: ${e1.message}`);
    }

    // ── Pendekatan 2: last price trigger (fallback) ───────────────────────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        orderType,
        closeSide,
        size,
        trigPrice,
        {
          tdMode:       "cross",
          triggerPrice: trigPrice,
          reduceOnly:   true,
        }
      );
      return { success: true, method: "okxLastPrice", orderId: order.id };
    } catch (e2) {
      errors.push(`okxLastPrice: ${e2.message}`);
    }

    const detail = errors.join(" | ");
    console.warn(`[setTPSL OKX] Semua pendekatan gagal (${planType}): ${detail}`);
    return { success: false, message: detail };
  }

  /**
   * Validasi kredensial OKX: wajib passphrase + balance swap dapat diakses.
   */
  async validatePermissions() {
    if (!this.exchange.password) {
      const e = new Error(
        "OKX memerlukan passphrase API key. Tambahkan passphrase saat menghubungkan exchange."
      );
      e.statusCode = 400;
      e.code = "OKX_PASSPHRASE_REQUIRED";
      throw e;
    }

    try {
      await this.getBalance("USDT");
      return { ok: true, checked: true };
    } catch (err) {
      const e = new Error(
        "API key OKX tidak valid atau passphrase salah. Periksa kembali kredensial dan izin Futures/Trading."
      );
      e.statusCode = 422;
      e.code = "OKX_VALIDATION_FAILED";
      e.originalMessage = err.message;
      throw e;
    }
  }
}

module.exports = OkxClient;
