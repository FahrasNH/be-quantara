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
   * ⚠️ BUG FIX (same class as the Binance naked-position incident): the previous
   * version passed type:"stopMarket" / "takeProfitMarket" — NOT OKX-native CCXT
   * types. OKX SL/TP are algo orders reached via the unified `stopLossPrice` /
   * `takeProfitPrice` PARAM (→ slTriggerPx / tpTriggerPx), see okx.js createOrderRequest.
   * Passing a bogus type risks rejection/mishandling → SL never placed → naked position.
   *
   * Correct approach:
   *   - type:"market" + stopLossPrice|takeProfitPrice → OKX conditional/algo order
   *   - slTriggerPxType|tpTriggerPxType:"mark" → trigger on mark price (anti-manipulation,
   *     avoids a flash-spike on last price firing SL/TP early)
   *   - tdMode:"cross", reduceOnly:true → only reduces the position, never flips it
   *
   * Falls back to the default (last-price) trigger if the mark-price trigger is rejected.
   */
  async setTPSL(symbol, planType, triggerPrice, holdSide, size) {
    const isTP      = planType === "profit_plan";
    const isLong    = holdSide === "long";
    const closeSide = isLong ? "sell" : "buy";
    const marketSymbol = this._marketSymbol(symbol);
    const trigPrice = this._fmtPrice(marketSymbol, triggerPrice);
    // Unified param CCXT maps to OKX slTriggerPx / tpTriggerPx, + its mark-price type.
    const priceKey    = isTP ? "takeProfitPrice"  : "stopLossPrice";
    const trigTypeKey = isTP ? "tpTriggerPxType"  : "slTriggerPxType";
    const errors = [];

    // ── Pendekatan 1: mark price trigger (anti-manipulation) ──────────────────
    try {
      const order = await this.exchange.createOrder(
        marketSymbol,
        "market",
        closeSide,
        size,
        undefined,
        {
          [priceKey]:    trigPrice,
          [trigTypeKey]: "mark",  // OKX triggerPxType: mark price
          tdMode:        "cross",
          reduceOnly:    true,
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
        "market",
        closeSide,
        size,
        undefined,
        {
          [priceKey]: trigPrice,
          tdMode:     "cross",
          reduceOnly: true,
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
   * Extract the 5-digit OKX error code from a CCXT error message.
   * CCXT surfaces the raw OKX payload e.g. `okx {"code":"50111","msg":"..."}`.
   */
  static _okxCode(message) {
    const m = String(message || "");
    const byJson = m.match(/"s?code"\s*:\s*"?(\d{4,5})"?/i);
    if (byJson) return byJson[1];
    const byBare = m.match(/\b(50\d{3}|51\d{3})\b/);
    return byBare ? byBare[1] : null;
  }

  /**
   * Validasi kredensial OKX: wajib passphrase + balance swap dapat diakses.
   * Memberi pesan SPESIFIK per kode error OKX agar user tahu persis penyebabnya.
   */
  async validatePermissions() {
    if (!this.exchange.password) {
      const e = new Error(
        "OKX memerlukan API passphrase. Tambahkan passphrase saat menghubungkan exchange."
      );
      e.statusCode = 400;
      e.code = "OKX_PASSPHRASE_REQUIRED";
      throw e;
    }

    try {
      await this.getBalance("USDT");
      return { ok: true, checked: true };
    } catch (err) {
      const msg  = err.message || "";
      const code = OkxClient._okxCode(msg);

      // Pesan actionable per kode OKX. Inilah yang sebenarnya user butuhkan:
      // tahu PERSIS apa yang salah, bukan tebakan "passphrase salah".
      const HINTS = {
        "50101": "API key ini dibuat di akun DEMO/Demo Trading OKX. Bot trading LIVE butuh API key dari akun LIVE — matikan mode Demo di OKX lalu buat API key baru.",
        "50102": "Jam server tidak sinkron (timestamp expired). Coba lagi; jika berulang, periksa waktu server.",
        "50103": "Header autentikasi kosong — API key tidak terkirim dengan benar.",
        "50104": "API passphrase kosong. Isi passphrase yang Anda buat saat membuat API key OKX.",
        "50105": "API passphrase SALAH. Ini passphrase yang Anda buat SAAT membuat API key OKX — bukan password login, bukan passphrase 'View details'. Jika lupa, buat API key baru.",
        "50111": "API Key salah atau ada spasi/karakter tersembunyi saat paste. Copy ulang API Key dari OKX tanpa spasi.",
        "50112": "API key tidak valid untuk operasi ini.",
        "50113": "Secret Key salah atau ada spasi tersembunyi saat paste (signature gagal). Copy ulang Secret Key dari OKX tanpa spasi.",
        "50114": "Autorisasi tidak valid — periksa kembali API key, secret, dan passphrase.",
        "50110": "IP Anda tidak di-whitelist pada API key OKX. Hapus IP whitelist di pengaturan API key OKX, ATAU whitelist IP server tempat bot berjalan (187.77.135.156).",
      };

      // 50110 = IP whitelist ONLY → key valid, IP saja yang perlu disesuaikan.
      // Jangan gunakan `instanceof PermissionDenied` secara luas — API key dari
      // exchange lain (Bitget/Binance) juga bisa menimbulkan PermissionDenied
      // dengan kode bukan 50110, dan harus ditolak.
      if (code === "50110") {
        return { ok: true, checked: false, warning: HINTS["50110"] || msg };
      }

      const isAuthError =
        err instanceof ccxt.AuthenticationError ||
        err instanceof ccxt.PermissionDenied ||
        (code && /^5[01]\d{3}$/.test(code)) ||  // semua kode OKX 50xxx/51xxx
        /invalid\s*(ok-?access-?)?key|invalid\s*sign|passphrase/i.test(msg);

      if (isAuthError) {
        const e = new Error(
          (code && HINTS[code]) ||
          (code
            ? `Kredensial OKX ditolak (kode: ${code}). Pastikan API key, secret, dan passphrase berasal dari akun OKX — bukan exchange lain (Bitget/Binance). Buat ulang API key di OKX jika perlu.`
            : "API key OKX tidak valid atau API passphrase salah. API passphrase = kata sandi yang Anda BUAT saat membuat API key (bukan password login). Jika lupa, buat API key baru.")
        );
        e.statusCode = 422;
        e.code = code ? `OKX_${code}` : "OKX_VALIDATION_FAILED";
        e.originalMessage = msg;
        throw e;
      }

      // Hanya error TANPA kode OKX (network timeout, dsb.) yang boleh lolos.
      return { ok: true, checked: false, warning: msg };
    }
  }
}

module.exports = OkxClient;
