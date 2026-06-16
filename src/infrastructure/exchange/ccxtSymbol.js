/** Normalise "BTC/USDT:USDT" or "BTCUSDT" → "BTCUSDT". */
function toRawSymbol(symbol) {
  if (!symbol) return "BTCUSDT";
  if (symbol.includes("/")) return symbol.split("/")[0].toUpperCase() + "USDT";
  return symbol.toUpperCase();
}

/** "BTCUSDT" → "BTC/USDT:USDT" (CCXT unified linear-swap symbol). */
function toCcxtSymbol(symbol) {
  if (!symbol) return "BTC/USDT:USDT";
  if (symbol.includes("/")) return symbol;
  const base = symbol.slice(0, -4);
  return `${base}/USDT:USDT`;
}

module.exports = { toRawSymbol, toCcxtSymbol };
