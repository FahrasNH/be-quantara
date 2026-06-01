// ─────────────────────────────────────────────
// exchange-factory.js
// Pilih exchange client berdasarkan env EXCHANGE.
//
// Cara pakai:
//   const client = require("./exchange-factory");
//   // client sudah siap, tergantung EXCHANGE di .env
//
// EXCHANGE=bitget  → BitgetClient (default)
// EXCHANGE=okx     → OKXClient
// ─────────────────────────────────────────────

require("dotenv").config();

const BitgetClient = require("./bitget");
const OKXClient    = require("./okx");

const EXCHANGE = (process.env.EXCHANGE || "bitget").toLowerCase();

/**
 * Buat instance exchange yang sesuai dengan konfigurasi .env
 * @returns {BitgetClient|OKXClient}
 */
function createExchangeClient() {
  if (EXCHANGE === "okx") {
    const apiKey     = process.env.OKX_API_KEY     || "";
    const secretKey  = process.env.OKX_SECRET_KEY  || "";
    const passphrase = process.env.OKX_PASSPHRASE  || "";
    const demo       = process.env.OKX_DEMO_TRADING !== "false"; // default true (aman)

    return new OKXClient(apiKey, secretKey, passphrase, demo);
  }

  // Default: Bitget
  const apiKey     = process.env.BITGET_API_KEY     || "";
  const secretKey  = process.env.BITGET_SECRET_KEY  || "";
  const passphrase = process.env.BITGET_PASSPHRASE  || "";

  return new BitgetClient(apiKey, secretKey, passphrase);
}

/**
 * Info exchange yang aktif (untuk logging)
 */
function getExchangeInfo() {
  if (EXCHANGE === "okx") {
    const demo = process.env.OKX_DEMO_TRADING !== "false";
    return {
      name:   "OKX",
      id:     "okx",
      demo,
      symbol: process.env.OKX_INST_ID || process.env.SYMBOL || "BTC-USDT-SWAP",
      label:  demo ? "OKX (Demo/Paper Trading)" : "OKX (LIVE)",
    };
  }
  return {
    name:   "Bitget",
    id:     "bitget",
    demo:   false,
    symbol: process.env.SYMBOL || "BTCUSDT",
    label:  "Bitget Futures",
  };
}

module.exports = {
  createExchangeClient,
  getExchangeInfo,
  EXCHANGE,
};
