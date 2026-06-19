// ─────────────────────────────────────────────────────────────────────────────
// OkxClient.js — OKX USDT-M perpetual swap via CCXT
// ─────────────────────────────────────────────────────────────────────────────

const ccxt = require("ccxt");
const CcxtFuturesClient = require("./CcxtFuturesClient");

class OkxClient extends CcxtFuturesClient {
  constructor(apiKey, secretKey, passphrase = "") {
    super("okx", apiKey, secretKey, passphrase, { defaultType: "swap" });
  }

  /**
   * Robust balance fetch for OKX unified trading account.
   *
   * OKX exposes one unified trading account; `fetchBalance({ type: "swap" })`
   * can fail or come back empty depending on account mode / where funds sit.
   * We try several views so a VALID key is never reported as "invalid" just
   * because one view is blocked or empty. A genuine credential failure (CCXT
   * AuthenticationError) is re-thrown immediately — no point trying other views.
   */
  async getBalance(marginCoin = "USDT") {
    const attempts = [
      () => this.exchange.fetchBalance({ type: "swap" }),
      () => this.exchange.fetchBalance(),
      () => this.exchange.fetchBalance({ type: "trading" }),
    ];
    let lastErr;
    for (const attempt of attempts) {
      try {
        const balance = await attempt();
        const free  = balance?.free?.[marginCoin]  ?? 0;
        const used  = balance?.used?.[marginCoin]  ?? 0;
        const total = balance?.total?.[marginCoin] ?? free + used;
        let unrealizedPL = 0;
        const coin = balance[marginCoin];
        if (coin?.unrealizedPnl != null) unrealizedPL = Number(coin.unrealizedPnl) || 0;
        return { available: free, equity: total, unrealizedPL };
      } catch (err) {
        lastErr = err;
        // Genuine bad credentials → stop early with a typed error.
        if (err instanceof ccxt.AuthenticationError) throw err;
      }
    }
    throw lastErr || new Error("getBalance error: unknown");
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
      // Only HARD-BLOCK on a genuine credential failure. CCXT maps a wrong
      // API key / secret / signature / API-passphrase to AuthenticationError.
      // Everything else (IP whitelist mismatch → PermissionDenied, account
      // mode, funds sitting in the Funding account, transient network errors)
      // must NOT prevent connecting — the key is valid, the user just needs to
      // see the real reason, which the balance card now surfaces.
      const msg = err.message || "";
      const isAuthError =
        err instanceof ccxt.AuthenticationError ||
        /invalid\s*(ok-?access-?)?key|invalid\s*sign|passphrase\s*(incorrect|error)|50113|50111|50105/i.test(msg);

      if (isAuthError) {
        const e = new Error(
          "API key OKX tidak valid atau API passphrase salah. " +
          "Catatan: API passphrase adalah kata sandi yang Anda BUAT saat membuat API key di OKX — " +
          "BUKAN password login dan BUKAN passphrase 'View Detail'. Jika lupa, buat API key baru."
        );
        e.statusCode = 422;
        e.code = "OKX_VALIDATION_FAILED";
        e.originalMessage = msg;
        throw e;
      }

      // Non-auth failure: allow the connection, surface a soft warning.
      return { ok: true, checked: false, warning: msg };
    }
  }
}

module.exports = OkxClient;
