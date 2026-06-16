// ─── src/infrastructure/exchange/index.js ────────────────────────────────────
// Multi-exchange factory: Bitget, Binance, OKX

const BitgetClient = require("./BitgetClient");
const BinanceClient = require("./BinanceClient");
const OkxClient = require("./OkxClient");
const cfg = require("../../config/env");

const EXCHANGE_META = {
  bitget: {
    name: "Bitget",
    id: "bitget",
    label: "Bitget Futures",
  },
  binance: {
    name: "Binance",
    id: "binance",
    label: "Binance USDT-M Futures",
  },
  okx: {
    name: "OKX",
    id: "okx",
    label: "OKX Perpetual Swap",
  },
};

/**
 * Buat exchange client untuk trading / market data.
 * @param {string} [exchangeType] — "bitget" | "binance" | "okx"
 * @param {{apiKey?,apiSecret?,apiPassphrase?,passphrase?}} [creds]
 * @returns {BitgetClient|BinanceClient|OkxClient}
 */
function createExchangeClient(exchangeType, creds = {}) {
  const type = (exchangeType || "bitget").toLowerCase();
  const apiKey = creds.apiKey ?? "";
  const apiSecret = creds.apiSecret ?? "";
  const passphrase = creds.apiPassphrase || creds.passphrase || "";

  if (type === "binance") {
    return new BinanceClient(apiKey, apiSecret);
  }

  if (type === "okx") {
    return new OkxClient(
      apiKey || "",
      apiSecret || "",
      passphrase
    );
  }

  return new BitgetClient(
    apiKey || cfg.BITGET_API_KEY,
    apiSecret || cfg.BITGET_SECRET_KEY,
    passphrase || cfg.BITGET_PASSPHRASE
  );
}

/**
 * Info exchange untuk logging / UI.
 * @param {string} [exchangeType]
 */
function getExchangeInfo(exchangeType) {
  const type = (exchangeType || "bitget").toLowerCase();
  const meta = EXCHANGE_META[type] || EXCHANGE_META.bitget;
  return {
    ...meta,
    demo: false,
    symbol: cfg.SYMBOL,
  };
}

module.exports = { createExchangeClient, getExchangeInfo, EXCHANGE_META };
