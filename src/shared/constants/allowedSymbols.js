/**
 * Platform allowlist — only these 5 main coins are selectable everywhere
 * (add bot, backtest, market symbols API, etc.). Normalized to *USDT pairs.
 */
const ALLOWED_BASE_ASSETS = ["BTC", "ETH", "BNB", "XRP", "SOL"];

const ALLOWED_SYMBOLS = ALLOWED_BASE_ASSETS.map((b) => `${b}USDT`);

const ALLOWED_SYMBOL_SET = new Set(ALLOWED_SYMBOLS);

/** Normalize "BTC/USDT:USDT", "BTCUSDT", etc. → "BTCUSDT". */
function normalizeSymbol(symbol) {
  const raw = String(symbol || "").toUpperCase().trim();
  if (!raw) return "";
  if (raw.includes("/")) {
    const base = raw.split("/")[0];
    return `${base}USDT`;
  }
  return raw.endsWith("USDT") ? raw : `${raw}USDT`;
}

function isAllowedSymbol(symbol) {
  return ALLOWED_SYMBOL_SET.has(normalizeSymbol(symbol));
}

/** Filter bare symbol strings (e.g. env SYMBOLS_RAW). Preserves allowlist order. */
function filterAllowedSymbolStrings(symbols) {
  const want = new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map(normalizeSymbol)
      .filter(isAllowedSymbol)
  );
  return ALLOWED_SYMBOLS.filter((s) => want.has(s));
}

/** Filter normalized market rows `{ symbol, baseAsset, ... }`. */
function filterAllowedSymbolRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => isAllowedSymbol(r?.symbol ?? r));
}

/** @returns {{status:number, message:string, code:string}|null} */
function symbolNotAllowedError(symbol) {
  if (isAllowedSymbol(symbol)) return null;
  return {
    status: 400,
    message: `Symbol not allowed. Supported: ${ALLOWED_SYMBOLS.join(", ")}`,
    code: "SYMBOL_NOT_ALLOWED",
  };
}

module.exports = {
  ALLOWED_BASE_ASSETS,
  ALLOWED_SYMBOLS,
  ALLOWED_SYMBOL_SET,
  normalizeSymbol,
  isAllowedSymbol,
  filterAllowedSymbolStrings,
  filterAllowedSymbolRows,
  symbolNotAllowedError,
};
