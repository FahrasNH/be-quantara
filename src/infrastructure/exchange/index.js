// ─── src/infrastructure/exchange/index.js ────────────────────────────────────
// Bitget-only exchange factory.
// Menggantikan exchange-factory.js yang sebelumnya mendukung OKX.
// ─────────────────────────────────────────────────────────────────────────────

const BitgetClient = require("./BitgetClient");
const cfg          = require("../../config/env");

/**
 * Buat instance BitgetCCXTClient dengan kredensial dari env.
 * @returns {BitgetClient}
 */
function createExchangeClient() {
  return new BitgetClient(
    cfg.BITGET_API_KEY,
    cfg.BITGET_SECRET_KEY,
    cfg.BITGET_PASSPHRASE
  );
}

/**
 * Info exchange untuk logging / UI.
 */
function getExchangeInfo() {
  return {
    name:   "Bitget",
    id:     "bitget",
    demo:   false,
    symbol: cfg.SYMBOL,
    label:  "Bitget Futures",
  };
}

module.exports = { createExchangeClient, getExchangeInfo };
