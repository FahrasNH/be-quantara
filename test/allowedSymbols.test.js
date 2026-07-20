"use strict";

const assert = require("assert");
const {
  ALLOWED_SYMBOLS,
  normalizeSymbol,
  isAllowedSymbol,
  filterAllowedSymbolStrings,
  filterAllowedSymbolRows,
  symbolNotAllowedError,
} = require("../src/shared/constants/allowedSymbols");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    failed++;
  }
}

console.log("allowedSymbols — platform coin allowlist\n");

test("ALLOWED_SYMBOLS is exactly BTC, ETH, BNB, XRP, SOL", () => {
  assert.deepStrictEqual(ALLOWED_SYMBOLS, [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "SOLUSDT",
  ]);
});

test("normalizeSymbol handles CCXT and raw forms", () => {
  assert.strictEqual(normalizeSymbol("btcusdt"), "BTCUSDT");
  assert.strictEqual(normalizeSymbol("BTC/USDT:USDT"), "BTCUSDT");
  assert.strictEqual(normalizeSymbol("ETH"), "ETHUSDT");
});

test("isAllowedSymbol rejects non-main coins", () => {
  assert.strictEqual(isAllowedSymbol("BTCUSDT"), true);
  assert.strictEqual(isAllowedSymbol("ADAUSDT"), false);
  assert.strictEqual(isAllowedSymbol("1000PEPEUSDT"), false);
});

test("filterAllowedSymbolRows keeps only allowlisted pairs", () => {
  const rows = [
    { symbol: "BTCUSDT", baseAsset: "BTC" },
    { symbol: "ADAUSDT", baseAsset: "ADA" },
    { symbol: "SOLUSDT", baseAsset: "SOL" },
  ];
  assert.deepStrictEqual(
    filterAllowedSymbolRows(rows).map((r) => r.symbol),
    ["BTCUSDT", "SOLUSDT"]
  );
});

test("filterAllowedSymbolStrings preserves canonical order", () => {
  assert.deepStrictEqual(
    filterAllowedSymbolStrings(["SOLUSDT", "DOGEUSDT", "ETHUSDT"]),
    ["ETHUSDT", "SOLUSDT"]
  );
});

test("symbolNotAllowedError returns structured 400 for disallowed", () => {
  assert.strictEqual(symbolNotAllowedError("BTCUSDT"), null);
  const err = symbolNotAllowedError("DOGEUSDT");
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.code, "SYMBOL_NOT_ALLOWED");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
