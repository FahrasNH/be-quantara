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
