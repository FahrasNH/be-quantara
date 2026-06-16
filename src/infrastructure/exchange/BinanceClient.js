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
